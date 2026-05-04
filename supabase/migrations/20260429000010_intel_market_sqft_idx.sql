-- Unified market-sources building_sqft index. The /intelligence browser
-- now sorts ORDER BY building_sqft DESC across the full market-sources
-- universe (1.2M rows), and the existing proptracer-only sqft index
-- doesn't cover that. Without this, sorted listings hit the 8s
-- statement_timeout on any state-filtered query.
--
-- Predicate matches the route's PROPERTY_SOURCES exactly.

create index if not exists intel_properties_market_sqft_idx
  on intel_properties (building_sqft desc nulls last)
  where source_detail in (
    'proptracer_mapping',
    'fl_dor_public',
    'nc_onemap_public',
    'tx_cad_dcad',
    'tx_cad_tad',
    'tx_cad_hcad'
  )
    and street_address is not null;

-- Help the planner pick rows by (state, source-set) before sorting.
create index if not exists intel_properties_market_state_sqft_idx
  on intel_properties (state, building_sqft desc nulls last)
  where source_detail in (
    'proptracer_mapping',
    'fl_dor_public',
    'nc_onemap_public',
    'tx_cad_dcad',
    'tx_cad_tad',
    'tx_cad_hcad'
  );
