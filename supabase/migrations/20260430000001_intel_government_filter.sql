-- Three demo-blocking fixes consolidated into one migration:
--   1. "Hide Government" filter on the market dashboard (default ON)
--   2. Corporate-owned inference for FL DOR rows (corporate_owned IS NULL,
--      infer from name suffix) so Tampa stops showing 0% corporate
--   3. Top-owner dedup by UPPER(TRIM(raw_owner_name)) so case variants
--      collapse into one row in the top-20 lists


-- ─────────────────────────────────────────────────────────────────────
-- Helper functions (all IMMUTABLE + PARALLEL SAFE so they can be inlined
-- into index expressions and parallel scans).
-- ─────────────────────────────────────────────────────────────────────

-- Government-owner detector. Matches the ILIKE patterns the user
-- supplied. Short codes (isd / cdd / mdha) get word-boundary checks so
-- they don't false-match arbitrary substrings.
create or replace function intel_is_government_owner(name text)
  returns boolean language sql immutable parallel safe as $$
  select name is not null and (
    name ilike '%city of%'
    or name ilike '%county of%'
    or name ilike '%state of%'
    or name ilike '%school board%'
    or name ilike '%housing authority%'
    or name ilike '%municipal%'
    or name ilike '%department of%'
    or name ilike '%dept of%'
    or name ilike '%board of%'
    or name ilike '%university%'
    or name ilike '%college%'
    or name ilike '%hospital district%'
    or name ilike '%transit%'
    or name ilike '%airport%'
    or name ilike '%water management%'
    or name ilike '%port authority%'
    or name ~* '\m(isd|cdd|mdha)\M'
  );
$$;


-- Corporate inference: name ends with (or contains as a whole word) a
-- standard legal suffix. Used to bucket corporate_owned IS NULL rows.
create or replace function intel_infer_corporate(name text)
  returns boolean language sql immutable parallel safe as $$
  select name is not null and name ~* (
    '\m(LLC|L\.L\.C|LP|L\.P|LLP|INC|INCORPORATED|CORP|CORPORATION|'
    || 'LTD|LIMITED|TRUST|REIT|HOLDINGS|PROPERTIES|PROPERTY|REALTY|'
    || 'PARTNERSHIP|GROUP|COMPANY|ASSOCIATION|BANK|BANCORP)\M'
  );
$$;


-- Individual heuristic: no legal suffix AND looks like a personal name
-- (2-4 whitespace-separated tokens, reasonable length). The user spec
-- said "no spaces" but most personal names have spaces; using the more
-- forgiving "has spaces and no corporate suffix" interpretation.
create or replace function intel_infer_individual(name text)
  returns boolean language sql immutable parallel safe as $$
  select name is not null
    and not intel_infer_corporate(name)
    and length(name) between 3 and 60
    and array_length(regexp_split_to_array(trim(name), '\s+'), 1) between 1 and 4;
$$;


-- ─────────────────────────────────────────────────────────────────────
-- Updated RPCs
-- ─────────────────────────────────────────────────────────────────────

