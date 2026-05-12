-- "Portfolio owners by shared mailing address" feature.
-- Surfaces the case where one real-world owner holds N properties
-- through M different LLCs — they all share a tax-bill mailing address.
-- The classic Memphis example is Olymbec, who shows up as ~4 distinct
-- raw_owner_name strings but is one operator, identifiable by the
-- common mailing address.
--
-- Two RPCs:
--   intel_mailing_address_coverage: one-shot diagnostic. Returns per-
--     source_detail counts of total rows + rows with a non-empty
--     owner_mailing_address. Lets us know which sources can drive the
--     portfolio table at all (PropTracer + the public TX/FL CADs do;
--     CMS data and stub rows don't).
--   intel_mailing_address_portfolios: the actual feature. Groups by
--     (mailing_address, mailing_city, mailing_state, mailing_zip),
--     returns property_count, sum sqft, sum value, and a
--     deduped array of the LLC names sharing that mailbox.
--
-- Both restricted to intel_market_sources() so the universe matches
-- the rest of the market dashboard.

create or replace function intel_mailing_address_coverage()
returns table (
  source_detail text,
  total         bigint,
  has_mailing   bigint,
  pct           numeric
) language sql stable as $$
  select
    p.source_detail,
    count(*)::bigint as total,
    count(*) filter (
      where p.owner_mailing_address is not null
        and length(trim(p.owner_mailing_address)) > 5
    )::bigint as has_mailing,
    case when count(*) = 0 then 0::numeric
         else round(
           100.0 * count(*) filter (
             where p.owner_mailing_address is not null
               and length(trim(p.owner_mailing_address)) > 5
           )::numeric / count(*),
           1
         )
    end as pct
  from intel_properties p
  group by p.source_detail
  order by total desc;
$$;


create or replace function intel_mailing_address_portfolios(
  p_city            text default null,
  p_state           text default null,
  p_zip             text default null,
  p_county          text default null,
  p_min_properties  int  default 3,
  p_limit           int  default 50
) returns table (
  owner_mailing_address text,
  owner_mailing_city    text,
  owner_mailing_state   text,
  owner_mailing_zip     text,
  property_count        bigint,
  llc_names             text[],
  total_sqft            numeric,
  total_value           numeric
) language plpgsql as $$
begin
  set local statement_timeout = '60s';

  return query
  with sources as (select unnest(intel_market_sources()) as src)
  select
    p.owner_mailing_address,
    p.owner_mailing_city,
    p.owner_mailing_state,
    p.owner_mailing_zip,
    count(*)::bigint                                            as property_count,
    array_agg(distinct p.raw_owner_name order by p.raw_owner_name)
      filter (where p.raw_owner_name is not null)               as llc_names,
    sum(p.building_sqft)                                        as total_sqft,
    sum(p.estimated_value)                                      as total_value
  from intel_properties p
  where p.source_detail in (select src from sources)
    and p.owner_mailing_address is not null
    and length(trim(p.owner_mailing_address)) > 5
    and (p_city   is null or p.city ilike p_city  || '%')
    and (p_state  is null or p.state = p_state)
    and (p_zip    is null or p.postal_code = p_zip)
    and (p_county is null or p.county ilike '%' || p_county || '%')
  group by
    p.owner_mailing_address,
    p.owner_mailing_city,
    p.owner_mailing_state,
    p.owner_mailing_zip
  having count(*) >= p_min_properties
  order by count(*) desc
  limit p_limit;
end;
$$;


grant execute on function intel_mailing_address_coverage()                          to service_role;
grant execute on function intel_mailing_address_portfolios(text, text, text, text, int, int) to service_role;
