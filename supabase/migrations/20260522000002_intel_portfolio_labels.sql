-- Manual portfolio-label overrides.
--
-- The /api/intelligence/market/portfolios pipeline auto-derives a
-- display name for every cluster (entity match > name stem > individual
-- > mailing address). For well-known institutions the auto-label is
-- often weak ("Portfolio — 501 Saint Jude Pl, Memphis"). This table
-- lets an operator pin a curated display name that always wins.
--
-- A label matches a cluster by one of four keys:
--   mailing_address — substring of any of the cluster's mailing addrs
--   owner_stem      — the cluster's distinctive name stem
--   entity_id       — the matched intel_entities id
--   owner_name      — an exact LLC / owner name in the cluster
--
-- intel_ tables run service-role-only with no RLS, consistent with the
-- rest of the schema.

create table if not exists intel_portfolio_labels (
  id            serial primary key,
  match_type    text not null
                  check (match_type in ('mailing_address', 'owner_stem',
                                         'entity_id', 'owner_name')),
  match_value   text not null,
  display_name  text not null,
  portfolio_type text
                  check (portfolio_type in ('local_investor', 'national_reit',
                                            'institutional', 'family_office',
                                            'pm_company', 'healthcare',
                                            'nonprofit', 'government')),
  notes         text,
  created_at    timestamptz default now()
);

-- Lookup index — the route loads the whole (small) table, but the index
-- keeps any future targeted lookup cheap.
create index if not exists intel_portfolio_labels_match_idx
  on intel_portfolio_labels (match_type, match_value);

grant all on intel_portfolio_labels to service_role;
grant usage, select on sequence intel_portfolio_labels_id_seq to service_role;

-- First curated label: ALSAC / St. Jude. The cluster at 501 Saint Jude
-- Place is correctly grouped but auto-labels to the bare address.
-- Guarded so a re-run can't double-insert.
insert into intel_portfolio_labels
  (match_type, match_value, display_name, portfolio_type, notes)
select
  'mailing_address',
  '501 Saint Jude Pl',
  'ALSAC / St. Jude Children''s Research Hospital',
  'nonprofit',
  'Danny Thomas founded. American Lebanese Syrian Associated Charities. Major Memphis campus.'
where not exists (
  select 1 from intel_portfolio_labels
  where match_type = 'mailing_address'
    and match_value = '501 Saint Jude Pl'
);
