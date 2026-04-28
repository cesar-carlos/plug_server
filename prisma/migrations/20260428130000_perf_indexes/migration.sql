-- Performance indexes for hot-path queries
--
-- agents.status: used by GET /api/v1/agents/catalog?status=active (full table scan without index)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_status_idx"
  ON "agents" ("status");

-- registration_approval_tokens.expires_at: aligns with the pattern on all other token models
-- (client_registration_approval_tokens, client_password_recovery_tokens, client_refresh_tokens)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "registration_approval_tokens_expires_at_idx"
  ON "registration_approval_tokens" ("expires_at");

-- audit_events.actor_user_id: enables audit queries scoped to a specific actor
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_events_actor_user_id_idx"
  ON "audit_events" ("actor_user_id");

-- bridge_latency_traces.(user_id, created_at): enables per-user latency analytics
CREATE INDEX CONCURRENTLY IF NOT EXISTS "bridge_latency_traces_user_id_created_at_idx"
  ON "bridge_latency_traces" ("user_id", "created_at");
