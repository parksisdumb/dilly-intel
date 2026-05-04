-- Market-coverage analytical functions for the /intelligence/market page.
-- All scoped to the public-data subset: PropTracer, FL DOR, NC OneMap,
-- DCAD, TAD. PostgREST exposes these as `rpc/<function_name>` callable
-- from the supabase-js client.
--
-- Source-detail allowlist is enumerated here rather than passed in so
-- the RPC always returns consistent cross-source numbers, and clients
-- can't accidentally narrow it.

-- Helper: list of source_details that count toward "real commercial
-- inventory" (excludes EDGAR / CMS provider records which represent a
-- different layer).
create or replace function intel_market_sources()
  returns text[] language sql immutable as $$
  select array['proptracer_mapping','fl_dor_public','nc_onemap_public','tx_cad_dcad','tx_cad_tad','tx_cad_hcad']::text[]
$$;


-- Function 1: ranked owners with property_count, total_sqft, total_value.
-- Powers /api/intelligence/owners and the "Top owners" tables on the
-- market dashboard. NULL filters are no-ops.
create or replace function intel_owners_concentration(
  p_city            text default null,
  p_state           text default null,
  p_zip             text default null,
  p_min_properties  int  default 2,
  p_limit           int  default 100
) returns table (
  raw_owner_name    text,
  entity_id         uuid,
  entity_name       text,
  entity_ticker     text,
  property_count    bigint,
  total_sqft        numeric,
  total_value       numeric,
  avg_sqft          numeric
) language sql stable as $$
  with sources as (select unnest(intel_market_sources()) as src)
  select
    p.raw_owner_name,
    p.entity_id,
    e.name        as entity_name,
    e.ticker      as entity_ticker,
    count(*)      as property_count,
    sum(p.building_sqft)     as total_sqft,
    sum(p.estimated_value)   as total_value,
    avg(p.building_sqft)     as avg_sqft
  from intel_properties p
    left join intel_entities e on e.id = p.entity_id
  where p.source_detail in (select src from sources)
    and p.raw_owner_name is not null
    and (p_city  is null or p.city ilike p_city  || '%')
    and (p_state is null or p.state = p_state)
    and (p_zip   is null or p.postal_code = p_zip)
  group by p.raw_owner_name, p.entity_id, e.name, e.ticker
  having count(*) >= p_min_properties
  order by property_count desc, total_sqft desc nulls last
  limit p_limit;
$$;


-- Function 2: market summary — total count, type breakdown, ownership
-- split. Returns one row per (metric, bucket) pair so the API can pivot
-- it client-side.
create or replace function intel_market_summary(
  p_city  text default null,
  p_state text default null,
  p_zip   text default null
) returns table (
  metric text,
  bucket text,
  cnt    bigint
) language sql stable as $$
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as (
    select p.*
    from intel_properties p
    where p.source_detail in (select src from sources)
      and (p_city  is null or p.city ilike p_city  || '%')
      and (p_state is null or p.state = p_state)
      and (p_zip   is null or p.postal_code = p_zip)
  )
  -- Total
  select 'total'::text, null::text, count(*)::bigint from scoped
  union all
  -- By property_type
  select 'by_type', coalesce(property_type, 'unknown'), count(*)::bigint
    from scoped
    group by property_type
  union all
  -- Ownership split
  select 'ownership',
    case
      when corporate_owned is true  then 'corporate'
      when corporate_owned is false then 'individual'
      else 'unknown'
    end,
    count(*)::bigint
    from scoped
    group by 1, 2
  union all
  -- Portfolio matched (entity_id not null)
  select 'matched',
    case when entity_id is null then 'unmatched' else 'matched' end,
    count(*)::bigint
    from scoped
    group by 2;
$$;


-- Function 3: portfolio concentration — what % of market does the top N
-- owners control? Computed inside Postgres so the page can render a
-- single "top 10 own X%" line without a second client round-trip.
create or replace function intel_market_concentration(
  p_city  text default null,
  p_state text default null,
  p_zip   text default null,
  p_top_n int  default 10
) returns table (
  total_market_count   bigint,
  total_owners_count   bigint,
  top_n_property_count bigint,
  top_n_pct            numeric
) language sql stable as $$
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as (
    select p.raw_owner_name
    from intel_properties p
    where p.source_detail in (select src from sources)
      and p.raw_owner_name is not null
      and (p_city  is null or p.city ilike p_city  || '%')
      and (p_state is null or p.state = p_state)
      and (p_zip   is null or p.postal_code = p_zip)
  ),
  per_owner as (
    select raw_owner_name, count(*) as n
    from scoped
    group by raw_owner_name
  ),
  top_n as (
    select coalesce(sum(n), 0) as cnt
    from (select n from per_owner order by n desc limit p_top_n) t
  ),
  totals as (
    select
      coalesce((select sum(n) from per_owner), 0) as total_count,
      coalesce((select count(*) from per_owner), 0) as owners_count
  )
  select
    totals.total_count                                              as total_market_count,
    totals.owners_count                                             as total_owners_count,
    top_n.cnt                                                       as top_n_property_count,
    case when totals.total_count = 0 then 0
         else round(100.0 * top_n.cnt::numeric / totals.total_count, 2)
    end                                                             as top_n_pct
  from totals, top_n;
$$;


-- Make these callable from the service-role client (PostgREST will
-- auto-expose them after the schema reload).
grant execute on function intel_owners_concentration(text, text, text, int, int) to service_role;
grant execute on function intel_market_summary(text, text, text)                  to service_role;
grant execute on function intel_market_concentration(text, text, text, int)       to service_role;
grant execute on function intel_market_sources()                                  to service_role;

-- Helpful index for the city-prefix filter (used by ilike '<prefix>%').
-- Already exists for proptracer-only via earlier migrations; this version
-- covers the union of all market sources.
create index if not exists intel_properties_market_city_state_idx
  on intel_properties (state, lower(city), source_detail)
  where source_detail in ('proptracer_mapping','fl_dor_public','nc_onemap_public','tx_cad_dcad','tx_cad_tad','tx_cad_hcad');

-- Index for owner GROUP BY across the market sources.
create index if not exists intel_properties_market_owner_idx
  on intel_properties (lower(raw_owner_name))
  where source_detail in ('proptracer_mapping','fl_dor_public','nc_onemap_public','tx_cad_dcad','tx_cad_tad','tx_cad_hcad')
    and raw_owner_name is not null;
