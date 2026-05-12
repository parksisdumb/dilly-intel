-- Index to make intel_mailing_address_portfolios viable on filtered
-- markets. Without this the GROUP BY across owner_mailing_address on a
-- 1.1M-row scan times out even for narrow filters like Memphis-TN
-- because the planner has no path that combines the source/state/city
-- predicates with the mailing-address grouping.
--
-- Partial index restricted to the same sources intel_market_sources()
-- exposes — keeps the index small (~1M rows × ~9 sources only) and
-- ensures Postgres uses it when our RPCs query the same source list.
-- Lower(city) lets the `city ilike 'foo%'` predicate index-seek.

create index if not exists intel_properties_mailing_idx
  on intel_properties (state, lower(city), owner_mailing_address)
  where source_detail in (
          'proptracer_mapping',
          'fl_dor_public',
          'nc_onemap_public',
          'tx_cad_dcad',
          'tx_cad_tad',
          'tx_cad_hcad'
        )
    and owner_mailing_address is not null
    and length(trim(owner_mailing_address)) > 5;

analyze intel_properties;
