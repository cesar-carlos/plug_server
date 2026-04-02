ALTER TYPE "ClientStatus" ADD VALUE IF NOT EXISTS 'pending';

CREATE TABLE "client_registration_approval_tokens" (
    "id" VARCHAR(128) NOT NULL,
    "client_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_registration_approval_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_registration_approval_tokens_client_id_key"
ON "client_registration_approval_tokens"("client_id");

ALTER TABLE "client_registration_approval_tokens"
ADD CONSTRAINT "client_registration_approval_tokens_client_id_fkey"
FOREIGN KEY ("client_id") REFERENCES "clients"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
