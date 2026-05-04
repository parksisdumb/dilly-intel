-- Drop the STABLE marker so `SET LOCAL statement_timeout` is allowed.
-- VOLATILE is the default and adds no observable behavior change for our
-- read-only RPCs since PostgREST never caches results across calls anyway.

create or replace function intel_owners_concentration(
  p_city            text default null,
  p_state           text default null,
  p_zip             text default null,
  p_min_properties  int  default 2,
  p_limit           int  default 100
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
  with sources as (select unnest(intel_market_sources()) as src)
  select
    p.raw_owner_name,
    p.entity_id,
    e.name        as entity_name,
    e.ticker      as entity_ticker,
    count(*)      as property_count,
    sum(p.building_sqft)     as total_sqft,
    sum(p.estimated_value)   as total_value,
    avg(p.building_sqft)     as avg_sqft
  from intel_properties p
    left join intel_entities e on e.id = p.entity_id
  where p.source_detail in (select src from sources)
    and p.raw_owner_name is not null
    and (p_city  is null or p.city ilike p_city  || '%')
    and (p_state is null or p.state = p_state)
    and (p_zip   is null or p.postal_code = p_zip)
  group by p.raw_owner_name, p.entity_id, e.name, e.ticker
  having count(*) >= p_min_properties
  order by property_count desc, total_sqft desc nulls last
  limit p_limit;
end;
$$;


create or replace function intel_market_summary(
  p_city  text default null,
  p_state text default null,
  p_zip   text default null
) returns table (
  metric text,
  bucket text,
  cnt    bigint
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as (
    select p.*
    from intel_properties p
    where p.source_detail in (select src from sources)
      and (p_city  is null or p.city ilike p_city  || '%')
      and (p_state is null or p.state = p_state)
      and (p_zip   is null or p.postal_code = p_zip)
  )
  select 'total'::text, null::text, count(*)::bigint from scoped
  union all
  select 'by_type', coalesce(property_type, 'unknown'), count(*)::bigint
    from scoped
    group by property_type
  union all
  select 'ownership',
    case
      when corporate_owned is true  then 'corporate'
      when corporate_owned is false then 'individual'
      else 'unknown'
    end,
    count(*)::bigint
    from scoped
    group by 1, 2
  union all
  select 'matched',
    case when entity_id is null then 'unmatched' else 'matched' end,
    count(*)::bigint
    from scoped
    group by 2;
end;
$$;


create or replace function intel_market_concentration(
  p_city  text default null,
  p_state text default null,
  p_zip   text default null,
  p_top_n int  default 10
) returns table (
  total_market_count   bigint,
  total_owners_count   bigint,
  top_n_property_count bigint,
  top_n_pct            numeric
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as (
    select p.raw_owner_name
    from intel_properties p
    where p.source_detail in (select src from sources)
      and p.raw_owner_name is not null
      and (p_city  is null or p.city ilike p_city  || '%')
      and (p_state is null or p.state = p_state)
      and (p_zip   is null or p.postal_code = p_zip)
  ),
  per_owner as (
    select raw_owner_name, count(*) as n
    from scoped
    group by raw_owner_name
  ),
  top_n as (
    select coalesce(sum(n), 0) as cnt
    from (select n from per_owner order by n desc limit p_top_n) t
  ),
  totals as (
    select
      coalesce((select sum(n) from per_owner), 0) as total_count,
      coalesce((select count(*) from per_owner), 0) as owners_count
  )
  select
    totals.total_count                                              as total_market_count,
    totals.owners_count                                             as total_owners_count,
    top_n.cnt                                                       as top_n_property_count,
    case when totals.total_count = 0 then 0
         else round(100.0 * top_n.cnt::numeric / totals.total_count, 2)
    end                                                             as top_n_pct
  from totals, top_n;
end;
$$;


grant execute on function intel_owners_concentration(text, text, text, int, int) to service_role;
grant execute on function intel_market_summary(text, text, text)                  to service_role;
grant execute on function intel_market_concentration(text, text, text, int)       to service_role;
