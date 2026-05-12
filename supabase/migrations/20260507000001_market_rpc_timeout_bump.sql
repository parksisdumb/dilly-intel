-- Hot fix for the 2026-05-07 timeout report on /intelligence and
-- /intelligence/market.
--
-- The gov-filter broadening in 20260506000001 added ~25 extra ILIKE
-- substring patterns to intel_is_government_owner(), which makes the
-- per-row evaluation in intel_owners_concentration / intel_market_-
-- concentration noticeably more expensive on a 1M+ row scan.
--
-- Combined with stale pg_class/pg_stats after the 112k-row ingestion
-- batch (Cuyahoga / Franklin / Fulton / Cook universe), the existing
-- 60s budget is no longer sufficient for some markets.
--
-- This migration:
--   1. Bumps the three market RPCs to 120s.
--   2. Runs ANALYZE intel_properties so the planner picks correct
--      indexes after the recent bulk ingest.
--   3. Bumps the statistics target on raw_owner_name from the default
--      100 to 1000 — gov-filter ILIKE selectivity estimation depends
--      on this and a higher target lets the planner avoid the worst
--      seq-scan plans.
--
-- If this still isn't enough, the next step (per the on-call notes) is
-- to move gov filtering out of SQL into the API route handler — see
-- src/app/api/intelligence/market/route.ts.

alter function intel_market_summary(text, text, text, text)
  set statement_timeout = '120s';

alter function intel_owners_concentration(text, text, text, int, int, text, boolean)
  set statement_timeout = '120s';

alter function intel_market_concentration(text, text, text, int, text, boolean)
  set statement_timeout = '120s';

alter table intel_properties
  alter column raw_owner_name set statistics 1000;

analyze intel_properties;
