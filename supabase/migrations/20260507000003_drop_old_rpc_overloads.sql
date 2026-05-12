-- Drop the older 6-arg overloads of intel_owners_concentration and
-- intel_market_concentration. They were superseded by the 7-arg
-- signatures (with p_hide_gov) but Postgres keeps both because
-- different argument lists = different functions.
--
-- PostgREST hits "Could not choose the best candidate function between"
-- when callers pass only 6 args, since both overloads match.

drop function if exists intel_owners_concentration(text, text, text, int, int, text);
drop function if exists intel_market_concentration(text, text, text, int, text);

-- Older 5-arg variants from the very first market RPC migration —
-- safe to drop too, never used by current callers.
drop function if exists intel_owners_concentration(text, text, text, int, int);
drop function if exists intel_market_concentration(text, text, text, int);
