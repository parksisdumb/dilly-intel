-- Hot fix for the 2026-05-14 timeout report on /intelligence and
-- /intelligence/market ("canceling statement due to statement timeout"
-- even with a state selected).
--
-- The table grew 1.16M -> 1.39M rows after the MS MARIS + TX TxGIO
-- ingests. ANALYZE was current and the source allowlists were untouched,
-- so the *visible* per-state row counts didn't change — but the larger,
-- more physically-scattered heap pushed the already-marginal large-state
-- queries (TX, FL) past the 8s authenticator statement_timeout.
--
-- Root causes found via EXPLAIN ANALYZE against production:
--
--  1. PROPERTIES ROUTE (/api/intelligence/properties)
--     The route filters `street_address IS NOT NULL AND city IS NOT NULL`
--     but no index carried those predicates, so every count query
--     (PostgREST count=exact, plus the corporate/matched stat counts)
--     did a full Bitmap Heap Scan of the whole state partition — ~16,600
--     heap blocks for TX. The count=exact data query was even worse: it
--     could not use the pre-sorted (state, building_sqft) index and fell
--     back to a full scan + Sort of ~200k rows.
--       TX plain count: 14.2s cold.  TX data+count: 7.0s warm.
--     FIX: intel_properties_market_browse_idx — a covering partial index
--     whose predicate includes the NOT NULL filters and whose INCLUDE
--     list carries every column the route's count queries touch. All of
--     those queries become Index Only Scans (0 heap fetches).
--       TX plain count: 14.2s -> 1.0s.  TX data+count: 7.0s -> 0.15s.
--       FL plain count: -> 4.4s.
--
--  2. MARKET ROUTE (/api/intelligence/market + .../portfolios)
--     2a. The RPCs filtered `source_detail IN (SELECT unnest(
--         intel_market_sources()))`. The planner cannot match a subquery
--         against a literal-array partial-index predicate, so it Seq
--         Scanned the entire 1.39M-row table on every call.
--           intel_market_summary('TX'): 15.7s cold.
--         FIX: switch to `source_detail = ANY(intel_market_sources())`.
--         `= ANY(immutable_fn())` folds to a constant array at plan time
--         and matches the partial index — keeps the single-source-of-
--         truth helper while enabling an Index Only Scan.
--           intel_market_summary scan: 15.7s -> 0.6s.
--         New covering index intel_properties_market_agg_idx carries the
--         columns the three market RPCs aggregate over.
--     2b. statement_timeout regression. 20260507000001 set a 60s budget
--         on these RPCs via ALTER FUNCTION ... SET, but the later
--         CREATE OR REPLACE in 20260507000002 (gov-filter removal) wiped
--         proconfig. The `SET LOCAL statement_timeout` left in the body
--         does NOT help: statement_timeout is armed when the outer
--         `SELECT rpc(...)` begins and a mid-statement SET does not
--         re-arm it — so the RPCs were silently back on the 8s
--         authenticator ceiling. FIX: re-apply ALTER FUNCTION ... SET,
--         the only mechanism that actually re-arms the timer on entry.
--
-- NOT addressed here (deliberately — separate, non-urgent change):
--   The new ms_maris_public / tx_txgio_* sources are still excluded from
--   intel_market_sources() and the route allowlists, so the MARIS/TxGIO
--   rows do not yet appear on either page. Wiring them in requires
--   rebuilding every market partial index with the widened source list
--   (or the IN-list becomes a superset of the index predicate and the
--   indexes silently stop being used — re-causing this exact outage).
--   That belongs in its own migration, not an emergency hot fix.
--
-- All statements here are idempotent. The two indexes were already built
-- on production with CREATE INDEX CONCURRENTLY during the incident; the
-- IF NOT EXISTS forms below are no-ops there and build normally on fresh
-- databases. Government filtering stays in JS (route handlers), the
-- hybrid count mode on the properties route is untouched, and no ILIKE
-- substring patterns were moved into SQL.


