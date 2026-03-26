-- Opaque approval tokens (app-generated); widen id and remove DB default.
ALTER TABLE "registration_approval_tokens" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "registration_approval_tokens" ALTER COLUMN "id" TYPE VARCHAR(128);
