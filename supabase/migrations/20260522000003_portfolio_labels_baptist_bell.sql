-- Two more curated portfolio labels (intel_portfolio_labels).
--
--   Baptist Memorial Health Care — the Memphis Baptist cluster
--     auto-labels to the generic "Baptist Portfolio" stem. Pin the
--     real health-system name. Matched by the "baptist" owner stem.
--
--   Bell Property Group — a local Memphis investor whose cluster at
--     8545 Cordes Cir auto-labels by address. Matched by mailing
--     address.
--
-- Both inserts are guarded with WHERE NOT EXISTS so a re-run is a
-- no-op.

insert into intel_portfolio_labels
  (match_type, match_value, display_name, portfolio_type)
select 'owner_stem', 'baptist', 'Baptist Memorial Health Care', 'healthcare'
where not exists (
  select 1 from intel_portfolio_labels
  where match_type = 'owner_stem' and match_value = 'baptist'
);

insert into intel_portfolio_labels
  (match_type, match_value, display_name, portfolio_type)
select 'mailing_address', '8545 Cordes Cir', 'Bell Property Group', 'local_investor'
where not exists (
  select 1 from intel_portfolio_labels
  where match_type = 'mailing_address' and match_value = '8545 Cordes Cir'
);
