-- Public-data ingestion fields for the four new scrapers (TX CADs, FL DOR,
-- NC OneMap, generic ArcGIS). Each source uses its own use-code system,
-- so we keep both the raw code and a decoded description plus a county
-- FIPS for cross-source joins and a `data_year` for cuts that publish
-- annual snapshots.

alter table intel_properties
  add column if not exists property_use_code text,
  add column if not exists property_use_desc text,
  add column if not exists county_fips text,
  add column if not exists data_year integer;

-- Indexes to keep /intelligence and downstream agents fast across the
-- new public-data subset. All scoped by source_detail to avoid bloating
-- the global indexes maintained for proptracer rows.

-- TX CADs
create index if not exists intel_properties_tx_hcad_use_idx
  on intel_properties (property_use_code)
  where source_detail = 'tx_cad_hcad' and property_use_code is not null;
create index if not exists intel_properties_tx_dcad_use_idx
  on intel_properties (property_use_code)
  where source_detail = 'tx_cad_dcad' and property_use_code is not null;
create index if not exists intel_properties_tx_tad_use_idx
  on intel_properties (property_use_code)
  where source_detail = 'tx_cad_tad' and property_use_code is not null;

-- FL DOR
create index if not exists intel_properties_fl_dor_use_idx
  on intel_properties (property_use_code)
  where source_detail = 'fl_dor_public' and property_use_code is not null;
create index if not exists intel_properties_fl_dor_county_idx
  on intel_properties (county_fips)
  where source_detail = 'fl_dor_public' and county_fips is not null;

-- NC OneMap
create index if not exists intel_properties_nc_use_idx
  on intel_properties (property_use_code)
  where source_detail = 'nc_onemap_public' and property_use_code is not null;

-- Generic GIS (AR for now; matches future pattern <state>_gis_public)
create index if not exists intel_properties_ar_use_idx
  on intel_properties (property_use_code)
  where source_detail = 'ar_gis_public' and property_use_code is not null;

-- Cross-source: data_year filter for "show me 2025-cut FL data only".
create index if not exists intel_properties_data_year_idx
  on intel_properties (data_year)
  where data_year is not null;
