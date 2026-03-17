-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "event_type" VARCHAR(120) NOT NULL,
    "actor_socket_id" TEXT,
    "actor_user_id" TEXT,
    "actor_role" VARCHAR(40),
    "direction" VARCHAR(40),
    "conversation_id" TEXT,
    "agent_id" TEXT,
    "request_id" TEXT,
    "stream_id" TEXT,
    "trace_id" TEXT,
    "payload_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_events_conversation_id_idx" ON "audit_events"("conversation_id");

-- CreateIndex
CREATE INDEX "audit_events_agent_id_idx" ON "audit_events"("agent_id");

-- CreateIndex
CREATE INDEX "audit_events_request_id_idx" ON "audit_events"("request_id");
