/**
 * Emails created by integration/e2e helpers. Production principals must not
 * use these domains — the safety filter refuses to delete anything else.
 */
const TEST_PRINCIPAL_EMAIL_SUFFIXES = ["@test.com", "@plug.test", "@example.com"] as const;

export type PrismaTestPrincipalScope = "test" | "suite";

export interface PrismaTestPrincipalIds {
  readonly userIds?: readonly string[];
  readonly clientIds?: readonly string[];
  readonly agentIds?: readonly string[];
}

interface MutablePrincipalIds {
  userIds: Set<string>;
  clientIds: Set<string>;
  agentIds: Set<string>;
}

const testScope: MutablePrincipalIds = {
  userIds: new Set<string>(),
  clientIds: new Set<string>(),
  agentIds: new Set<string>(),
};

const suiteScope: MutablePrincipalIds = {
  userIds: new Set<string>(),
  clientIds: new Set<string>(),
  agentIds: new Set<string>(),
};

const scopeBucket = (scope: PrismaTestPrincipalScope): MutablePrincipalIds =>
  scope === "suite" ? suiteScope : testScope;

export const isTestPrincipalEmail = (email: string): boolean => {
  const normalized = email.trim().toLowerCase();
  return TEST_PRINCIPAL_EMAIL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
};

export const enablePrismaTestPrincipalCleanup = (): void => {
  process.env.VITEST_CLEANUP_PRISMA_TEST_DATA = "true";
};

export const shouldCleanupPrismaTestPrincipals = (): boolean =>
  process.env.CONTAINER_PERSISTENCE_MODE === "prisma" ||
  process.env.VITEST_CLEANUP_PRISMA_TEST_DATA === "true";

export const trackPrismaTestPrincipal = (input: {
  readonly scope?: PrismaTestPrincipalScope;
  readonly userId?: string;
  readonly clientId?: string;
  readonly agentId?: string;
}): void => {
  const bucket = scopeBucket(input.scope ?? "test");
  if (input.userId !== undefined && input.userId !== "") {
    bucket.userIds.add(input.userId);
  }
  if (input.clientId !== undefined && input.clientId !== "") {
    bucket.clientIds.add(input.clientId);
  }
  if (input.agentId !== undefined && input.agentId !== "") {
    bucket.agentIds.add(input.agentId);
  }
};

const snapshotAndClear = (bucket: MutablePrincipalIds): PrismaTestPrincipalIds => {
  const snapshot: PrismaTestPrincipalIds = {
    userIds: Array.from(bucket.userIds),
    clientIds: Array.from(bucket.clientIds),
    agentIds: Array.from(bucket.agentIds),
  };
  bucket.userIds.clear();
  bucket.clientIds.clear();
  bucket.agentIds.clear();
  return snapshot;
};

const hasIds = (ids: PrismaTestPrincipalIds): boolean =>
  (ids.userIds?.length ?? 0) > 0 ||
  (ids.clientIds?.length ?? 0) > 0 ||
  (ids.agentIds?.length ?? 0) > 0;

/**
 * Deletes tracked users/clients/agents from Prisma in FK-safe order.
 * Refuses to touch rows whose email (or agent owner email) is not a test domain.
 */
export const deletePrismaTestPrincipals = async (ids: PrismaTestPrincipalIds): Promise<void> => {
  const userIds = [...new Set(ids.userIds ?? [])].filter((id) => id !== "");
  const clientIds = [...new Set(ids.clientIds ?? [])].filter((id) => id !== "");
  const agentIds = [...new Set(ids.agentIds ?? [])].filter((id) => id !== "");
  if (userIds.length === 0 && clientIds.length === 0 && agentIds.length === 0) {
    return;
  }

  const { prismaClient } = await import("../../src/infrastructure/database/prisma/client");
  const [users, clients, agents] = await Promise.all([
    userIds.length === 0
      ? Promise.resolve([])
      : prismaClient.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true },
        }),
    clientIds.length === 0
      ? Promise.resolve([])
      : prismaClient.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, email: true },
        }),
    agentIds.length === 0
      ? Promise.resolve([])
      : prismaClient.agent.findMany({
          where: { agentId: { in: agentIds } },
          select: {
            agentId: true,
            agentIdentities: { select: { user: { select: { email: true } } } },
          },
        }),
  ]);

  const deletableUserIds = users.filter((row) => isTestPrincipalEmail(row.email)).map((row) => row.id);
  const deletableClientIds = clients
    .filter((row) => isTestPrincipalEmail(row.email))
    .map((row) => row.id);
  const deletableAgentIds = agents
    .filter((row) =>
      row.agentIdentities.every((identity) => isTestPrincipalEmail(identity.user.email)),
    )
    .map((row) => row.agentId);

  const accessWhere =
    deletableClientIds.length > 0 && deletableAgentIds.length > 0
      ? { OR: [{ clientId: { in: deletableClientIds } }, { agentId: { in: deletableAgentIds } }] }
      : deletableClientIds.length > 0
        ? { clientId: { in: deletableClientIds } }
        : deletableAgentIds.length > 0
          ? { agentId: { in: deletableAgentIds } }
          : undefined;

  if (accessWhere !== undefined) {
    await prismaClient.clientAgentAccess.deleteMany({ where: accessWhere });
    await prismaClient.clientAgentAccessRequest.deleteMany({ where: accessWhere });
  }

  if (deletableClientIds.length > 0) {
    await prismaClient.client.deleteMany({ where: { id: { in: deletableClientIds } } });
  }

  if (deletableAgentIds.length > 0) {
    await prismaClient.agentIdentity.deleteMany({
      where: { agentId: { in: deletableAgentIds } },
    });
    await prismaClient.agent.updateMany({
      where: { agentId: { in: deletableAgentIds }, lastLoginUserId: { not: null } },
      data: { lastLoginUserId: null },
    });
    await prismaClient.agent.deleteMany({ where: { agentId: { in: deletableAgentIds } } });
  }

  if (deletableUserIds.length > 0) {
    await prismaClient.user.deleteMany({ where: { id: { in: deletableUserIds } } });
  }
};

const flushScope = async (bucket: MutablePrincipalIds): Promise<void> => {
  const snapshot = snapshotAndClear(bucket);
  if (!hasIds(snapshot) || !shouldCleanupPrismaTestPrincipals()) {
    return;
  }
  await deletePrismaTestPrincipals(snapshot);
};

export const cleanupTrackedTestScopePrincipals = async (): Promise<void> => {
  await flushScope(testScope);
};

export const cleanupTrackedSuiteScopePrincipals = async (): Promise<void> => {
  await flushScope(suiteScope);
};