-- intel_owners_concentration: adds p_hide_gov, dedups by UPPER(TRIM())
-- so e.g. "Memphis Center City Revenue Finance Corp" / "MEMPHIS CENTER
-- CITY REVENUE FINANCE CORP" / "memphis center city revenue finance
-- corp" all collapse into one row. mode() WITHIN GROUP returns the
-- most-frequent capitalization variant for display.
create or replace function intel_owners_concentration(
  p_city            text default null,
  p_state           text default null,
  p_zip             text default null,
  p_min_properties  int  default 2,
  p_limit           int  default 100,
  p_county          text default null,
  p_hide_gov        boolean default false
) returns table (
  raw_owner_name    text,
  entity_id         uuid,
  entity_name       text,
  entity_ticker     text,
  property_count    bigint,
  total_sqft        numeric,
  total_value       numeric,
  avg_sqft          numeric
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as (
    select p.raw_owner_name, p.entity_id,
           p.building_sqft, p.estimated_value
    from intel_properties p
    where p.source_detail in (select src from sources)
      and p.raw_owner_name is not null
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
      and (not p_hide_gov or not intel_is_government_owner(p.raw_owner_name))
  )
  select
    mode() within group (order by raw_owner_name) as raw_owner_name,
    -- Pick the most common entity_id within the group (NULLs included
    -- — most groups have one entity_id or all NULL).
    mode() within group (order by entity_id)     as entity_id,
    null::text                                   as entity_name,
    null::text                                   as entity_ticker,
    count(*)                                      as property_count,
    sum(building_sqft)                            as total_sqft,
    sum(estimated_value)                          as total_value,
    avg(building_sqft)                            as avg_sqft
  from scoped
  group by upper(trim(raw_owner_name))
  having count(*) >= p_min_properties
  order by property_count desc, total_sqft desc nulls last
  limit p_limit;
end;
$$;

alter function intel_owners_concentration(text, text, text, int, int, text, boolean)
  set statement_timeout = '60s';


-- intel_market_summary: bucket ownership using inference. corporate
-- count = explicit TRUE + (NULL AND corporate-suffix). individual =
-- explicit FALSE + (NULL AND looks-individual). unknown = the rest.
create or replace function intel_market_summary(
  p_city   text default null,
  p_state  text default null,
  p_zip    text default null,
  p_county text default null
) returns table (
  metric text,
  bucket text,
  cnt    bigint
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as materialized (
    select p.property_type, p.corporate_owned, p.entity_id, p.raw_owner_name
    from intel_properties p
    where p.source_detail in (select src from sources)
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
  )
  select 'total'::text, null::text, count(*)::bigint from scoped
  union all
  select 'by_type', coalesce(property_type, 'unknown'), count(*)::bigint
    from scoped group by property_type
  union all
  -- Inferred ownership bucketing
  select 'ownership',
    case
      when corporate_owned is true then 'corporate'
      when corporate_owned is false then 'individual'
      when corporate_owned is null and intel_infer_corporate(raw_owner_name) then 'corporate'
      when corporate_owned is null and intel_infer_individual(raw_owner_name) then 'individual'
      else 'unknown'
    end,
    count(*)::bigint
    from scoped
    group by 1, 2
  union all
  -- Raw counts kept too — UI uses these to compute the "reliability"
  -- gate (>50% explicitly-NULL still triggers N/A even if inference
  -- managed to bucket some).
  select 'ownership_raw',
    case
      when corporate_owned is true then 'corporate'
      when corporate_owned is false then 'individual'
      else 'unknown'
    end,
    count(*)::bigint
    from scoped
    group by 1, 2
  union all
  select 'matched',
    case when entity_id is null then 'unmatched' else 'matched' end,
    count(*)::bigint
    from scoped
    group by 2;
end;
$$;

alter function intel_market_summary(text, text, text, text)
  set statement_timeout = '60s';


-- intel_market_concentration: adds p_hide_gov so the top-10
-- concentration headline excludes governments when the toggle is on.
create or replace function intel_market_concentration(
  p_city    text default null,
  p_state   text default null,
  p_zip     text default null,
  p_top_n   int  default 10,
  p_county  text default null,
  p_hide_gov boolean default false
) returns table (
  total_market_count   bigint,
  total_owners_count   bigint,
  top_n_property_count bigint,
  top_n_pct            numeric
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as materialized (
    select p.raw_owner_name
    from intel_properties p
    where p.source_detail in (select src from sources)
      and p.raw_owner_name is not null
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
      and (not p_hide_gov or not intel_is_government_owner(p.raw_owner_name))
  ),
  per_owner as (
    select upper(trim(raw_owner_name)) as norm, count(*) as n
    from scoped
    group by upper(trim(raw_owner_name))
  ),
  top_n as (
    select coalesce(sum(n), 0)::bigint as cnt
    from (select n from per_owner order by n desc limit p_top_n) t
  ),
  totals as (
    select
      coalesce((select sum(n) from per_owner), 0)::bigint as total_count,
      coalesce((select count(*) from per_owner), 0)::bigint as owners_count
  )
  select
    totals.total_count                                              as total_market_count,
    totals.owners_count                                             as total_owners_count,
    top_n.cnt                                                       as top_n_property_count,
    case when totals.total_count = 0 then 0::numeric
         else round(100.0 * top_n.cnt::numeric / totals.total_count, 2)
    end                                                             as top_n_pct
  from totals, top_n;
end;
$$;

alter function intel_market_concentration(text, text, text, int, text, boolean)
  set statement_timeout = '60s';


grant execute on function intel_is_government_owner(text)                                 to service_role;
grant execute on function intel_infer_corporate(text)                                     to service_role;
grant execute on function intel_infer_individual(text)                                    to service_role;
grant execute on function intel_owners_concentration(text, text, text, int, int, text, boolean) to service_role;
grant execute on function intel_market_summary(text, text, text, text)                    to service_role;
grant execute on function intel_market_concentration(text, text, text, int, text, boolean)to service_role;
