-- Property-type filter for the market dashboard.
--
-- Clicking a property type on /intelligence/market now filters the
-- market view in place (KPIs, ownership, concentration, portfolios all
-- recalculate for that type) instead of navigating away to the property
-- browser. The three aggregation RPCs gain an optional type filter.
--
-- Filter parameters added to each RPC:
--   p_type_patterns text[]  — ILIKE patterns ('%store%', '%shopping%' …)
--                             built by the route from the rollup
--                             category. NULL = no filter.
--   p_type_exclude  boolean — when true, match rows that hit NONE of the
--                             patterns (used for the "Other" rollup
--                             bucket); NULL property_type counts as
--                             "Other".
--
-- The rollup taxonomy stays in TypeScript (src/lib/intel/property-types)
-- — only the resolved ILIKE patterns cross into SQL, so there is no
-- duplicated category logic here.
--
-- Each function changes signature (new params), so the old signature is
-- dropped first — `create or replace` with a different arg count would
-- create an overload and reintroduce PostgREST ambiguity.
--
-- intel_market_concentration is intentionally NOT modified: when a type
-- filter is active the route derives the concentration line from the
-- (type-filtered) summary total + owners list instead of calling it.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Portfolio-clustering covering index — add property_type to INCLUDE.
--    intel_mailing_address_portfolios now reads property_type for the
--    type filter; without it in the covering index the planner would
--    fall back to ~200k random heap fetches on a full-state aggregation
--    (the exact regression migration 20260514000001 fixed). Predicate is
--    the current 11-source list, unchanged from 20260515000001.
-- ──────────────────────────────────────────────────────────────────────
drop index if exists intel_properties_portfolios_idx;
create index if not exists intel_properties_portfolios_idx
  on intel_properties (state)
  include (owner_mailing_address, owner_mailing_city, owner_mailing_state,
           owner_mailing_zip, raw_owner_name, building_sqft, estimated_value,
           city, postal_code, county, property_type)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ])
    and owner_mailing_address is not null
    and length(trim(owner_mailing_address)) > 5;


-- ──────────────────────────────────────────────────────────────────────
-- 2. intel_market_summary — 4-arg → 6-arg with type filter.
--    Also restores `source_detail = any(intel_market_sources())` (the
--    20260519000002 KPI migration regressed it back to the slow
--    `in (select unnest(...))` subquery form, which the planner can't
--    match against the partial index).
-- ──────────────────────────────────────────────────────────────────────
drop function if exists intel_market_summary(text, text, text, text);

create or replace function intel_market_summary(
  p_city          text       default null,
  p_state         text       default null,
  p_zip           text       default null,
  p_county        text       default null,
  p_type_patterns text[]     default null,
  p_type_exclude  boolean    default false
) returns table (
  metric text,
  bucket text,
  cnt    bigint
) language plpgsql as $function$
begin
  set local statement_timeout = '60s';

  return query
  with scoped as materialized (
    select
      p.property_type,
      p.corporate_owned,
      p.entity_id,
      p.raw_owner_name,
      p.building_sqft,
      p.estimated_value,
      p.year_built
    from intel_properties p
    where p.source_detail = any(intel_market_sources())
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
      and (
        p_type_patterns is null
        or (
          coalesce(p_type_exclude, false) = false
          and p.property_type ilike any (p_type_patterns)
        )
        or (
          coalesce(p_type_exclude, false) = true
          and (p.property_type is null
               or not (p.property_type ilike any (p_type_patterns)))
        )
      )
  )
  select 'total'::text, null::text, count(*)::bigint from scoped
  union all
  select 'by_type', coalesce(property_type, 'unknown'), count(*)::bigint
    from scoped group by property_type
  union all
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
    group by 2
  union all
  select 'total_sqft', null::text, coalesce(sum(building_sqft), 0)::bigint
    from scoped
    where building_sqft is not null and building_sqft > 0
  union all
  select 'total_value', null::text, coalesce(sum(estimated_value), 0)::bigint
    from scoped
    where estimated_value is not null and estimated_value > 0
  union all
  select
    'avg_year_built',
    null::text,
    coalesce(round(avg(year_built))::bigint, 0)
    from scoped
    where year_built between 1800 and 2100;
end;
$function$;


-- ──────────────────────────────────────────────────────────────────────
-- 3. intel_owners_concentration — 7-arg → 9-arg with type filter.
-- ──────────────────────────────────────────────────────────────────────
drop function if exists intel_owners_concentration(
  text, text, text, int, int, text, boolean);

