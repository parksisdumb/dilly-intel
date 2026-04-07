-- ════════════════════════════════════════
-- USER TABLES (RLS enabled)
-- ════════════════════════════════════════

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  dilly_org_id uuid,
  plan text DEFAULT 'free',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  email text NOT NULL,
  full_name text,
  org_id uuid REFERENCES orgs(id),
  dilly_user_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE icp_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES orgs(id),
  user_id uuid REFERENCES users(id),
  name text DEFAULT 'Primary ICP',
  is_active boolean DEFAULT true,
  target_states text[],
  target_cities text[],
  target_metros text[],
  target_account_types text[],
  min_sq_footage integer,
  max_sq_footage integer,
  target_property_types text[],
  target_roof_types text[],
  min_deal_size integer,
  max_deal_size integer,
  target_decision_maker_titles text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE push_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES orgs(id),
  user_id uuid REFERENCES users(id),
  intel_property_id uuid,
  intel_entity_id uuid,
  intel_prospect_id uuid,
  destination text DEFAULT 'dilly',
  destination_org_id uuid,
  destination_account_id uuid,
  status text DEFAULT 'pending',
  pushed_at timestamptz DEFAULT now(),
  error_message text
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES orgs(id),
  key_hash text NOT NULL UNIQUE,
  name text,
  last_used_at timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- ════════════════════════════════════════
-- INTEL TABLES (NO RLS — service role only)
-- ════════════════════════════════════════

CREATE TABLE intel_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  legal_name text,
  ticker text,
  cik text UNIQUE,
  ein text,
  entity_type text,
  sic text,
  naics text,
  total_properties integer,
  total_sq_footage bigint,
  portfolio_summary jsonb,
  parent_entity_id uuid REFERENCES intel_entities(id),
  subsidiary_names text[],
  hq_address text,
  hq_city text,
  hq_state text,
  website text,
  source_detail text,
  last_10k_date date,
  last_10k_accession text,
  last_verified_at timestamptz DEFAULT now(),
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE intel_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  street_address text,
  city text,
  state text,
  postal_code text,
  county text,
  country text DEFAULT 'US',
  lat numeric(10,7),
  lng numeric(10,7),
  property_name text,
  property_type text,
  sq_footage integer,
  year_built integer,
  num_stories integer,
  parcel_id text,
  roof_type text,
  roof_age_years integer,
  roof_last_replaced date,
  roof_sq_footage integer,
  roof_condition text,
  roof_condition_score integer,
  owner_name text,
  owner_type text,
  entity_id uuid REFERENCES intel_entities(id),
  proptracer_id text,
  mailing_address text,
  assessed_value integer,
  last_sale_date date,
  last_sale_price integer,
  source_detail text NOT NULL,
  source_url text,
  external_id text,
  confidence_score integer DEFAULT 25,
  last_verified_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE intel_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text,
  last_name text,
  full_name text,
  title text,
  contact_type text,
  entity_id uuid REFERENCES intel_entities(id),
  property_id uuid REFERENCES intel_properties(id),
  email text,
  phone text,
  linkedin_url text,
  source_detail text,
  confidence_score integer DEFAULT 25,
  last_verified_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE intel_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text,
  street_address text,
  city text,
  state text,
  postal_code text,
  entity_id uuid REFERENCES intel_entities(id),
  property_id uuid REFERENCES intel_properties(id),
  contact_first_name text,
  contact_last_name text,
  contact_title text,
  contact_email text,
  phone text,
  website text,
  property_type text,
  account_type text,
  confidence_score integer DEFAULT 25,
  source_detail text NOT NULL,
  external_id text,
  enrichment_status text,
  enrichment_date timestamptz,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE agent_registry (
  agent_name text PRIMARY KEY,
  display_name text NOT NULL,
  description text,
  schedule text,
  enabled boolean DEFAULT false,
  last_run_at timestamptz,
  last_run_status text,
  total_runs integer DEFAULT 0,
  total_found integer DEFAULT 0,
  total_inserted integer DEFAULT 0,
  config jsonb DEFAULT '{}'
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text REFERENCES agent_registry(agent_name),
  run_type text DEFAULT 'discovery',
  status text DEFAULT 'running',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  records_found integer DEFAULT 0,
  records_added integer DEFAULT 0,
  records_skipped integer DEFAULT 0,
  error_message text,
  metadata jsonb DEFAULT '{}'
);

-- INDEXES
CREATE UNIQUE INDEX intel_properties_address_idx
  ON intel_properties(
    lower(street_address), lower(city), lower(state))
  WHERE street_address IS NOT NULL;
CREATE INDEX intel_properties_city_state_idx
  ON intel_properties(city, state);
CREATE INDEX intel_properties_entity_idx
  ON intel_properties(entity_id);
CREATE INDEX intel_properties_type_idx
  ON intel_properties(property_type);
CREATE INDEX intel_properties_owner_idx
  ON intel_properties(lower(owner_name));
CREATE INDEX intel_properties_county_idx
  ON intel_properties(county, state);
CREATE INDEX intel_entities_parent_idx
  ON intel_entities(parent_entity_id);
CREATE INDEX intel_prospects_city_state_idx
  ON intel_prospects(city, state);
CREATE INDEX push_log_org_idx ON push_log(org_id);
