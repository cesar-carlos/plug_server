-- CreateTable
CREATE TABLE "bridge_latency_traces" (
    "id" TEXT NOT NULL,
    "channel" VARCHAR(32) NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "trace_id" VARCHAR(64),
    "agent_id" VARCHAR(128) NOT NULL,
    "user_id" VARCHAR(128),
    "json_rpc_method" VARCHAR(120),
    "total_ms" INTEGER NOT NULL,
    "phases_ms" JSONB NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "http_status" INTEGER,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_latency_traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bridge_latency_traces_created_at_idx" ON "bridge_latency_traces"("created_at");

-- CreateIndex
CREATE INDEX "bridge_latency_traces_agent_id_created_at_idx" ON "bridge_latency_traces"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "bridge_latency_traces_channel_created_at_idx" ON "bridge_latency_traces"("channel", "created_at");

-- CreateIndex
CREATE INDEX "bridge_latency_traces_outcome_created_at_idx" ON "bridge_latency_traces"("outcome", "created_at");
