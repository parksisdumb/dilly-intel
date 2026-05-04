-- Unique indexes required for CMS agent upserts
-- intel_entities: upsert on (name, source_detail)
-- intel_properties: upsert on (external_id, source_detail)

create unique index if not exists intel_entities_name_source_idx
  on intel_entities (lower(name), source_detail)
  where source_detail is not null;

create unique index if not exists intel_properties_external_source_idx
  on intel_properties (external_id, source_detail)
  where external_id is not null;

-- Add indexes for query patterns the CMS agent will use
create index if not exists intel_entities_source_idx
  on intel_entities (source_detail);

create index if not exists intel_entities_type_idx
  on intel_entities (entity_type);

-- Track which agent last enriched each entity
alter table intel_entities
  add column if not exists last_enriched_by text;
