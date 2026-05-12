-- Broader government-owner detection. The previous list missed common
-- demo cases like:
--   "Memphis Educational Health Authority"
--   "Economic Development Growth Engine" (Memphis)
--   "Downtown Memphis Commission"
--   "Industrial Development Board of Memphis and Shelby County"
--   "Memphis Light Gas and Water"
--   "Convention Center Authority"
--
-- Patterns kept additive — anything matched before still matches.

create or replace function intel_is_government_owner(name text)
  returns boolean language sql immutable parallel safe as $$
  select name is not null and (
    -- Original (do not remove)
    name ilike '%city of%'
    or name ilike '%county of%'
    or name ilike '%state of%'
    or name ilike '%school%'
    or name ilike '%housing authority%'
    or name ilike '%municipal%'
    or name ilike '%department of%'
    or name ilike '%dept of%'
    or name ilike '%board of%'
    or name ilike '%university%'
    or name ilike '%college%'
    or name ilike '%hospital district%'
    or name ilike '%transit%'
    or name ilike '%airport%'
    or name ilike '%water management%'
    or name ilike '%water manage%'
    or name ilike '%port authority%'
    or name ilike '%revenue finance%'
    or name ilike '%economic dev%'
    or name ilike '%development board%'
    or name ilike '%public school%'
    or name ~* '\m(isd|cdd|mdha)\M'

    -- Newly added 2026-05-06
    or name ilike '%educat%'              -- Education / Educational
    or name ilike '%redevelop%'           -- Redevelopment Authority
    or name ilike '%growth engine%'       -- EDGE Memphis "Growth Engine"
    or name ilike '%downtown%authority%'
    or name ilike '%downtown%commission%'
    or name ilike '%industrial development%'
    or name ilike '%public works%'
    or name ilike '%public service%'
    or name ilike '%convention center%'
    or name ilike '%light gas%water%'     -- MLGW-style utility names
    or name ilike '%commission%'          -- Port/Water/Transit/Park Commission
    or name ilike '%bureau%'              -- Federal Bureau, Census Bureau
    or name ilike '%agency%'              -- HUD, Redevelopment Agency
    or name ilike '%authority%'           -- broader catchall — most "Authority" names are gov
    or name ilike '%federal%'
    or name ilike '%township%'
    or name ilike '%borough%'
    or name ilike '%parish%'              -- Louisiana Parish-of-...
    or name ilike '%public health%'
    or name ilike '%mental health%'
    or name ilike '%veterans%affairs%'
    or name ilike '%redev %'
    or name ilike '%trust fund%'          -- Public Trust Fund, Pension Fund
  );
$$;

grant execute on function intel_is_government_owner(text) to service_role;