-- ──────────────────────────────────────────────────────────────────────
-- 1. Properties-route covering index.
--    Key (state, building_sqft DESC NULLS LAST) gives the route's default
--    ordering for free; the partial predicate carries the NOT NULL
--    filters so count queries never touch the heap; INCLUDE carries every
--    column the parallel stat-count queries evaluate (corporate_owned,
--    entity_id, raw_owner_name) plus city (for the `city ILIKE` search
--    filter) and id.
-- ──────────────────────────────────────────────────────────────────────
create index if not exists intel_properties_market_browse_idx
  on intel_properties (state, building_sqft desc nulls last)
  include (id, city, corporate_owned, entity_id, raw_owner_name)
  where source_detail = any(array[
          'proptracer_mapping','fl_dor_public','nc_onemap_public',
          'tx_cad_dcad','tx_cad_tad','tx_cad_hcad'
        ])
    and street_address is not null
    and city is not null;


-- ──────────────────────────────────────────────────────────────────────
-- 2. Market-RPC covering index.
--    Key (state); INCLUDE carries every column the three market
--    aggregation RPCs read, plus the optional city/zip/county filter
--    columns, so a state-scoped market query is a pure Index Only Scan.
-- ──────────────────────────────────────────────────────────────────────
create index if not exists intel_properties_market_agg_idx
  on intel_properties (state)
  include (property_type, corporate_owned, entity_id, raw_owner_name,
           building_sqft, estimated_value, city, postal_code, county)
  where source_detail = any(array[
          'proptracer_mapping','fl_dor_public','nc_onemap_public',
          'tx_cad_dcad','tx_cad_tad','tx_cad_hcad'
        ]);


-- ──────────────────────────────────────────────────────────────────────
-- 2b. Properties-route "last updated" index.
--     The route's lastUpdated query (ORDER BY updated_at DESC LIMIT 1
--     over the filtered set) had no usable index — it Seq Scanned the
--     whole table for FL (8.5s) and heap-scanned the state partition for
--     city-filtered searches (Memphis 6.0s). Key (state, updated_at DESC)
--     makes the state-only case a 1-row index seek; INCLUDE (city) keeps
--     the `city ILIKE` search filter index-only.
-- ──────────────────────────────────────────────────────────────────────
create index if not exists intel_properties_market_updated_idx
  on intel_properties (state, updated_at desc nulls last)
  include (city)
  where source_detail = any(array[
          'proptracer_mapping','fl_dor_public','nc_onemap_public',
          'tx_cad_dcad','tx_cad_tad','tx_cad_hcad'
        ])
    and street_address is not null
    and city is not null;


-- ──────────────────────────────────────────────────────────────────────
-- 2c. Portfolio-clustering covering index (intel_mailing_address_-
--     portfolios / .../market/portfolios).
--     That RPC GROUP BYs on owner_mailing_address and aggregates
--     raw_owner_name / building_sqft / estimated_value. Once section 3
--     made the source filter index-eligible, the planner switched it
--     from a seq scan to an index scan with ~200k random heap fetches —
--     which is *worse* for a near-full-state aggregation (TX 15s -> 24s,
--     FL -> 57s). This covering index, whose partial predicate mirrors
--     the RPC's owner_mailing_address filter exactly, makes it a pure
--     Index Only Scan (TX 24s -> 1.8s).
-- ──────────────────────────────────────────────────────────────────────
create index if not exists intel_properties_portfolios_idx
  on intel_properties (state)
  include (owner_mailing_address, owner_mailing_city, owner_mailing_state,
           owner_mailing_zip, raw_owner_name, building_sqft, estimated_value,
           city, postal_code, county)
  where source_detail = any(array[
          'proptracer_mapping','fl_dor_public','nc_onemap_public',
          'tx_cad_dcad','tx_cad_tad','tx_cad_hcad'
        ])
    and owner_mailing_address is not null
    and length(trim(owner_mailing_address)) > 5;


