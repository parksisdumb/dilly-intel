-- Force a fresh ANALYZE on intel_properties. We've ingested ~140k rows
-- since the last bulk run (Cook universe pass + the assorted public-data
-- scrapers) and the planner stats are stale enough that the 4-RPC
-- market endpoint occasionally hits the statement_timeout budget on
-- cold queries.
--
-- ANALYZE is non-blocking (acquires only a SHARE UPDATE EXCLUSIVE lock,
-- doesn't conflict with reads) so safe to run inline in a migration.

analyze intel_properties;
