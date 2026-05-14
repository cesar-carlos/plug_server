-- High-concurrency hot-path indexes.
--
-- Notes:
-- - `CREATE EXTENSION` / `CREATE INDEX` run inside Prisma's migration transaction here.
--   For very large production tables, build these concurrently in an operational
--   change window and mark the migration applied afterwards.
-- - `pg_trgm` accelerates `%term%` search used by GET /client/me/agents.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "client_agent_accesses_agent_id_client_id_idx"
  ON "client_agent_accesses" ("agent_id", "client_id");

CREATE INDEX IF NOT EXISTS "agents_status_name_agent_id_idx"
  ON "agents" ("status", "name", "agent_id");

CREATE INDEX IF NOT EXISTS "agents_name_trgm_idx"
  ON "agents" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "agents_trade_name_trgm_idx"
  ON "agents" USING GIN ("trade_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "agents_document_trgm_idx"
  ON "agents" USING GIN ("document" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "clients_status_id_idx"
  ON "clients" ("status", "id");
