import "dotenv/config";

import { PrismaClient } from "@prisma/client";

const redactDatabaseUrl = (url: string): string => {
  try {
    const u = new URL(url);
    if (u.password) {
      u.password = "***";
    }
    if (u.username) {
      u.username = "***";
    }
    return u.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
};

const truncate = (s: string | null | undefined, max: number): string | null => {
  if (s == null) {
    return null;
  }
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}…`;
};

const parseCli = (): { ownerEmail: string | null; short: boolean; help: boolean } => {
  const argv = process.argv.slice(2);
  let ownerEmail: string | null = null;
  let short = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a === "--short") {
      short = true;
      continue;
    }
    if (a === "--owner") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.trim() !== "") {
        ownerEmail = next.trim().toLowerCase();
        i += 1;
      }
      continue;
    }
  }
  return { ownerEmail, short, help };
};

const printUsage = (): void => {
  console.log(`Usage: npx tsx scripts/registration-diagnostics.ts [options]

Options:
  --owner <email>   Same rule as POST /api/v1/client-auth/register (User must exist and status active)
  --short           Print only env + --owner section (requires --owner)
  -h, --help        This message

Examples:
  npm run db:registration:diag
  DATABASE_URL='postgresql://…' npx tsx scripts/registration-diagnostics.ts --owner tercioscherwinski@gmail.com --short
`);
};

const printEnv = (dbUrl: string, appBase: string): void => {
  console.log("=== Registration / approval diagnostics ===\n");
  console.log("APP_BASE_URL (links in emails):", appBase);
  console.log("DATABASE_URL:", dbUrl ? redactDatabaseUrl(dbUrl) : "(unset)");
  if (appBase !== "(unset)" && dbUrl.includes("localhost") && !appBase.includes("localhost")) {
    console.log(
      "\nWARN: local Postgres but APP_BASE_URL is not local — approval links may hit another API than the DB you are inspecting.\n",
    );
  }
};

const printOwnerEligibility = async (prisma: PrismaClient, ownerEmail: string): Promise<void> => {
  const normalized = ownerEmail.trim().toLowerCase();
  console.log("\n--- Owner eligibility (POST /api/v1/client-auth/register) ---");
  console.log("lookup (normalized like API):", normalized);
  const u = await prisma.user.findFirst({
    where: { email: { equals: normalized, mode: "insensitive" } },
    select: { email: true, status: true, role: true },
  });
  if (!u) {
    console.log("User row: (none)");
    console.log(
      "canApproveClientRegistration: NO — API returns 400 \"Owner email is not eligible to approve client registration\"",
    );
    return;
  }
  console.log("User row:", JSON.stringify(u, null, 2));
  const ok = u.status === "active";
  console.log(
    `canApproveClientRegistration: ${ok ? "YES" : "NO"} — API ${ok ? "accepts" : "returns 400 \"Owner email is not eligible to approve client registration\""}`,
  );
  if (!ok) {
    console.log(`reason: user.status is "${u.status}", must be "active"`);
  }
};

const printFullReport = async (prisma: PrismaClient): Promise<void> => {
  const activeOwners = await prisma.user.findMany({
    where: { status: "active" },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  console.log("\n--- Active User emails (eligible as client register ownerEmail) ---");
  console.log(`count: ${activeOwners.length}`);
  for (const u of activeOwners) {
    console.log(`  ${u.email}`);
  }

  const pending = await prisma.client.findMany({
    where: { status: "pending" },
    include: {
      user: { select: { email: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  console.log("\n--- Pending Client registrations ---");
  if (pending.length === 0) {
    console.log("(none)");
  }
  for (const c of pending) {
    const tok = await prisma.clientRegistrationApprovalToken.findUnique({
      where: { clientId: c.id },
      select: { id: true, expiresAt: true },
    });
    const now = new Date();
    const expired = tok ? tok.expiresAt < now : null;
    console.log(
      JSON.stringify(
        {
          clientEmail: c.email,
          ownerEmail: c.user.email,
          ownerUserStatus: c.user.status,
          createdAt: c.createdAt.toISOString(),
          approvalToken: tok
            ? { expiresAt: tok.expiresAt.toISOString(), expired, idPrefix: `${tok.id.slice(0, 8)}…` }
            : "MISSING (cannot approve via token)",
        },
        null,
        2,
      ),
    );
  }

  const byStatus = await prisma.client.groupBy({
    by: ["status"],
    _count: true,
  });
  console.log("\n--- Clients by status ---");
  for (const row of byStatus.sort((a, b) => a.status.localeCompare(b.status))) {
    console.log(`  ${row.status}: ${row._count}`);
  }

  const recent = await prisma.client.findMany({
    orderBy: { updatedAt: "desc" },
    take: 15,
    select: {
      email: true,
      status: true,
      updatedAt: true,
      user: { select: { email: true } },
    },
  });
  console.log("\n--- Recent clients (last 15 by updatedAt) ---");
  for (const c of recent) {
    console.log(`  ${c.status} ${c.email} | owner: ${c.user.email} | updated ${c.updatedAt.toISOString()}`);
  }

  console.log("\n--- registration_email_outbox (last 20) ---");
  try {
    type OutboxRow = {
      kind: string;
      attempts: number;
      last_error: string | null;
      created_at: Date;
    };
    const rows = await prisma.$queryRaw<OutboxRow[]>`
      SELECT kind, attempts, last_error, created_at
      FROM registration_email_outbox
      ORDER BY created_at DESC
      LIMIT 20
    `;
    if (rows.length === 0) {
      console.log("(empty)");
    }
    for (const r of rows) {
      console.log(
        JSON.stringify({
          kind: r.kind,
          attempts: r.attempts,
          last_error: truncate(r.last_error, 240),
          created_at: r.created_at,
        }),
      );
    }
  } catch (e: unknown) {
    console.log("(skipped)", e instanceof Error ? e.message : String(e));
  }
};

const main = async (): Promise<void> => {
  const { ownerEmail, short, help } = parseCli();
  if (help) {
    printUsage();
    return;
  }
  if (short && !ownerEmail) {
    console.error("Error: --short requires --owner <email>\n");
    printUsage();
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const dbUrl = process.env.DATABASE_URL ?? "";
  const appBase = process.env.APP_BASE_URL ?? "(unset)";

  printEnv(dbUrl, appBase);

  if (ownerEmail) {
    await printOwnerEligibility(prisma, ownerEmail);
  }

  if (!short) {
    await printFullReport(prisma);
  }

  await prisma.$disconnect();
};

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
