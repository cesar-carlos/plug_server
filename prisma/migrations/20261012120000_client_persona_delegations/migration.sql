CREATE TABLE "client_persona_delegations" (
  "id" TEXT PRIMARY KEY,
  "client_id" TEXT NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  "audience" TEXT NOT NULL,
  "persona_id" TEXT NOT NULL,
  "credentials_updated_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "client_persona_delegations_client_id_idx" ON "client_persona_delegations"("client_id");
CREATE INDEX "client_persona_delegations_expires_at_idx" ON "client_persona_delegations"("expires_at");
CREATE FUNCTION preserve_client_persona_delegation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'Delegation is immutable except first revocation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_persona_delegations_immutable BEFORE UPDATE ON client_persona_delegations
FOR EACH ROW EXECUTE FUNCTION preserve_client_persona_delegation();

