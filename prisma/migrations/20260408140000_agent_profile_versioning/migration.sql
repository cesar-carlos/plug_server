-- Agent profile versioning, revision history, and idempotency keys

ALTER TABLE "agents" ADD COLUMN "profile_version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "agent_profile_revisions" (
    "id" TEXT NOT NULL,
    "agent_id" VARCHAR(36) NOT NULL,
    "profile_version" INTEGER NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "actor_user_id" VARCHAR(36),
    "request_id" VARCHAR(128),
    "idempotency_key" VARCHAR(256),
    "changed_fields" JSONB NOT NULL,
    "snapshot_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_profile_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_profile_revisions_agent_id_profile_version_key" ON "agent_profile_revisions"("agent_id", "profile_version");

CREATE INDEX "agent_profile_revisions_agent_id_created_at_idx" ON "agent_profile_revisions"("agent_id", "created_at");

ALTER TABLE "agent_profile_revisions" ADD CONSTRAINT "agent_profile_revisions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_profile_write_idempotencies" (
    "id" TEXT NOT NULL,
    "agent_id" VARCHAR(36) NOT NULL,
    "dedupe_key" VARCHAR(256) NOT NULL,
    "patch_fingerprint" VARCHAR(64) NOT NULL,
    "resulting_profile_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_profile_write_idempotencies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_profile_write_idempotencies_agent_id_dedupe_key_key" ON "agent_profile_write_idempotencies"("agent_id", "dedupe_key");

CREATE INDEX "agent_profile_write_idempotencies_agent_id_idx" ON "agent_profile_write_idempotencies"("agent_id");

ALTER TABLE "agent_profile_write_idempotencies" ADD CONSTRAINT "agent_profile_write_idempotencies_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;
