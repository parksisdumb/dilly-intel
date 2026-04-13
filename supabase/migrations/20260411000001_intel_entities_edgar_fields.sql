-- Add EDGAR-specific enrichment fields to intel_entities
alter table intel_entities
  add column if not exists sector text,
  add column if not exists portfolio_type text check (portfolio_type in ('type_a', 'type_b', 'unknown')),
  add column if not exists operating_markets jsonb default '[]'::jsonb,
  add column if not exists ir_website text,
  add column if not exists key_contacts jsonb default '[]'::jsonb,
  add column if not exists needs_website_scrape boolean default false,
  add column if not exists exchange text,
  add column if not exists hq_zip text,
  add column if not exists hq_phone text,
  add column if not exists raw_10k_metadata jsonb;

-- Update agent_registry seed for edgar_intelligence with proper config
update agent_registry
  set config = '{"last_processed_cik": null, "universe_refreshed_at": null, "batch_size": 10}'::jsonb
  where agent_name = 'edgar_intelligence'
    and (config is null or config = '{}'::jsonb);
