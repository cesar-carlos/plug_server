-- Add retry_count to client_agent_access_requests so the service can enforce a
-- maximum number of retries per (client, agent) pair.
-- Backfill with 0 for all existing rows; default 0 for future rows.
ALTER TABLE "client_agent_access_requests"
  ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;
