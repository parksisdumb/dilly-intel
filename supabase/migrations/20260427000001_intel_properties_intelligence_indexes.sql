-- Indexes that the /intelligence page relies on for fast filtering and
-- ordering across the full intel_properties dataset (~290k rows from
-- proptracer_mapping). Without these, default-sorted listing queries
-- hit the 8s Supabase statement_timeout.

-- Default order: building_sqft DESC, scoped to PropTracer rows that
-- have street_address (the card-display requirement).
create index if not exists intel_properties_proptracer_sqft_idx
  on intel_properties (building_sqft desc nulls last)
  where source_detail = 'proptracer_mapping' and street_address is not null;

-- For /intelligence stats and filters scoped to (state, sqft).
create index if not exists intel_properties_proptracer_state_sqft_idx
  on intel_properties (state, building_sqft desc nulls last)
  where source_detail = 'proptracer_mapping';

-- For city ilike prefix filter ("nash%") scoped to proptracer rows.
create index if not exists intel_properties_proptracer_city_idx
  on intel_properties (lower(city))
  where source_detail = 'proptracer_mapping' and city is not null;

-- For postal_code exact filter.
create index if not exists intel_properties_proptracer_postal_idx
  on intel_properties (postal_code)
  where source_detail = 'proptracer_mapping' and postal_code is not null;

-- Corporate-owned filter selects on a boolean column — partial index
-- keeps it tight to the proptracer subset.
create index if not exists intel_properties_proptracer_corp_idx
  on intel_properties (corporate_owned)
  where source_detail = 'proptracer_mapping';

-- Portfolio-matched filter (entity_id is not null) — partial index
-- on the matched subset.
create index if not exists intel_properties_proptracer_entity_idx
  on intel_properties (entity_id)
  where source_detail = 'proptracer_mapping' and entity_id is not null;

-- Year-built range filter.
create index if not exists intel_properties_proptracer_year_idx
  on intel_properties (year_built)
  where source_detail = 'proptracer_mapping' and year_built is not null;

-- Recency lookups for the "last updated" indicator.
create index if not exists intel_properties_proptracer_updated_idx
  on intel_properties (updated_at desc)
  where source_detail = 'proptracer_mapping';
