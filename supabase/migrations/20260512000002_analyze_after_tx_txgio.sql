-- Run after the Texas TxGIO ingests (Harris ~89k, Bexar ~36k —
-- combined ~125k new commercial parcels via the statewide
-- stratmap_land_parcels_48_most_recent ArcGIS REST endpoint).
--
-- Same rationale as the prior ANALYZE migrations: a 100k+ row insert
-- batch makes pg_class.reltuples and per-column histograms drift, and
-- the property-browser /api/intelligence/properties endpoint depends
-- on accurate planner stats for its `count: planned` mode.
--
-- ANALYZE acquires only a SHARE UPDATE EXCLUSIVE lock; safe to push
-- alongside live traffic.

analyze intel_properties;
