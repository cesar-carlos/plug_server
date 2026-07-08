import { PrismaClient } from "@prisma/client";

import { signAccessToken } from "../../../src/shared/utils/jwt";
import { connectConsumerSocket } from "./consumer_socket";

const DEFAULT_LIVE_HUB_URL = "https://plug-server.se7esistemassinop.com.br";

export type E2ELiveHubFixture = {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly ownerAccessToken: string;
  readonly clientId: string;
  readonly clientAccessToken: string;
  /** Agent-side authorization token (`sql.execute params.client_token`), when provided. */
  readonly agentClientToken: string | undefined;
  readonly prisma: PrismaClient;
  readonly close: () => Promise<void>;
};

const resolveLiveHubUrl = (): string =>
  (process.env.E2E_LIVE_HUB_URL ?? DEFAULT_LIVE_HUB_URL).replace(/\/$/, "");

const resolveLiveAgentId = (): string => {
  const agentId = process.env.E2E_LIVE_AGENT_ID?.trim();
  if (!agentId) {
    throw new Error("E2E_LIVE_AGENT_ID is required for live-server E2E tests.");
  }
  return agentId;
};

const waitForReady = async (baseUrl: string): Promise<void> => {
  const deadlineAt = Date.now() + 15_000;
  let lastError = "unknown";

  while (Date.now() < deadlineAt) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (response.ok) {
        return;
      }
      lastError = `health/ready returned ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for live hub readiness: ${lastError}`);
};

/** Live hub fixture: real server URL, fixed agentId, JWTs signed from Prisma rows. */
export const startE2ELiveHubFixture = async (): Promise<E2ELiveHubFixture> => {
  const baseUrl = resolveLiveHubUrl();
  const agentId = resolveLiveAgentId();
  const prisma = new PrismaClient({ log: ["error"] });

  await waitForReady(baseUrl);

  const identity = await prisma.agentIdentity.findUnique({
    where: { agentId },
    include: { user: true },
  });
  if (!identity) {
    await prisma.$disconnect();
    throw new Error(`Agent ${agentId} has no owner identity in the database.`);
  }

  const clientAccess = await prisma.clientAgentAccess.findFirst({
    where: { agentId },
    include: { client: true },
    orderBy: { approvedAt: "asc" },
  });
  if (!clientAccess) {
    await prisma.$disconnect();
    throw new Error(`Agent ${agentId} has no approved client access row.`);
  }

  const owner = identity.user;
  const client = clientAccess.client;

  const ownerAccessToken = signAccessToken({
    sub: owner.id,
    email: owner.email,
    role: owner.role,
    principal_type: "user",
    credentials_version: owner.credentialsUpdatedAt.getTime(),
    tokenType: "access",
  });

  const clientAccessToken = signAccessToken({
    sub: client.id,
    email: client.email,
    role: "client",
    principal_type: "client",
    credentials_version: client.credentialsUpdatedAt.getTime(),
    tokenType: "access",
  });

  const agentClientToken =
    process.env.E2E_LIVE_CLIENT_TOKEN?.trim() || clientAccess.clientToken || undefined;

  return {
    baseUrl,
    agentId,
    ownerUserId: owner.id,
    clientId: client.id,
    ownerAccessToken,
    clientAccessToken,
    agentClientToken,
    prisma,
    close: async () => {
      await prisma.$disconnect();
    },
  };
};

export { connectConsumerSocket };
