-- Option-C merge: for parcels present in BOTH PropTracer and Shelby
-- ReGIS, enrich the (fresher) Shelby row with PropTracer's
-- building_sqft / year_built / estimated_value / assessed_value, then
-- delete the now-redundant PropTracer row.
--
-- Join key: normalized parcel_id (strip both spaces AND hyphens).
-- PropTracer ships parcels as `044-050- - -00027` while Shelby ships
-- the same parcel as `044050 00027`. The 2026-05-23 overlap probe
-- confirmed all 10 sample addresses matched once normalized this way.
--
-- Scope: state = 'TN' on both sides. Shelby is Shelby-County only and
-- the Shelby parcel-ID format is county-specific enough that a
-- cross-county collision in PropTracer is extremely unlikely.
--
-- After this migration:
--   - Memphis market total drops from ~43,008 to ~32,200 (the real
--     unique-parcel count).
--   - The ~13,500 formerly-overlapping Shelby rows now carry
--     PropTracer's sqft/year/value while keeping Shelby's owner_name,
--     mailing address, coordinates, and TAXYR-2026 freshness.
--   - The few PropTracer-only TN-Shelby parcels are untouched (no
--     Shelby match exists for them).
--   - PropTracer TN rows outside Shelby County are untouched.
--
-- Implementation note: a previous draft did everything inside one DO
-- block, but DO blocks are a single statement for timeout purposes
-- and the 60s default was canceling the whole transaction after just
-- the first UPDATE finished. Splitting into top-level statements gives
-- each its own statement_timeout window, while the migration's
-- implicit BEGIN/COMMIT still wraps everything in one transaction so
-- atomicity is preserved (and the temp table stays alive across
-- statements).

set statement_timeout = '600s';

-- One-time materialization of the matched (Shelby, PropTracer) pairs.
-- Keyed by Shelby id; PT id is carried for the final DELETE. Running
-- the expensive parcel-id normalization ONCE here turns the 4 UPDATEs
-- and the DELETE into cheap id-keyed lookups.
create temporary table tmp_shelby_pt_overlap on commit drop as
select
  shelby.id              as shelby_id,
  pt.id                  as pt_id,
  pt.building_sqft       as pt_building_sqft,
  pt.year_built          as pt_year_built,
  pt.estimated_value     as pt_estimated_value,
  pt.assessed_value      as pt_assessed_value
from intel_properties shelby
join intel_properties pt
  on  pt.source_detail     = 'proptracer_mapping'
  and pt.state             = 'TN'
  and pt.parcel_id is not null
  and replace(replace(shelby.parcel_id, ' ', ''), '-', '')
    = replace(replace(pt.parcel_id,     ' ', ''), '-', '')
where shelby.source_detail = 'tn_shelby_regis'
  and shelby.state         = 'TN'
  and shelby.parcel_id is not null;

create index on tmp_shelby_pt_overlap(shelby_id);
create index on tmp_shelby_pt_overlap(pt_id);

-- STEP 1a — copy building_sqft (only where Shelby is null AND
-- PropTracer has it).
update intel_properties shelby
set building_sqft = t.pt_building_sqft
from tmp_shelby_pt_overlap t
where shelby.id = t.shelby_id
  and t.pt_building_sqft is not null
  and shelby.building_sqft is null;

-- STEP 1b — copy year_built.
update intel_properties shelby
set year_built = t.pt_year_built
from tmp_shelby_pt_overlap t
where shelby.id = t.shelby_id
  and t.pt_year_built is not null
  and shelby.year_built is null;

-- STEP 1c — copy estimated_value.
update intel_properties shelby
set estimated_value = t.pt_estimated_value
from tmp_shelby_pt_overlap t
where shelby.id = t.shelby_id
  and t.pt_estimated_value is not null
  and shelby.estimated_value is null;

-- STEP 1d — copy assessed_value.
update intel_properties shelby
set assessed_value = t.pt_assessed_value
from tmp_shelby_pt_overlap t
where shelby.id = t.shelby_id
  and t.pt_assessed_value is not null
  and shelby.assessed_value is null;

-- STEP 2 — delete the now-redundant PropTracer rows. ONLY rows with
-- a Shelby match by normalized parcel_id; PropTracer-only TN-Shelby
-- parcels stay.
delete from intel_properties
where id in (select pt_id from tmp_shelby_pt_overlap);

-- STEP 3 — refresh planner stats over the changed rows. ANALYZE is a
-- utility statement and gets its own timeout window.
analyze intel_properties;
