-- Add per-(client, agent) bearer token used by the client to authorize SQL
-- queries on the agent (`sql.execute params.client_token`). Stored only on
-- approved access rows so revoking the access also revokes the token.
--
-- Nullable: clients may use agent capabilities that do not require a token, or
-- defer setting it until later. Length matches existing token surfaces in this
-- codebase (see `client_token` validators on the agent SQL bridge).
ALTER TABLE "client_agent_accesses"
  ADD COLUMN IF NOT EXISTS "client_token" VARCHAR(512);
