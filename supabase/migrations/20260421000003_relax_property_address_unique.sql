-- The original init_schema_v1 created a UNIQUE index on
-- (lower(street_address), lower(city), lower(state)) which blocks
-- multiple properties at the same address. This is wrong for real-world
-- data: medical plazas, hospital campuses, shopping centers, and
-- multi-tenant buildings legitimately host many properties at one address.
--
-- Replace the unique constraint with a non-unique index (keeps query
-- performance for address lookups) so CMS + future agents can ingest
-- co-located facilities.

drop index if exists intel_properties_address_idx;

create index if not exists intel_properties_address_idx
  on intel_properties (lower(street_address), lower(city), lower(state))
  where street_address is not null;
