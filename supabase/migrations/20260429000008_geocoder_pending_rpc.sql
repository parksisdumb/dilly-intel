-- Geocoder pending-rows RPC. Wraps the slow SELECT in a function with
-- an extended statement_timeout. The geocoder Python client was hitting
-- the 8s ceiling on the bare PostgREST query even with the partial
-- index, because PostgREST routes the query at a connection level whose
-- timeout we can't override per-call from Python.
--
-- This function gets a 60s budget via ALTER FUNCTION SET and writes the
-- predicate in a form the partial index is guaranteed to match
-- (single-value `=`, plus matching IS NULL / IS NOT NULL clauses).

create or replace function intel_geocoder_pending(
  p_source_detail text,
  p_cursor_id     uuid default null,
  p_batch_size    int  default 1000
) returns table (
  id              uuid,
  street_address  text,
  city            text,
  state           text,
  postal_code     text,
  source_detail   text
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  select
    p.id,
    p.street_address,
    p.city,
    p.state,
    p.postal_code,
    p.source_detail
  from intel_properties p
  where p.source_detail = p_source_detail
    and p.latitude is null
    and p.street_address is not null
    and p.city is not null
    and p.state is not null
    and (p_cursor_id is null or p.id > p_cursor_id)
  order by p.id
  limit p_batch_size;
end;
$$;

alter function intel_geocoder_pending(text, uuid, int)
  set statement_timeout = '60s';

grant execute on function intel_geocoder_pending(text, uuid, int) to service_role;
