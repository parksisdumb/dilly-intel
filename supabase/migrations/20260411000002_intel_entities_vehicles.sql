alter table intel_entities
  add column if not exists investment_vehicles jsonb default '[]'::jsonb;
