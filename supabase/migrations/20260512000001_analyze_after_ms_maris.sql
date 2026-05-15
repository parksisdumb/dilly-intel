-- Run after the Mississippi MARIS bulk ingest (~44.5k commercial parcels
-- across both halves of the statewide cadastral framework) to refresh
-- pg_class.reltuples and the per-column statistics. The planner-based
-- counts in /api/intelligence/properties depend on these being current,
-- and the partial-index selectivity estimates degrade noticeably after
-- a 40k+ batch insert.
--
-- Safe to push at any time: ANALYZE acquires only a SHARE UPDATE
-- EXCLUSIVE lock, doesn't block reads or writes.

analyze intel_properties;
