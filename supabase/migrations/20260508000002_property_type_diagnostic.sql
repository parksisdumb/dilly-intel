-- One-shot diagnostic. Returns the per-property_type count for a
-- restricted (state, city, source-list) slice — same shape as the
-- query the data team uses to spot-check whether the market dashboard
-- is double-counting across sources.
--
-- Kept around (not dropped) because the same query gets re-run any
-- time we onboard a new source that overlaps an existing market.

create or replace function intel_diag_property_types_by_market(
  p_state    text,
  p_city     text,
  p_sources  text[]
) returns table (
  property_type text,
  cnt           bigint
) language sql stable as $$
  select
    p.property_type,
    count(*)::bigint as cnt
  from intel_properties p
  where p.state = p_state
    and p.city ilike '%' || p_city || '%'
    and p.source_detail = any(p_sources)
  group by p.property_type
  order by cnt desc
  limit 50;
$$;

grant execute on function intel_diag_property_types_by_market(text, text, text[]) to service_role;
