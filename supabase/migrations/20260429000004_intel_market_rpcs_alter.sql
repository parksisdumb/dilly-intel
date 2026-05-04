-- Attach a 60s statement_timeout as a function-level parameter using
-- ALTER FUNCTION SET. This is more reliable than runtime SET LOCAL since
-- it's applied by Postgres before function execution begins, ahead of any
-- per-role default timeout the service_role may carry.

alter function intel_owners_concentration(text, text, text, int, int)
  set statement_timeout = '60s';

alter function intel_market_summary(text, text, text)
  set statement_timeout = '60s';

alter function intel_market_concentration(text, text, text, int)
  set statement_timeout = '60s';
