-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "agents" (
    "agent_id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "cnpj_cpf" VARCHAR(120) NOT NULL,
    "observation" VARCHAR(2000),
    "status" "AgentStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("agent_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_cnpj_cpf_key" ON "agents"("cnpj_cpf");
