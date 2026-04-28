-- AlterTable
ALTER TABLE "client_agent_access_requests" ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;
