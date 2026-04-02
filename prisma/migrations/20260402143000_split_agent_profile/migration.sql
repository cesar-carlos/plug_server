DO $$
BEGIN
  CREATE TYPE "AgentDocumentType" AS ENUM ('cpf', 'cnpj');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "agents"
  RENAME COLUMN "cnpj_cpf" TO "document";

ALTER TABLE "agents"
  RENAME COLUMN "observation" TO "notes";

ALTER TABLE "agents"
  ALTER COLUMN "document" TYPE VARCHAR(20),
  ALTER COLUMN "document" DROP NOT NULL;

ALTER TABLE "agents"
  ADD COLUMN "trade_name" VARCHAR(120),
  ADD COLUMN "document_type" "AgentDocumentType",
  ADD COLUMN "phone" VARCHAR(20),
  ADD COLUMN "mobile" VARCHAR(20),
  ADD COLUMN "email" VARCHAR(255),
  ADD COLUMN "street" VARCHAR(120),
  ADD COLUMN "number" VARCHAR(20),
  ADD COLUMN "district" VARCHAR(120),
  ADD COLUMN "postal_code" VARCHAR(20),
  ADD COLUMN "city" VARCHAR(120),
  ADD COLUMN "state" VARCHAR(2),
  ADD COLUMN "profile_updated_at" TIMESTAMP(3),
  ADD COLUMN "last_login_user_id" TEXT;

UPDATE "agents"
SET
  "trade_name" = COALESCE("trade_name", "name"),
  "document_type" = CASE
    WHEN "document" ~ '^[0-9]{11}$' THEN 'cpf'::"AgentDocumentType"
    WHEN "document" ~ '^[0-9]{14}$' THEN 'cnpj'::"AgentDocumentType"
    ELSE "document_type"
  END;

ALTER INDEX IF EXISTS "agents_cnpj_cpf_key"
  RENAME TO "agents_document_key";

CREATE INDEX IF NOT EXISTS "agents_last_login_user_id_idx"
  ON "agents"("last_login_user_id");

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_last_login_user_id_fkey"
  FOREIGN KEY ("last_login_user_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
