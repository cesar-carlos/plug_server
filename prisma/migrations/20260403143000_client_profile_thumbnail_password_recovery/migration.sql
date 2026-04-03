ALTER TABLE "clients"
ADD COLUMN IF NOT EXISTS "thumbnail_url" VARCHAR(2048);

CREATE TABLE IF NOT EXISTS "client_password_recovery_tokens" (
  "id" VARCHAR(128) NOT NULL,
  "client_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_password_recovery_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_password_recovery_tokens_client_id_key"
ON "client_password_recovery_tokens"("client_id");

CREATE INDEX IF NOT EXISTS "client_password_recovery_tokens_expires_at_idx"
ON "client_password_recovery_tokens"("expires_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'client_password_recovery_tokens_client_id_fkey'
  ) THEN
    ALTER TABLE "client_password_recovery_tokens"
    ADD CONSTRAINT "client_password_recovery_tokens_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
