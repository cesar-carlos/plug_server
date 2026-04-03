ALTER TABLE "clients"
ALTER COLUMN "status" SET DEFAULT 'pending';

UPDATE "client_agent_access_requests"
SET
  "decided_at" = NULL,
  "decision_reason" = NULL
WHERE "status" = 'pending';

UPDATE "client_agent_access_requests"
SET "decided_at" = COALESCE("decided_at", "updated_at", "created_at", "requested_at")
WHERE "status" IN ('approved', 'rejected', 'expired')
  AND "decided_at" IS NULL;

UPDATE "client_agent_access_requests"
SET "decision_reason" = NULL
WHERE "status" = 'approved';

ALTER TABLE "client_agent_access_requests"
DROP CONSTRAINT IF EXISTS "client_agent_access_requests_pending_state_check";

ALTER TABLE "client_agent_access_requests"
ADD CONSTRAINT "client_agent_access_requests_pending_state_check"
CHECK (
  (
    "status" = 'pending'
    AND "decided_at" IS NULL
    AND "decision_reason" IS NULL
  )
  OR (
    "status" IN ('approved', 'rejected', 'expired')
    AND "decided_at" IS NOT NULL
  )
);

ALTER TABLE "client_agent_access_requests"
DROP CONSTRAINT IF EXISTS "client_agent_access_requests_decision_reason_check";

ALTER TABLE "client_agent_access_requests"
ADD CONSTRAINT "client_agent_access_requests_decision_reason_check"
CHECK (
  "decision_reason" IS NULL
  OR "status" IN ('rejected', 'expired')
);

ALTER TABLE "client_agent_access_approval_tokens"
DROP CONSTRAINT IF EXISTS "client_agent_access_approval_tokens_expires_after_created_check";

ALTER TABLE "client_agent_access_approval_tokens"
ADD CONSTRAINT "client_agent_access_approval_tokens_expires_after_created_check"
CHECK ("expires_at" > "created_at");

ALTER TABLE "client_registration_approval_tokens"
DROP CONSTRAINT IF EXISTS "client_registration_approval_tokens_expires_after_created_check";

ALTER TABLE "client_registration_approval_tokens"
ADD CONSTRAINT "client_registration_approval_tokens_expires_after_created_check"
CHECK ("expires_at" > "created_at");

CREATE INDEX IF NOT EXISTS "client_agent_access_requests_client_id_requested_at_idx"
ON "client_agent_access_requests"("client_id", "requested_at");

CREATE INDEX IF NOT EXISTS "client_agent_access_requests_client_id_status_requested_at_idx"
ON "client_agent_access_requests"("client_id", "status", "requested_at");

CREATE INDEX IF NOT EXISTS "client_agent_access_approval_tokens_expires_at_idx"
ON "client_agent_access_approval_tokens"("expires_at");

CREATE INDEX IF NOT EXISTS "client_registration_approval_tokens_expires_at_idx"
ON "client_registration_approval_tokens"("expires_at");
