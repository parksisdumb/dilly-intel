-- Partial btree index optimized for the geocoder's pending-rows query:
--   WHERE source_detail IN (...) AND latitude IS NULL
--         AND street_address IS NOT NULL AND city IS NOT NULL AND state IS NOT NULL
--   ORDER BY id LIMIT N
--
-- Without this, Postgres has to scan + sort all matching rows across the
-- 1.2M-row table. With it, the index returns rows in id order directly
-- and the geocoder gets sub-second batch fetches.
--
-- Scoped to the source_details we actually backfill (proptracer ships
-- coords; edgar/cms-only entities don't go through this path).

create index if not exists intel_properties_geocode_pending_idx
  on intel_properties (id)
  where latitude is null
    and street_address is not null
    and city is not null
    and state is not null
    and source_detail in (
      'fl_dor_public',
      'nc_onemap_public',
      'tx_cad_dcad',
      'tx_cad_tad',
      'tx_cad_hcad',
      'cms_provider_data'
    );
