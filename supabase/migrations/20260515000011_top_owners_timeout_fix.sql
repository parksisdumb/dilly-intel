-- The Memphis top-50-owners diagnostic times out at the default 60s
-- because of the array_agg(DISTINCT source_detail) — that's a per-
-- group sort. Bump just this function's budget; the others were fine.

alter function intel_diag_memphis_top_owners()
  set statement_timeout = '180s';
