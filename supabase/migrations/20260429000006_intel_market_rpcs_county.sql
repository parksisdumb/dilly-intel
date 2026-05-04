-- Add `p_county` parameter to the market RPCs so the new "county" search
-- input on /intelligence and /intelligence/market filters at the DB layer.
-- All three functions get the same predicate: county ILIKE '%<input>%'.
-- Backwards compatible: existing callers that don't pass p_county still
-- work because of the default null.

create or replace function intel_owners_concentration(
  p_city            text default null,
  p_state           text default null,
  p_zip             text default null,
  p_min_properties  int  default 2,
  p_limit           int  default 100,
  p_county          text default null
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
    and (p_city   is null or p.city ilike p_city  || '%')
    and (p_state  is null or p.state = p_state)
    and (p_zip    is null or p.postal_code = p_zip)
    and (p_county is null or p.county ilike '%' || p_county || '%')
  group by p.raw_owner_name, p.entity_id, e.name, e.ticker
  having count(*) >= p_min_properties
  order by property_count desc, total_sqft desc nulls last
  limit p_limit;
end;
$$;

alter function intel_owners_concentration(text, text, text, int, int, text)
  set statement_timeout = '60s';


create or replace function intel_market_summary(
  p_city   text default null,
  p_state  text default null,
  p_zip    text default null,
  p_county text default null
) returns table (
  metric text,
  bucket text,
  cnt    bigint
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src),
  scoped as materialized (
    select p.property_type, p.corporate_owned, p.entity_id
    from intel_properties p
    where p.source_detail in (select src from sources)
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
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

alter function intel_market_summary(text, text, text, text)
  set statement_timeout = '60s';


create or replace function intel_market_concentration(
  p_city   text default null,
  p_state  text default null,
  p_zip    text default null,
  p_top_n  int  default 10,
  p_county text default null
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
  scoped as materialized (
    select p.raw_owner_name
    from intel_properties p
    where p.source_detail in (select src from sources)
      and p.raw_owner_name is not null
      and (p_city   is null or p.city ilike p_city  || '%')
      and (p_state  is null or p.state = p_state)
      and (p_zip    is null or p.postal_code = p_zip)
      and (p_county is null or p.county ilike '%' || p_county || '%')
  ),
  per_owner as (
    select raw_owner_name, count(*) as n
    from scoped
    group by raw_owner_name
  ),
  top_n as (
    select coalesce(sum(n), 0)::bigint as cnt
    from (select n from per_owner order by n desc limit p_top_n) t
  ),
  totals as (
    select
      coalesce((select sum(n) from per_owner), 0)::bigint as total_count,
      coalesce((select count(*) from per_owner), 0)::bigint as owners_count
  )
  select
    totals.total_count                                              as total_market_count,
    totals.owners_count                                             as total_owners_count,
    top_n.cnt                                                       as top_n_property_count,
    case when totals.total_count = 0 then 0::numeric
         else round(100.0 * top_n.cnt::numeric / totals.total_count, 2)
    end                                                             as top_n_pct
  from totals, top_n;
end;
$$;

alter function intel_market_concentration(text, text, text, int, text)
  set statement_timeout = '60s';


grant execute on function intel_owners_concentration(text, text, text, int, int, text) to service_role;
grant execute on function intel_market_summary(text, text, text, text)                  to service_role;
grant execute on function intel_market_concentration(text, text, text, int, text)       to service_role;

-- Index to make county ILIKE queries fast.
create index if not exists intel_properties_market_county_idx
  on intel_properties (lower(county))
  where source_detail in ('proptracer_mapping','fl_dor_public','nc_onemap_public','tx_cad_dcad','tx_cad_tad','tx_cad_hcad')
    and county is not null;