create or replace function intel_owners_concentration(
  p_city            text    default null,
  p_state           text    default null,
  p_zip             text    default null,
  p_min_properties  integer default 2,
  p_limit           integer default 5000,
  p_county          text    default null,
  p_hide_gov        boolean default false,
  p_type_patterns   text[]  default null,
  p_type_exclude    boolean default false
) returns table(
  raw_owner_name text,
  entity_id      uuid,
  entity_name    text,
  entity_ticker  text,
  property_count bigint,
  total_sqft     numeric,
  total_value    numeric,
  avg_sqft       numeric
) language plpgsql as $function$
begin
  set local statement_timeout = '60s';

  return query
  with scoped as (
    select p.raw_owner_name as own_name,
           p.entity_id      as own_entity,
           p.building_sqft,
           p.estimated_value
    from intel_properties p
    where p.source_detail = any(intel_market_sources())
      and p.raw_owner_name is not null
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
      and (
        p_type_patterns is null
        or (
          coalesce(p_type_exclude, false) = false
          and p.property_type ilike any (p_type_patterns)
        )
        or (
          coalesce(p_type_exclude, false) = true
          and (p.property_type is null
               or not (p.property_type ilike any (p_type_patterns)))
        )
      )
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
$function$;


-- ──────────────────────────────────────────────────────────────────────
-- 4. intel_mailing_address_portfolios — 6-arg → 8-arg with type filter.
-- ──────────────────────────────────────────────────────────────────────
drop function if exists intel_mailing_address_portfolios(
  text, text, text, text, int, int);

create or replace function intel_mailing_address_portfolios(
  p_city           text    default null,
  p_state          text    default null,
  p_zip            text    default null,
  p_county         text    default null,
  p_min_properties integer default 3,
  p_limit          integer default 50,
  p_type_patterns  text[]  default null,
  p_type_exclude   boolean default false
) returns table(
  owner_mailing_address text,
  owner_mailing_city    text,
  owner_mailing_state   text,
  owner_mailing_zip     text,
  property_count        bigint,
  llc_names             text[],
  total_sqft            numeric,
  total_value           numeric
) language plpgsql as $function$
begin
  set local statement_timeout = '60s';

  return query
  select
    p.owner_mailing_address,
    p.owner_mailing_city,
    p.owner_mailing_state,
    p.owner_mailing_zip,
    count(*)::bigint                                            as property_count,
    array_agg(distinct p.raw_owner_name order by p.raw_owner_name)
      filter (where p.raw_owner_name is not null)               as llc_names,
    sum(p.building_sqft)                                        as total_sqft,
    sum(p.estimated_value)                                      as total_value
  from intel_properties p
  where p.source_detail = any(intel_market_sources())
    and p.owner_mailing_address is not null
    and length(trim(p.owner_mailing_address)) > 5
    and (p_city   is null or p.city ilike p_city  || '%')
    and (p_state  is null or p.state = p_state)
    and (p_zip    is null or p.postal_code = p_zip)
    and (p_county is null or p.county ilike '%' || p_county || '%')
    and (
      p_type_patterns is null
      or (
        coalesce(p_type_exclude, false) = false
        and p.property_type ilike any (p_type_patterns)
      )
      or (
        coalesce(p_type_exclude, false) = true
        and (p.property_type is null
             or not (p.property_type ilike any (p_type_patterns)))
      )
    )
  group by
    p.owner_mailing_address,
    p.owner_mailing_city,
    p.owner_mailing_state,
    p.owner_mailing_zip
  having count(*) >= p_min_properties
  order by count(*) desc
  limit p_limit;
end;
$function$;


-- ──────────────────────────────────────────────────────────────────────
-- 5. Re-arm the per-function statement_timeout (proconfig is per exact
--    signature — the new signatures start with none) and re-grant.
-- ──────────────────────────────────────────────────────────────────────
alter function intel_market_summary(text, text, text, text, text[], boolean)
  set statement_timeout = '60s';
alter function intel_owners_concentration(
  text, text, text, int, int, text, boolean, text[], boolean)
  set statement_timeout = '60s';
alter function intel_mailing_address_portfolios(
  text, text, text, text, int, int, text[], boolean)
  set statement_timeout = '60s';

grant execute on function
  intel_market_summary(text, text, text, text, text[], boolean)
  to service_role;
grant execute on function
  intel_owners_concentration(
    text, text, text, int, int, text, boolean, text[], boolean)
  to service_role;
grant execute on function
  intel_mailing_address_portfolios(
    text, text, text, text, int, int, text[], boolean)
  to service_role;
