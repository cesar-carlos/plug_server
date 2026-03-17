-- CreateIndex
CREATE INDEX "audit_events_stream_id_idx" ON "audit_events"("stream_id");

-- CreateIndex
CREATE INDEX "audit_events_conversation_id_created_at_idx" ON "audit_events"("conversation_id", "created_at");

