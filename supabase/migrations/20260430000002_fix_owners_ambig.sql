-- Fix "column reference raw_owner_name is ambiguous" in
-- intel_owners_concentration. The mode() ORDER BY clauses inside the
-- final SELECT collide with the output table's column names. Qualify
-- with the CTE alias to disambiguate.

create or replace function intel_owners_concentration(
  p_city            text default null,
  p_state           text default null,
  p_zip             text default null,
  p_min_properties  int  default 2,
  p_limit           int  default 100,
  p_county          text default null,
  p_hide_gov        boolean default false
) returns table (
  raw_owner_name    text,
  entity_id         uuid,
  entity_name       text,
  entity_ticker     text,
  property_count    bigint,
  total_sqft        numeric,
  total_value       numeric,
  avg_sqft          numeric
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as (
    select p.raw_owner_name as own_name,
           p.entity_id      as own_entity,
           p.building_sqft,
           p.estimated_value
    from intel_properties p
    where p.source_detail in (select src from sources)
      and p.raw_owner_name is not null
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
      and (not p_hide_gov or not intel_is_government_owner(p.raw_owner_name))
  )
  select
    mode() within group (order by scoped.own_name)       as raw_owner_name,
    mode() within group (order by scoped.own_entity)     as entity_id,
    null::text                                            as entity_name,
    null::text                                            as entity_ticker,
    count(*)                                              as property_count,
    sum(scoped.building_sqft)                             as total_sqft,
    sum(scoped.estimated_value)                           as total_value,
    avg(scoped.building_sqft)                             as avg_sqft
  from scoped
  group by upper(trim(scoped.own_name))
  having count(*) >= p_min_properties
  order by property_count desc, total_sqft desc nulls last
  limit p_limit;
end;
$$;

alter function intel_owners_concentration(text, text, text, int, int, text, boolean)
  set statement_timeout = '60s';

grant execute on function intel_owners_concentration(text, text, text, int, int, text, boolean)
  to service_role;
