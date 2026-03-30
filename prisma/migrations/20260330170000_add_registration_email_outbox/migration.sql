CREATE TABLE "registration_email_outbox" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(80) NOT NULL,
    "payload_json" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_email_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "registration_email_outbox_available_at_idx" ON "registration_email_outbox"("available_at");
CREATE INDEX "registration_email_outbox_locked_at_idx" ON "registration_email_outbox"("locked_at");
