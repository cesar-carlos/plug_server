-- Add pruning-friendly indexes for agent profile maintenance jobs.
CREATE INDEX "agent_profile_revisions_created_at_idx"
ON "agent_profile_revisions"("created_at");

CREATE INDEX "agent_profile_write_idempotencies_created_at_idx"
ON "agent_profile_write_idempotencies"("created_at");
