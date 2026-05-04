-- PropTracer v2 rebuild — ensure all columns the agent writes exist.
-- Most were added in earlier migrations; this is the final audit to satisfy
-- the scraper's spec. Uses `add column if not exists` so it's idempotent.

alter table intel_properties
  -- Owner mailing address (from ownerInfo.mailAddress)
  add column if not exists owner_mailing_address text,
  add column if not exists owner_mailing_city text,
  add column if not exists owner_mailing_state text,
  add column if not exists owner_mailing_zip text,
  -- Ownership flags
  add column if not exists corporate_owned boolean,
  add column if not exists absentee_owner boolean,
  -- Geographic
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  -- Already had lat/lng numeric(10,7) — keep both in sync during upsert
  -- Owner + identifiers
  add column if not exists raw_owner_name text,
  add column if not exists apn text,
  -- Values
  add column if not exists estimated_value numeric,
  add column if not exists building_sqft numeric,
  add column if not exists lot_size_sqft numeric,
  -- Enrichment flags
  add column if not exists enrichment_status text default 'unmatched',
  add column if not exists enrichment_level integer default 0,
  add column if not exists needs_assessor_data boolean default true,
  add column if not exists needs_google_places boolean default true;

-- Non-unique index on normalized address for cross-source matching.
-- The old UNIQUE version was replaced in 20260421000003; re-state here
-- idempotently in case someone applies migrations out of order.
drop index if exists intel_properties_address_idx;
create index if not exists intel_properties_address_idx
  on intel_properties (lower(street_address), lower(city), lower(state))
  where street_address is not null;

-- Index on owner name for cross-source matching
create index if not exists intel_properties_raw_owner_idx
  on intel_properties (lower(raw_owner_name))
  where raw_owner_name is not null;

-- Index on enrichment_status for ops filtering
create index if not exists intel_properties_enrichment_status_idx
  on intel_properties (enrichment_status);

-- Index on (external_id, source_detail) is the conflict target for upserts.
-- Was created in 20260421000002; re-create idempotently.
create unique index if not exists intel_properties_external_source_plain_idx
  on intel_properties (external_id, source_detail);
