-- Partial index on pending client_agent_access_requests.
--
-- Hot path: the expiry sweep in `agent_data_maintenance.service.ts` joins
-- pending requests to their tokens and orders by `requested_at`. The full
-- `(client_id, requested_at)` btree exists, but most rows are non-pending
-- (approved/rejected/revoked) once the system has been running for a while,
-- so a partial index is significantly smaller and cheaper to maintain.
--
-- A partial index on `WHERE status = 'pending'` shrinks the working set to
-- exactly the rows the sweep cares about, and Postgres can use it to satisfy
-- the JOIN+ORDER BY without re-scanning rejected/approved rows.
CREATE INDEX IF NOT EXISTS "client_agent_access_requests_pending_idx"
  ON "client_agent_access_requests" ("client_id", "requested_at")
  WHERE status = 'pending';
