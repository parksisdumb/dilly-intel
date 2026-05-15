-- Wire the MS MARIS + TX TxGIO ingests into the market dashboard and the
-- property browser.
--
-- Background: 20260514000001 fixed the 2026-05-14 timeout incident but
-- deliberately left ms_maris_public / tx_txgio_* OUT of
-- intel_market_sources() and the route allowlists. Widening the source
-- list without rebuilding the market partial indexes silently disables
-- them: a query whose source-set is a superset of a partial index's
-- predicate cannot use that index. This was verified directly --
-- with the 6-source index dropped, a 6-source `= ANY(array)` query did
-- NOT fall through to an 11-source index, it Bitmap-Heap-Scanned. So the
-- function, the indexes and the JS allowlists all have to move together.
--
-- This migration does the widening properly:
--   1. intel_market_sources() gains the 5 new source_detail values
--      (ms_maris_public, tx_txgio_harris, tx_txgio_bexar, plus
--      tx_txgio_travis and tx_txgio_public which have 0 rows today and
--      are included so the next ingest needs no schema change).
--   2. Every live market partial index is rebuilt with the matching
--      11-source predicate. On production this was done online with
--      CREATE INDEX CONCURRENTLY + DROP INDEX CONCURRENTLY + ALTER INDEX
--      RENAME; the plain DROP/CREATE below is for fresh databases only
--      (this migration is recorded as already-applied on production, so
--      `supabase db push` will not re-run it there).
--   3. Two market indexes that were already dead are dropped, not
--      rebuilt:
--        - intel_properties_market_county_idx (0 scans): the county
--          filter is a leading-wildcard ILIKE, which a plain btree on
--          lower(county) cannot serve.
--        - intel_properties_market_owner_idx (0 scans): the owner
--          GROUP BY normalizes with upper(trim(regexp_replace(...))),
--          not lower(raw_owner_name), so this index never matched.
--   4. ANALYZE so the planner has fresh stats over the ~160k newly
--      visible rows.
--
-- Companion JS change (same change set, MUST deploy together -- a
-- 6-source query cannot use an 11-source partial index):
--   - src/app/api/intelligence/properties/route.ts        PROPERTY_SOURCES
--   - src/app/api/intelligence/properties/export/route.ts PROPERTY_SOURCES
-- The market + portfolios routes have no JS source allowlist; they go
-- through intel_market_sources() and need no code change.
--
-- Government filtering stays in JS. The hybrid count mode on the
-- properties route is untouched. No ILIKE substring patterns moved into
-- SQL. Same partial-index predicate pattern as 20260514000001 -- only
-- the source list is wider.


-- ──────────────────────────────────────────────────────────────────────
-- 1. Widen the source allowlist function.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.intel_market_sources()
  returns text[] language sql immutable as $$
  select array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ]::text[]
$$;
grant execute on function public.intel_market_sources() to service_role;


-- ──────────────────────────────────────────────────────────────────────
-- 2. Drop the two dead market indexes (see header -- not rebuilt).
-- ──────────────────────────────────────────────────────────────────────
drop index if exists intel_properties_market_county_idx;
drop index if exists intel_properties_market_owner_idx;


-- ──────────────────────────────────────────────────────────────────────
-- 3. Rebuild the 8 live market partial indexes with the 11-source
--    predicate. Predicate pattern is identical to the prior versions --
--    only the source array is wider.
-- ──────────────────────────────────────────────────────────────────────

-- 3a. Market-RPC covering index (intel_market_summary / _concentration /
--     _owners_concentration).
drop index if exists intel_properties_market_agg_idx;
create index if not exists intel_properties_market_agg_idx
  on intel_properties (state)
  include (property_type, corporate_owned, entity_id, raw_owner_name,
           building_sqft, estimated_value, city, postal_code, county)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ]);

-- 3b. Properties-route covering index (data query + parallel stat counts).
drop index if exists intel_properties_market_browse_idx;
create index if not exists intel_properties_market_browse_idx
  on intel_properties (state, building_sqft desc nulls last)
  include (id, city, corporate_owned, entity_id, raw_owner_name)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ])
    and street_address is not null
    and city is not null;

-- 3c. Properties-route "last updated" index.
drop index if exists intel_properties_market_updated_idx;
create index if not exists intel_properties_market_updated_idx
  on intel_properties (state, updated_at desc nulls last)
  include (city)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ])
    and street_address is not null
    and city is not null;

-- 3d. Portfolio-clustering covering index (intel_mailing_address_portfolios).
drop index if exists intel_properties_portfolios_idx;
create index if not exists intel_properties_portfolios_idx
  on intel_properties (state)
  include (owner_mailing_address, owner_mailing_city, owner_mailing_state,
           owner_mailing_zip, raw_owner_name, building_sqft, estimated_value,
           city, postal_code, county)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ])
    and owner_mailing_address is not null
    and length(trim(owner_mailing_address)) > 5;

-- 3e. City-prefix / source index (legacy, still scanned).
drop index if exists intel_properties_market_city_state_idx;
create index if not exists intel_properties_market_city_state_idx
  on intel_properties (state, lower(city), source_detail)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ]);

-- 3f. (state, building_sqft) index (legacy, still scanned).
drop index if exists intel_properties_market_state_sqft_idx;
create index if not exists intel_properties_market_state_sqft_idx
  on intel_properties (state, building_sqft desc nulls last)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ]);

-- 3g. building_sqft index (legacy, still scanned).
drop index if exists intel_properties_market_sqft_idx;
create index if not exists intel_properties_market_sqft_idx
  on intel_properties (building_sqft desc nulls last)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ])
    and street_address is not null;

-- 3h. Mailing-address index (legacy, still scanned).
drop index if exists intel_properties_mailing_idx;
create index if not exists intel_properties_mailing_idx
  on intel_properties (state, lower(city), owner_mailing_address)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public'
  ])
    and owner_mailing_address is not null
    and length(trim(owner_mailing_address)) > 5;


-- ──────────────────────────────────────────────────────────────────────
-- 4. Refresh planner statistics over the ~160k newly visible rows.
-- ──────────────────────────────────────────────────────────────────────
analyze intel_properties;
