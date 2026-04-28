-- Performance indexes for hot-path queries
--
-- Note: CREATE INDEX CONCURRENTLY cannot run inside Prisma's migration transaction.
-- Use standard CREATE INDEX here; for huge tables in production, consider building
-- indexes concurrently outside migrate deploy and marking the migration applied.
CREATE INDEX IF NOT EXISTS "agents_status_idx"
  ON "agents" ("status");

CREATE INDEX IF NOT EXISTS "registration_approval_tokens_expires_at_idx"
  ON "registration_approval_tokens" ("expires_at");

CREATE INDEX IF NOT EXISTS "audit_events_actor_user_id_idx"
  ON "audit_events" ("actor_user_id");

CREATE INDEX IF NOT EXISTS "bridge_latency_traces_user_id_created_at_idx"
  ON "bridge_latency_traces" ("user_id", "created_at");
