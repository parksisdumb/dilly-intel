-- Extend intel_market_summary with three market-sizing aggregates so the
-- /intelligence/market KPI bar can show real contractor-facing metrics
-- (sqft / value / vintage) instead of duplicating ownership stats that
-- already live in the Ownership Composition panel.
--
-- Two changes:
--
-- 1. Drop the legacy 3-arg signature
--    (intel_market_summary(text, text, text)) added in
--    20260429000001_intel_market_rpcs.sql. Migration
--    20260430000001_intel_government_filter.sql introduced the 4-arg
--    version that the route actually calls, but it never removed the
--    3-arg version — leaving PostgREST permanently ambiguous when it
--    can't pick between the two via inference. Dropping it resolves
--    the overload and lets us extend the 4-arg version cleanly here.
--
-- 2. Add three aggregate metric rows to the 4-arg
--    intel_market_summary: total_sqft, total_value, avg_year_built.
--    Folded into the existing `cnt` bigint column so the (metric,
--    bucket, cnt) pivot shape is unchanged — the route just looks up
--    the new metric names. `cnt` is a permissive bigint, so
--    multi-billion sqft / value sums fit without overflow.
--    year_built filter (1800..2100) drops the long tail of garbage
--    values so the average stays meaningful.

drop function if exists intel_market_summary(text, text, text);

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
    select
      p.property_type,
      p.corporate_owned,
      p.entity_id,
      p.raw_owner_name,
      p.building_sqft,
      p.estimated_value,
      p.year_built
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
    from scoped group by property_type
  union all
  -- Inferred ownership bucketing
  select 'ownership',
    case
      when corporate_owned is true then 'corporate'
      when corporate_owned is false then 'individual'
      when corporate_owned is null and intel_infer_corporate(raw_owner_name) then 'corporate'
      when corporate_owned is null and intel_infer_individual(raw_owner_name) then 'individual'
      else 'unknown'
    end,
    count(*)::bigint
    from scoped
    group by 1, 2
  union all
  -- Raw counts kept too — UI uses these to compute the "reliability"
  -- gate (>50% explicitly-NULL still triggers N/A even if inference
  -- managed to bucket some).
  select 'ownership_raw',
    case
      when corporate_owned is true then 'corporate'
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
    group by 2
  union all
  -- Market-sizing aggregates. Folded into `cnt` (bigint) so the
  -- existing pivot shape is unchanged — these are the only metric rows
  -- whose bucket is intentionally null.
  select 'total_sqft', null::text, coalesce(sum(building_sqft), 0)::bigint
    from scoped
    where building_sqft is not null and building_sqft > 0
  union all
  select 'total_value', null::text, coalesce(sum(estimated_value), 0)::bigint
    from scoped
    where estimated_value is not null and estimated_value > 0
  union all
  select
    'avg_year_built',
    null::text,
    coalesce(round(avg(year_built))::bigint, 0)
    from scoped
    where year_built between 1800 and 2100;
end;
$$;

alter function intel_market_summary(text, text, text, text)
  set statement_timeout = '60s';

grant execute on function intel_market_summary(text, text, text, text) to service_role;

-- Tell PostgREST to refresh its schema cache so the updated signature
-- (and the new bucket rows it returns) becomes visible immediately.
notify pgrst, 'reload schema';
