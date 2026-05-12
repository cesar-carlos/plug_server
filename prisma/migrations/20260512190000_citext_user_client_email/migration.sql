-- Case-insensitive uniqueness for User and Client emails (PostgreSQL citext).
-- The previous VARCHAR UNIQUE allowed e.g. "a@b.com" and "A@B.com" as two rows.

CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" GROUP BY lower("email"::text) HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Migration blocked: users contains duplicate emails that only differ by letter casing. Merge or delete duplicates, then re-run.';
  END IF;
  IF EXISTS (SELECT 1 FROM "clients" GROUP BY lower("email"::text) HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Migration blocked: clients contains duplicate emails that only differ by letter casing. Merge or delete duplicates, then re-run.';
  END IF;
END $$;

UPDATE "users" SET "email" = lower("email"::text);
UPDATE "clients" SET "email" = lower("email"::text);

ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE CITEXT USING "email"::citext;
ALTER TABLE "clients" ALTER COLUMN "email" SET DATA TYPE CITEXT USING "email"::citext;
