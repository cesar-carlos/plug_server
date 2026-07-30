-- When status `revoked` was added to ClientAgentAccessRequestStatus, the CHECK
-- constraints from client_db_rule_hardening were not updated. DELETE /client/me/agents
-- removes access rows first, then setStatus(revoked, reason=client_revoked_access)
-- fails with 23514 — leaving a 500 after a successful revoke of the access row.

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
    "status" IN ('approved', 'rejected', 'expired', 'revoked')
    AND "decided_at" IS NOT NULL
  )
);

ALTER TABLE "client_agent_access_requests"
DROP CONSTRAINT IF EXISTS "client_agent_access_requests_decision_reason_check";

ALTER TABLE "client_agent_access_requests"
ADD CONSTRAINT "client_agent_access_requests_decision_reason_check"
CHECK (
  "decision_reason" IS NULL
  OR "status" IN ('rejected', 'expired', 'revoked')
);
