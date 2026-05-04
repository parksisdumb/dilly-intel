-- PropTracer scraper fields on intel_properties.
-- Existing columns already cover: county, lat, lng, year_built, parcel_id,
-- assessed_value, sq_footage, owner_name, proptracer_id.
-- Only add what's genuinely new:

alter table intel_properties
  add column if not exists raw_owner_name text,
  add column if not exists lot_size_sqft numeric,
  add column if not exists enrichment_status text default 'unmatched',
  add column if not exists enrichment_level integer default 0,
  add column if not exists needs_assessor_data boolean default true,
  add column if not exists needs_google_places boolean default true;

-- Indexes for query patterns the agent will use
create index if not exists intel_properties_raw_owner_idx
  on intel_properties (lower(raw_owner_name))
  where raw_owner_name is not null;

create index if not exists intel_properties_enrichment_status_idx
  on intel_properties (enrichment_status);
