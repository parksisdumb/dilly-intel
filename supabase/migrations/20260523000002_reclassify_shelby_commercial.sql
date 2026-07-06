-- Re-bucket Shelby ReGIS LANDUSE='COMMERCIAL' rows from
-- property_type='other_commercial' (which the UI rollups as "Other")
-- to property_type='retail' (which rollups as "Retail"). These are
-- strip malls / stores / restaurants / car washes etc. — they belong
-- in Retail/Commercial, not the catch-all Other bucket.
--
-- The intel_ingest classifier (classify_shelby_regis) was updated in
-- the same change set to emit "retail" for LANDUSE='COMMERCIAL'
-- directly, so re-ingests stay consistent.
--
-- NARROW WHERE clause: the bare
--   property_type = 'other_commercial'
-- predicate would also match Shelby INSTITUTIONAL-non-healthcare rows
-- (~3,320 schools / churches / city / county records that the
-- classifier deliberately keeps in "other_commercial"). We filter
-- additionally on property_use_desc LIKE 'Commercial%' — the mapper
-- sets that prefix only for LANDUSE='COMMERCIAL' rows ("Commercial |
-- Zoning: …" or "Commercial").
--
-- Expected affected rows: ~6,707 (the COMMERCIAL LANDUSE count from
-- the 2026-05-22 preview).

update intel_properties
set property_type = 'retail'
where source_detail = 'tn_shelby_regis'
  and property_type = 'other_commercial'
  and (
    property_use_desc = 'Commercial'
    or property_use_desc like 'Commercial |%'
  );
