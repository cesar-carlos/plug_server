-- Ensure every agent_identity row references a valid catalog agent.
-- Existing orphaned rows should already be covered by the placeholder backfill migration.
ALTER TABLE "agent_identities"
ADD CONSTRAINT "agent_identities_agent_id_fkey"
FOREIGN KEY ("agent_id")
REFERENCES "agents"("agent_id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
