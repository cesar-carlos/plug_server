-- Safety migration: adds retry_count if the previous migration (20260427120000) was applied
-- as an empty file and the column was never created in the database.
ALTER TABLE "client_agent_access_requests" ADD COLUMN IF NOT EXISTS "retry_count" INTEGER NOT NULL DEFAULT 0;
