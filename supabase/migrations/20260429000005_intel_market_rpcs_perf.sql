-- Two fixes:
--   1. intel_market_concentration: sum() of bigint returns numeric, but
--      the function declared `total_market_count bigint`. Cast the sums
--      explicitly.
--   2. intel_market_summary: the `scoped` CTE was being inlined and the
--      filter scan repeated for each of the 4 UNION ALL branches. Force
--      MATERIALIZED so we scan once and aggregate four ways.

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
  scoped as materialized (
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

alter function intel_market_concentration(text, text, text, int)
  set statement_timeout = '60s';


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
  scoped as materialized (
    select p.property_type, p.corporate_owned, p.entity_id
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

alter function intel_market_summary(text, text, text)
  set statement_timeout = '60s';

grant execute on function intel_owners_concentration(text, text, text, int, int) to service_role;
grant execute on function intel_market_summary(text, text, text)                  to service_role;
grant execute on function intel_market_concentration(text, text, text, int)       to service_role;
