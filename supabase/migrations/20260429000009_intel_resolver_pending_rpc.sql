-- RPC for the entity-resolver bulk re-run. Returns paginated unmatched
-- properties with the columns we need to attempt resolution. Mirrors the
-- intel_geocoder_pending pattern: extended statement_timeout, single-
-- value predicate, ORDER BY id for stable cursoring.

create or replace function intel_resolver_pending(
  p_cursor_id    uuid default null,
  p_batch_size   int  default 1000
) returns table (
  id              uuid,
  raw_owner_name  text,
  source_detail   text
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  select
    p.id,
    p.raw_owner_name,
    p.source_detail
  from intel_properties p
  where p.enrichment_status = 'unmatched'
    and p.raw_owner_name is not null
    and (p_cursor_id is null or p.id > p_cursor_id)
  order by p.id
  limit p_batch_size;
end;
$$;

alter function intel_resolver_pending(uuid, int)
  set statement_timeout = '60s';

grant execute on function intel_resolver_pending(uuid, int) to service_role;

-- Partial index optimized for the predicate above.
create index if not exists intel_properties_resolver_pending_idx
  on intel_properties (id)
  where enrichment_status = 'unmatched'
    and raw_owner_name is not null;
