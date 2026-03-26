-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'rejected');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'pending';

-- Existing accounts should remain able to log in
UPDATE "users" SET "status" = 'active';

-- CreateTable
CREATE TABLE "registration_approval_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_approval_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registration_approval_tokens_user_id_key" ON "registration_approval_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "registration_approval_tokens" ADD CONSTRAINT "registration_approval_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
