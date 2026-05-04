-- Fix: expression and partial unique indexes don't work with PostgREST upserts.
-- PostgREST's ON CONFLICT requires a plain column unique index/constraint whose
-- column list exactly matches the onConflict param.

-- Drop old expression index on intel_entities
drop index if exists intel_entities_name_source_idx;

-- Plain unique index on intel_entities (name, source_detail)
create unique index if not exists intel_entities_name_source_plain_idx
  on intel_entities (name, source_detail);

-- Drop old partial index on intel_properties
drop index if exists intel_properties_external_source_idx;

-- Plain unique index on intel_properties (external_id, source_detail)
-- NULL values don't conflict in a unique index so partial clause is unnecessary.
create unique index if not exists intel_properties_external_source_plain_idx
  on intel_properties (external_id, source_detail);
