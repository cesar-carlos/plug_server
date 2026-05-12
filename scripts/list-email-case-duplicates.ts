/**
 * Lists rows whose email only differs by letter casing (pre-citext / legacy bases).
 * Exit 1 if duplicates exist (suitable for CI or pre-deploy checks).
 *
 * Usage: npx tsx scripts/list-email-case-duplicates.ts
 */
import { prismaClient } from "../src/infrastructure/database/prisma/client";

const main = async (): Promise<void> => {
  const userDups = await prismaClient.$queryRaw<
    Array<{ lower_email: string; cnt: bigint }>
  >`
    SELECT lower("email"::text) AS lower_email, COUNT(*)::bigint AS cnt
    FROM "users"
    GROUP BY lower("email"::text)
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, lower_email
  `;

  const clientDups = await prismaClient.$queryRaw<
    Array<{ lower_email: string; cnt: bigint }>
  >`
    SELECT lower("email"::text) AS lower_email, COUNT(*)::bigint AS cnt
    FROM "clients"
    GROUP BY lower("email"::text)
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, lower_email
  `;

  if (userDups.length === 0 && clientDups.length === 0) {
    console.log("No case-only duplicate emails in users or clients.");
    return;
  }

  if (userDups.length > 0) {
    console.log("Users — duplicate groups (same email ignoring case):");
    for (const row of userDups) {
      console.log(`  ${row.lower_email}  (${String(row.cnt)} rows)`);
      const emails = await prismaClient.$queryRaw<Array<{ email: string }>>`
        SELECT "email"::text AS email FROM "users" WHERE lower("email"::text) = ${row.lower_email}
      `;
      for (const e of emails) {
        console.log(`    - ${e.email}`);
      }
    }
  }

  if (clientDups.length > 0) {
    console.log("Clients — duplicate groups (same email ignoring case):");
    for (const row of clientDups) {
      console.log(`  ${row.lower_email}  (${String(row.cnt)} rows)`);
      const emails = await prismaClient.$queryRaw<Array<{ email: string }>>`
        SELECT "email"::text AS email FROM "clients" WHERE lower("email"::text) = ${row.lower_email}
      `;
      for (const e of emails) {
        console.log(`    - ${e.email}`);
      }
    }
  }

  process.exitCode = 1;
};

void (async () => {
  try {
    await main();
  } finally {
    await prismaClient.$disconnect();
  }
})().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
