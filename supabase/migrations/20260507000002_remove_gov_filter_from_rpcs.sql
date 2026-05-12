-- Move all government-owner filtering OUT of the Postgres RPCs and into
-- the JavaScript route handler. Reason: the broadened ILIKE pattern set
-- on intel_is_government_owner() pushes per-row evaluation costs over
-- the 60s budget on a 1.1M-row scan, and even with the bump to 120s the
-- end-to-end response was 12s — too slow for the browser.
--
-- After this migration:
--   * intel_owners_concentration returns owners unfiltered, with a
--     much higher default p_limit (5000) so the JS layer has enough
--     headroom to filter out gov + still surface a meaningful long tail
--     for the concentration computation.
--   * intel_market_concentration likewise returns gov-inclusive
--     aggregates. The JS handler can recompute hide_gov-aware values
--     from the owners list.
--   * Statement timeouts revert to 60s — the simpler queries stay
--     well under that budget.
--   * intel_is_government_owner() stays defined (other code may call it
--     from psql for ad-hoc analysis) but is no longer referenced by any
--     RPC in the hot path.
--
-- p_hide_gov parameters are kept for callers that still pass them but
-- are now no-ops in the SQL layer. The TS route ignores them too.

create or replace function intel_owners_concentration(
  p_city            text default null,
  p_state           text default null,
  p_zip             text default null,
  p_min_properties  int  default 2,
  p_limit           int  default 5000,
  p_county          text default null,
  p_hide_gov        boolean default false  -- no-op
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
  group by upper(trim(regexp_replace(scoped.own_name, '[^A-Za-z0-9 ]', '', 'g')))
  having count(*) >= p_min_properties
  order by property_count desc, total_sqft desc nulls last
  limit p_limit;
end;
$$;

alter function intel_owners_concentration(text, text, text, int, int, text, boolean)
  reset statement_timeout;


create or replace function intel_market_concentration(
  p_city    text default null,
  p_state   text default null,
  p_zip     text default null,
  p_top_n   int  default 10,
  p_county  text default null,
  p_hide_gov boolean default false  -- no-op
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
    select upper(trim(regexp_replace(raw_owner_name, '[^A-Za-z0-9 ]', '', 'g'))) as norm,
           count(*) as n
    from scoped
    group by upper(trim(regexp_replace(raw_owner_name, '[^A-Za-z0-9 ]', '', 'g')))
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

alter function intel_market_concentration(text, text, text, int, text, boolean)
  reset statement_timeout;


-- intel_market_summary doesn't reference intel_is_government_owner; just
-- reset its bumped timeout from yesterday's hot-fix.
alter function intel_market_summary(text, text, text, text)
  reset statement_timeout;


grant execute on function intel_owners_concentration(text, text, text, int, int, text, boolean) to service_role;
grant execute on function intel_market_concentration(text, text, text, int, text, boolean)      to service_role;

analyze intel_properties;
