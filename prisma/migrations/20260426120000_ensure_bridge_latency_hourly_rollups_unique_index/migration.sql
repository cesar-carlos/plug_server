-- Fix for `REFRESH MATERIALIZED VIEW CONCURRENTLY` (PostgreSQL error 55000).
--
-- PostgreSQL requires a UNIQUE index on the materialized view that:
-- - uses only column names (no expressions/functions), and
-- - has no WHERE clause.
--
-- The original migration created a UNIQUE expression index using COALESCE(...),
-- which is not eligible for concurrent refresh. Replace it with a plain-column
-- UNIQUE index so the scheduled CONCURRENTLY refresh can run.
DROP INDEX IF EXISTS bridge_latency_trace_hourly_rollups_unique_idx;

CREATE UNIQUE INDEX bridge_latency_trace_hourly_rollups_unique_idx
  ON bridge_latency_trace_hourly_rollups (
    hour_utc,
    channel,
    outcome,
    json_rpc_method
  );
