-- Dedicated fleet observability table for agent.autoUpdate.diagnostics.push.
CREATE TABLE "agent_auto_update_diagnostics" (
    "id" TEXT NOT NULL,
    "agent_id" VARCHAR(36) NOT NULL,
    "app_version" VARCHAR(64) NOT NULL,
    "check_id" VARCHAR(128),
    "checked_at" TIMESTAMP(3) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "completion_source" VARCHAR(64),
    "remote_version" VARCHAR(64),
    "update_available" BOOLEAN,
    "channel" VARCHAR(32),
    "rollout_bucket" INTEGER,
    "feed_signature_status" VARCHAR(64),
    "feed_signature_required" BOOLEAN,
    "helper_signature_status" VARCHAR(64),
    "probe_duration_ms" INTEGER,
    "download_duration_ms" INTEGER,
    "automatic_failure_count" INTEGER,
    "error_message" VARCHAR(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_auto_update_diagnostics_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "agent_auto_update_diagnostics"
ADD CONSTRAINT "agent_auto_update_diagnostics_agent_id_fkey"
FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "agent_auto_update_diagnostics_agent_id_idx"
ON "agent_auto_update_diagnostics"("agent_id");

CREATE INDEX "agent_auto_update_diagnostics_checked_at_idx"
ON "agent_auto_update_diagnostics"("checked_at");

CREATE INDEX "agent_auto_update_diagnostics_app_version_idx"
ON "agent_auto_update_diagnostics"("app_version");

CREATE INDEX "agent_auto_update_diagnostics_completion_source_idx"
ON "agent_auto_update_diagnostics"("completion_source");

CREATE INDEX "agent_auto_update_diagnostics_source_idx"
ON "agent_auto_update_diagnostics"("source");

CREATE INDEX "agent_auto_update_diagnostics_agent_id_checked_at_idx"
ON "agent_auto_update_diagnostics"("agent_id", "checked_at");

