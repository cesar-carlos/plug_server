import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { agentLoginToken, registerHubUser } from "./auth_tokens";
import { createTestServer } from "./e2e_server";

export type E2EHubFixture = {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly user: Awaited<ReturnType<typeof registerHubUser>>;
  readonly agentAccessToken: string;
  readonly close: () => Promise<void>;
};

const waitForReady = async (baseUrl: string): Promise<void> => {
  const deadlineAt = Date.now() + 10_000;
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
    await delay(100);
  }

  throw new Error(`Timed out waiting for E2E server readiness: ${lastError}`);
};

/** HTTP + Socket.IO server, user + agent-login tokens, unique `agentId` (Prisma/register). */
export const startE2EHubFixture = async (): Promise<E2EHubFixture> => {
  const server = await createTestServer();
  const baseUrl = server.getUrl();
  await waitForReady(baseUrl);
  const agentId = randomUUID();
  const email = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}@plug.test`;
  const user = await registerHubUser(baseUrl, email, "E2eHubFixture1");
  const agentAccessToken = await agentLoginToken(baseUrl, user.email, user.password, agentId);

  return {
    baseUrl,
    agentId,
    user,
    agentAccessToken,
    close: () => server.close(),
  };
};
