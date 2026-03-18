CREATE TABLE "agent_identities" (
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_identities_pkey" PRIMARY KEY ("agent_id")
);

CREATE INDEX "agent_identities_user_id_idx" ON "agent_identities"("user_id");

ALTER TABLE "agent_identities"
ADD CONSTRAINT "agent_identities_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
