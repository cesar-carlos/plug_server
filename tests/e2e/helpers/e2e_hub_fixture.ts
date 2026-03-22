import { randomUUID } from "node:crypto";

import { agentLoginToken, registerHubUser } from "./auth_tokens";
import { createTestServer } from "./e2e_server";

export type E2EHubFixture = {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly user: Awaited<ReturnType<typeof registerHubUser>>;
  readonly agentAccessToken: string;
  readonly close: () => Promise<void>;
};

/** HTTP + Socket.IO server, user + agent-login tokens, unique `agentId` (Prisma/register). */
export const startE2EHubFixture = async (): Promise<E2EHubFixture> => {
  const server = await createTestServer();
  const baseUrl = server.getUrl();
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
