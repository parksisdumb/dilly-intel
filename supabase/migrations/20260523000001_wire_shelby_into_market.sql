-- Wire the Shelby County ReGIS ingest (tn_shelby_regis) into the market
-- dashboard and the property browser.
--
-- Same change set / same constraints as 20260515000001 (which wired in
-- MS MARIS + TX TxGIO): the source allowlist function, the partial
-- indexes, and the JS route allowlists must ALL move together — a query
-- whose source-set is a superset of a partial index's predicate cannot
-- use that index and silently Bitmap-Heap-Scans instead.
--
-- This migration:
--   1. intel_market_sources() gains 'tn_shelby_regis' (11 -> 12 sources).
--   2. All 8 live market partial indexes are rebuilt with the matching
--      12-source predicate. Predicate pattern and INCLUDE lists are
--      unchanged from 20260515000001 — except intel_properties_-
--      portfolios_idx, which keeps the property_type INCLUDE column
--      added by 20260522000004 (needed by the market type filter).
--   3. ANALYZE so the planner has fresh stats over the ~37.8k newly
--      visible Shelby rows.
--
-- Index rebuild method: plain DROP/CREATE, same as the 20260515000001
-- file. CREATE INDEX CONCURRENTLY cannot run inside a migration
-- transaction; the brief write-lock during the build is acceptable here
-- because no scraper ingest runs at deploy time (the Shelby ingest
-- completes before this migration is pushed).
--
-- Companion JS change (same change set, MUST deploy together):
--   - properties/route.ts            PROPERTY_SOURCES
--   - properties/export/route.ts     PROPERTY_SOURCES
--   - market/route.ts                MARKET_SOURCES
--   - market/portfolios/route.ts     PROPERTY_SOURCES
--   - portfolios/[id]/route.ts       PROPERTY_SOURCES
--   - portfolios/[id]/export/route.ts PROPERTY_SOURCES
--
-- Government filtering stays in JS. No ILIKE substring patterns moved
-- into SQL.


-- ──────────────────────────────────────────────────────────────────────
-- 1. Widen the source allowlist function: 11 -> 12 sources.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.intel_market_sources()
  returns text[] language sql immutable as $$
  select array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ]::text[]
$$;
grant execute on function public.intel_market_sources() to service_role;


-- ──────────────────────────────────────────────────────────────────────
-- 2. Rebuild the 8 live market partial indexes with the 12-source
--    predicate. Only the source array widens.
-- ──────────────────────────────────────────────────────────────────────

-- 2a. Market-RPC covering index (intel_market_summary / _concentration /
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
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ]);

-- 2b. Properties-route covering index (data query + parallel stat counts).
drop index if exists intel_properties_market_browse_idx;
create index if not exists intel_properties_market_browse_idx
  on intel_properties (state, building_sqft desc nulls last)
  include (id, city, corporate_owned, entity_id, raw_owner_name)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ])
    and street_address is not null
    and city is not null;

-- 2c. Properties-route "last updated" index.
drop index if exists intel_properties_market_updated_idx;
create index if not exists intel_properties_market_updated_idx
  on intel_properties (state, updated_at desc nulls last)
  include (city)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ])
    and street_address is not null
    and city is not null;

-- 2d. Portfolio-clustering covering index (intel_mailing_address_-
--     portfolios). Keeps the property_type INCLUDE column added by
--     20260522000004 for the market type filter.
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
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ])
    and owner_mailing_address is not null
    and length(trim(owner_mailing_address)) > 5;

-- 2e. City-prefix / source index (legacy, still scanned).
drop index if exists intel_properties_market_city_state_idx;
create index if not exists intel_properties_market_city_state_idx
  on intel_properties (state, lower(city), source_detail)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ]);

-- 2f. (state, building_sqft) index (legacy, still scanned).
drop index if exists intel_properties_market_state_sqft_idx;
create index if not exists intel_properties_market_state_sqft_idx
  on intel_properties (state, building_sqft desc nulls last)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ]);

-- 2g. building_sqft index (legacy, still scanned).
drop index if exists intel_properties_market_sqft_idx;
create index if not exists intel_properties_market_sqft_idx
  on intel_properties (building_sqft desc nulls last)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ])
    and street_address is not null;

-- 2h. Mailing-address index (legacy, still scanned).
drop index if exists intel_properties_mailing_idx;
create index if not exists intel_properties_mailing_idx
  on intel_properties (state, lower(city), owner_mailing_address)
  where source_detail = any(array[
    'proptracer_mapping','fl_dor_public','nc_onemap_public',
    'tx_cad_dcad','tx_cad_tad','tx_cad_hcad',
    'ms_maris_public','tx_txgio_harris','tx_txgio_bexar',
    'tx_txgio_travis','tx_txgio_public','tn_shelby_regis'
  ])
    and owner_mailing_address is not null
    and length(trim(owner_mailing_address)) > 5;


-- ──────────────────────────────────────────────────────────────────────
-- 3. Refresh planner statistics over the newly visible Shelby rows.
-- ──────────────────────────────────────────────────────────────────────
analyze intel_properties;
