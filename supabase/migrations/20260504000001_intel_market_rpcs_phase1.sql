-- Phase 1 polish for market intelligence:
--   1. Extend intel_is_government_owner with the additional patterns
--      requested by the audit (SCHOOL on its own, REVENUE FINANCE,
--      ECONOMIC DEV, DEVELOPMENT BOARD, PUBLIC SCHOOL).
--   2. Extend intel_infer_corporate with PARTNERS, ASSOCIATES, VENTURES.
--   3. Strip punctuation in the owner-dedup key so "Dallas, City Of" /
--      "DALLAS CITY OF" / "Dallas. City Of." collapse into one bucket.


-- ─────────────────────────────────────────────────────────────────────
-- 1. Government detector — add the extra patterns. Existing patterns
--    are kept verbatim so prior matches stay matched.
-- ─────────────────────────────────────────────────────────────────────
create or replace function intel_is_government_owner(name text)
  returns boolean language sql immutable parallel safe as $$
  select name is not null and (
    name ilike '%city of%'
    or name ilike '%county of%'
    or name ilike '%state of%'
    or name ilike '%school%'
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
    or name ilike '%water manage%'
    or name ilike '%port authority%'
    or name ilike '%revenue finance%'
    or name ilike '%economic dev%'
    or name ilike '%development board%'
    or name ilike '%public school%'
    or name ~* '\m(isd|cdd|mdha)\M'
  );
$$;


-- ─────────────────────────────────────────────────────────────────────
-- 2. Corporate suffix detector — add PARTNERS / ASSOCIATES / VENTURES.
--    PARTNERSHIP already covered, but PARTNERS (no -ship) wasn't.
-- ─────────────────────────────────────────────────────────────────────
create or replace function intel_infer_corporate(name text)
  returns boolean language sql immutable parallel safe as $$
  select name is not null and name ~* (
    '\m(LLC|L\.L\.C|LP|L\.P|LLP|INC|INCORPORATED|CORP|CORPORATION|'
    || 'LTD|LIMITED|TRUST|REIT|HOLDINGS|PROPERTIES|PROPERTY|REALTY|'
    || 'PARTNERSHIP|PARTNERS|ASSOCIATES|ASSOCIATION|VENTURES|'
    || 'GROUP|COMPANY|BANK|BANCORP)\M'
  );
$$;


-- ─────────────────────────────────────────────────────────────────────
-- 3. Owner-dedup key with punctuation stripped.
--    "Dallas, City Of" / "DALLAS CITY OF" / "Dallas. City Of." now
--    all collapse to "DALLAS CITY OF".
-- ─────────────────────────────────────────────────────────────────────
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
    select p.raw_owner_name as own_name,
           p.entity_id      as own_entity,
           p.building_sqft,
           p.estimated_value
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
    mode() within group (order by scoped.own_name)       as raw_owner_name,
    mode() within group (order by scoped.own_entity)     as entity_id,
    null::text                                            as entity_name,
    null::text                                            as entity_ticker,
    count(*)                                              as property_count,
    sum(scoped.building_sqft)                             as total_sqft,
    sum(scoped.estimated_value)                           as total_value,
    avg(scoped.building_sqft)                             as avg_sqft
  from scoped
  group by upper(trim(regexp_replace(scoped.own_name, '[^A-Za-z0-9 ]', '', 'g')))
  having count(*) >= p_min_properties
  order by property_count desc, total_sqft desc nulls last
  limit p_limit;
end;
$$;

alter function intel_owners_concentration(text, text, text, int, int, text, boolean)
  set statement_timeout = '60s';


-- intel_market_concentration: same dedup key — top-N must be measured
-- against the same canonical buckets the owner table uses.
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
    select upper(trim(regexp_replace(raw_owner_name, '[^A-Za-z0-9 ]', '', 'g'))) as norm,
           count(*) as n
    from scoped
    group by upper(trim(regexp_replace(raw_owner_name, '[^A-Za-z0-9 ]', '', 'g')))
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
grant execute on function intel_owners_concentration(text, text, text, int, int, text, boolean) to service_role;
grant execute on function intel_market_concentration(text, text, text, int, text, boolean)to service_role;
