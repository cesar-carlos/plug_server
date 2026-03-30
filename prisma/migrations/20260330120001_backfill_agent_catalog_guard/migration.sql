-- Migration: backfill_agent_catalog_guard
--
-- Context: The `agents` table was introduced in 20260330120000_add_agent_catalog.
-- Pre-existing `agent_identities` rows reference agentIds that have no corresponding
-- record in `agents`. This migration inserts a placeholder `Agent` record for each
-- orphaned agentId so that the FK-less binding table stays consistent and existing
-- consumers do not break immediately after deploy.
--
-- Operators MUST update these placeholder records via the catalog API to set real
-- `name` and `cnpj_cpf` values before the bind-implicit removal goes live.
--
-- The placeholder name and cnpj_cpf are derived from the agentId to satisfy the
-- NOT NULL and UNIQUE constraints without requiring human input at migration time.

INSERT INTO "agents" ("agent_id", "name", "cnpj_cpf", "status", "updated_at")
SELECT
  ai.agent_id,
  'PLACEHOLDER - ' || LEFT(ai.agent_id, 8)  AS name,
  '00000000000' || ROW_NUMBER() OVER (ORDER BY ai.agent_id)::TEXT AS cnpj_cpf,
  'inactive',
  NOW()
FROM "agent_identities" ai
WHERE NOT EXISTS (
  SELECT 1 FROM "agents" a WHERE a.agent_id = ai.agent_id
);
