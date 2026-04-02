-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('active', 'blocked');

-- CreateEnum
CREATE TYPE "ClientAgentAccessRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "last_name" VARCHAR(120) NOT NULL,
    "mobile" VARCHAR(20),
    "status" "ClientStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_refresh_tokens" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_agent_accesses" (
    "client_id" TEXT NOT NULL,
    "agent_id" VARCHAR(36) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_agent_accesses_pkey" PRIMARY KEY ("client_id","agent_id")
);

-- CreateTable
CREATE TABLE "client_agent_access_requests" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "agent_id" VARCHAR(36) NOT NULL,
    "status" "ClientAgentAccessRequestStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decision_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_agent_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_agent_access_approval_tokens" (
    "id" VARCHAR(128) NOT NULL,
    "request_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_agent_access_approval_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_email_key" ON "clients"("email");

-- CreateIndex
CREATE INDEX "clients_user_id_idx" ON "clients"("user_id");

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE INDEX "client_refresh_tokens_client_id_idx" ON "client_refresh_tokens"("client_id");

-- CreateIndex
CREATE INDEX "client_refresh_tokens_expires_at_idx" ON "client_refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "client_agent_accesses_agent_id_idx" ON "client_agent_accesses"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_agent_access_requests_client_id_agent_id_key" ON "client_agent_access_requests"("client_id", "agent_id");

-- CreateIndex
CREATE INDEX "client_agent_access_requests_agent_id_idx" ON "client_agent_access_requests"("agent_id");

-- CreateIndex
CREATE INDEX "client_agent_access_requests_status_idx" ON "client_agent_access_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "client_agent_access_approval_tokens_request_id_key" ON "client_agent_access_approval_tokens"("request_id");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_refresh_tokens" ADD CONSTRAINT "client_refresh_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_agent_accesses" ADD CONSTRAINT "client_agent_accesses_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_agent_accesses" ADD CONSTRAINT "client_agent_accesses_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_agent_access_requests" ADD CONSTRAINT "client_agent_access_requests_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_agent_access_requests" ADD CONSTRAINT "client_agent_access_requests_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_agent_access_approval_tokens" ADD CONSTRAINT "client_agent_access_approval_tokens_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "client_agent_access_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
