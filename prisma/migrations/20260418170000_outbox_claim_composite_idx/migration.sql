-- Composite index that matches the ORDER BY of the outbox claim CTE in
-- registration_email_outbox.service.ts:
--
--   SELECT id FROM registration_email_outbox
--   WHERE attempts < $1
--     AND (locked_at IS NULL OR locked_at < $2)
--     AND available_at <= NOW()
--   ORDER BY available_at ASC, created_at ASC
--   LIMIT $3
--   FOR UPDATE SKIP LOCKED;
--
-- The previous single-column `available_at` index forced an extra sort by
-- `created_at` for the tiebreaker. With (available_at, created_at) Postgres
-- can satisfy the ORDER BY directly from the index.
--
-- Kept as a regular (non-partial) index because the `attempts` cap is configurable
-- via REGISTRATION_EMAIL_OUTBOX_MAX_ATTEMPTS (1..50). A partial index would
-- become inaccurate if the cap changed at runtime.
CREATE INDEX IF NOT EXISTS "registration_email_outbox_claim_idx"
  ON "registration_email_outbox" ("available_at", "created_at");
