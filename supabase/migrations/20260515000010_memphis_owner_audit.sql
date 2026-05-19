-- One-shot read-only diagnostics for the Memphis owner-data audit
-- (2026-05-15). Each function wraps a single SELECT from the
-- audit spec — there's no business logic, they're just here so
-- PostgREST has something to call. Safe to drop after the audit;
-- nothing else depends on them.

-- A. Top 50 owners by property count
create or replace function intel_diag_memphis_top_owners()
returns table (
  owner_name text,
  prop_count bigint,
  total_sqft numeric,
  sources text[]
) language sql stable as $$
  select
    p.owner_name,
    count(*)::bigint                                       as prop_count,
    sum(p.building_sqft)                                   as total_sqft,
    array_agg(distinct p.source_detail order by p.source_detail) as sources
  from intel_properties p
  where p.state = 'TN'
    and p.city ilike '%memphis%'
    and p.owner_name is not null
  group by p.owner_name
  order by prop_count desc
  limit 50;
$$;

-- B. All Olymbec variants
create or replace function intel_diag_memphis_olymbec()
returns table (
  owner_name text,
  owner_mailing_address text,
  owner_mailing_city text,
  owner_mailing_state text,
  props bigint
) language sql stable as $$
  select
    p.owner_name,
    p.owner_mailing_address,
    p.owner_mailing_city,
    p.owner_mailing_state,
    count(*)::bigint as props
  from intel_properties p
  where p.state = 'TN'
    and p.city ilike '%memphis%'
    and upper(p.owner_name) like '%OLYMBEC%'
  group by p.owner_name, p.owner_mailing_address,
           p.owner_mailing_city, p.owner_mailing_state
  order by props desc;
$$;

-- C. EQT / Exeter entities in intel_entities
create or replace function intel_diag_eqt_entities()
returns table (
  name text,
  entity_type text,
  sub_count int,
  first_10_subs text[]
) language sql stable as $$
  select
    e.name,
    e.entity_type,
    coalesce(array_length(e.subsidiary_names, 1), 0)         as sub_count,
    e.subsidiary_names[1:10]                                 as first_10_subs
  from intel_entities e
  where upper(e.name) like '%EQT%' or upper(e.name) like '%EXETER%';
$$;

-- D. Memphis properties matched to any entity (first 30)
create or replace function intel_diag_memphis_matched_entities()
returns table (
  owner_name text,
  street_address text,
  entity_name text
) language sql stable as $$
  select
    p.owner_name,
    p.street_address,
    e.name as entity_name
  from intel_properties p
  join intel_entities e on p.entity_id = e.id
  where p.state = 'TN' and p.city ilike '%memphis%'
  order by e.name
  limit 30;
$$;

-- E. Top 30 mailing-address clusters (raw — no fuzzy dedup yet)
create or replace function intel_diag_memphis_mailing_clusters()
returns table (
  owner_mailing_address text,
  owner_mailing_city text,
  owner_mailing_state text,
  props bigint,
  distinct_llcs bigint,
  llc_names text[]
) language sql stable as $$
  select
    p.owner_mailing_address,
    p.owner_mailing_city,
    p.owner_mailing_state,
    count(*)::bigint                                            as props,
    count(distinct p.owner_name)::bigint                        as distinct_llcs,
    array_agg(distinct p.owner_name order by p.owner_name)      as llc_names
  from intel_properties p
  where p.state = 'TN'
    and p.city ilike '%memphis%'
    and p.owner_mailing_address is not null
    and p.owner_mailing_address != ''
  group by p.owner_mailing_address, p.owner_mailing_city, p.owner_mailing_state
  having count(*) >= 3
  order by props desc
  limit 30;
$$;

-- F. Memphis mailing-address coverage (one row)
create or replace function intel_diag_memphis_mailing_coverage()
returns table (
  total bigint,
  has_mailing bigint,
  pct numeric
) language sql stable as $$
  select
    count(*)::bigint                                       as total,
    count(p.owner_mailing_address)::bigint                 as has_mailing,
    round(
      count(p.owner_mailing_address)::numeric
      / nullif(count(*), 0)::numeric * 100, 1
    ) as pct
  from intel_properties p
  where p.state = 'TN' and p.city ilike '%memphis%';
$$;

-- G. Institutional / portfolio-keyword owners (>= 2 props)
create or replace function intel_diag_memphis_institutional()
returns table (
  owner_name text,
  props bigint,
  owner_mailing_address text,
  owner_mailing_city text,
  owner_mailing_state text
) language sql stable as $$
  select
    p.owner_name,
    count(*)::bigint as props,
    p.owner_mailing_address,
    p.owner_mailing_city,
    p.owner_mailing_state
  from intel_properties p
  where p.state = 'TN' and p.city ilike '%memphis%'
    and (
         upper(p.owner_name) like '%FUND%'
      or upper(p.owner_name) like '%CAPITAL%'
      or upper(p.owner_name) like '%PARTNERS%'
      or upper(p.owner_name) like '%VENTURES%'
      or upper(p.owner_name) like '%INDUSTRIAL%'
      or upper(p.owner_name) like '%REALTY%'
      or upper(p.owner_name) like '%TRUST%'
      or upper(p.owner_name) like '%ASSET%'
      or upper(p.owner_name) like '%PORTFOLIO%'
      or upper(p.owner_name) like '%ACQUISITION%'
    )
  group by p.owner_name, p.owner_mailing_address,
           p.owner_mailing_city, p.owner_mailing_state
  having count(*) >= 2
  order by props desc
  limit 30;
$$;

grant execute on function intel_diag_memphis_top_owners()                 to service_role;
grant execute on function intel_diag_memphis_olymbec()                    to service_role;
grant execute on function intel_diag_eqt_entities()                       to service_role;
grant execute on function intel_diag_memphis_matched_entities()           to service_role;
grant execute on function intel_diag_memphis_mailing_clusters()           to service_role;
grant execute on function intel_diag_memphis_mailing_coverage()           to service_role;
grant execute on function intel_diag_memphis_institutional()              to service_role;