-- ──────────────────────────────────────────────────────────────────────
-- 3. Market RPCs — switch `source_detail IN (SELECT unnest(...))` to
--    `source_detail = ANY(intel_market_sources())` so the partial index
--    is usable. Bodies are otherwise byte-for-byte the prior definitions.
--    The `set local statement_timeout` lines are kept (harmless, and they
--    do bound any nested statements) but the ALTER FUNCTION calls in
--    section 4 are what actually enforce the 60s budget.
-- ──────────────────────────────────────────────────────────────────────

create or replace function public.intel_market_summary(
  p_city   text default null,
  p_state  text default null,
  p_zip    text default null,
  p_county text default null
) returns table(metric text, bucket text, cnt bigint)
  language plpgsql as $function$
begin
  set local statement_timeout = '60s';

  return query
  with scoped as materialized (
    select p.property_type, p.corporate_owned, p.entity_id, p.raw_owner_name
    from intel_properties p
    where p.source_detail = any(intel_market_sources())
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
  -- Raw counts kept too -- UI uses these to compute the "reliability"
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
$function$;


create or replace function public.intel_owners_concentration(
  p_city            text    default null,
  p_state           text    default null,
  p_zip             text    default null,
  p_min_properties  integer default 2,
  p_limit           integer default 5000,
  p_county          text    default null,
  p_hide_gov        boolean default false
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


create or replace function public.intel_market_concentration(
  p_city     text    default null,
  p_state    text    default null,
  p_zip      text    default null,
  p_top_n    integer default 10,
  p_county   text    default null,
  p_hide_gov boolean default false
) returns table(
  total_market_count   bigint,
  total_owners_count   bigint,
  top_n_property_count bigint,
  top_n_pct            numeric
) language plpgsql as $function$
begin
  set local statement_timeout = '60s';

  return query
  with scoped as materialized (
    select p.raw_owner_name
    from intel_properties p
    where p.source_detail = any(intel_market_sources())
      and p.raw_owner_name is not null
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
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
$function$;


create or replace function public.intel_mailing_address_portfolios(
  p_city           text    default null,
  p_state          text    default null,
  p_zip            text    default null,
  p_county         text    default null,
  p_min_properties integer default 3,
  p_limit          integer default 50
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
-- 4. Re-arm the per-function statement_timeout. This is the proconfig
--    mechanism wiped by 20260507000002's CREATE OR REPLACE — and the
--    only one that actually re-arms the timer when the RPC is entered.
-- ──────────────────────────────────────────────────────────────────────
alter function public.intel_market_summary(text, text, text, text)
  set statement_timeout = '60s';
alter function public.intel_owners_concentration(text, text, text, int, int, text, boolean)
  set statement_timeout = '60s';
alter function public.intel_market_concentration(text, text, text, int, text, boolean)
  set statement_timeout = '60s';
alter function public.intel_mailing_address_portfolios(text, text, text, text, int, int)
  set statement_timeout = '60s';

-- NOTE on work_mem: a per-function `set work_mem = '64MB'` was tested to
-- stop the owner-aggregation RPCs spilling to temp disk (owners_-
-- concentration(FL) 9.0s -> 3.6s in isolation). It was REVERTED: this is
-- a small instance (shared_buffers 224MB, ~1GB RAM) and the market route
-- fires three of these RPCs concurrently — the combined allocation
-- overcommitted memory and made FL *slower* (15s -> 22s) under real
-- parallel load. Speeding up large-state market aggregation needs a
-- right-sized instance or a functional index on the normalized owner key
-- upper(trim(regexp_replace(raw_owner_name,'[^A-Za-z0-9 ]','','g'))) —
-- tracked as a follow-up, not bundled into this hot fix.

grant execute on function public.intel_market_summary(text, text, text, text)                              to service_role;
grant execute on function public.intel_owners_concentration(text, text, text, int, int, text, boolean)      to service_role;
grant execute on function public.intel_market_concentration(text, text, text, int, text, boolean)           to service_role;
grant execute on function public.intel_mailing_address_portfolios(text, text, text, text, int, int)         to service_role;
