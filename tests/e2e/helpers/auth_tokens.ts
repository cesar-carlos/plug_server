import request from "supertest";

import {
  trackPrismaTestPrincipal,
  type PrismaTestPrincipalScope,
} from "../../helpers/prisma_test_principal_cleanup";
import { approveClientRegistrationByToken } from "../../integration/helpers/approve_client_registration";
import { approveRegistrationByToken } from "../../integration/helpers/approve_registration";

export interface HubUserTokens {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
}

export interface HubClientTokens {
  readonly clientId: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export const registerHubUser = async (
  baseUrl: string,
  email: string,
  password: string,
  options?: { readonly cleanupScope?: PrismaTestPrincipalScope },
): Promise<HubUserTokens> => {
  const res = await request(baseUrl).post("/api/v1/auth/register").send({ email, password });
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const approvalToken = res.body.approvalToken as string | undefined;
  if (!approvalToken) {
    throw new Error(
      "register response missing approvalToken; e2e expects NODE_ENV !== production (see registration flow).",
    );
  }
  const userId = res.body.user.id as string;
  await approveRegistrationByToken(baseUrl, approvalToken);
  const loginRes = await request(baseUrl).post("/api/v1/auth/login").send({ email, password });
  if (loginRes.status !== 200) {
    throw new Error(
      `login after register failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`,
    );
  }
  trackPrismaTestPrincipal({
    scope: options?.cleanupScope ?? "test",
    userId,
  });
  return {
    userId,
    email,
    password,
    accessToken: loginRes.body.accessToken as string,
  };
};

export const agentLoginToken = async (
  baseUrl: string,
  email: string,
  password: string,
  agentId: string,
): Promise<string> => {
  const res = await request(baseUrl).post("/api/v1/auth/agent-login").send({
    email,
    password,
    agentId,
  });
  if (res.status !== 200) {
    throw new Error(`agent-login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
};

export const registerHubClient = async (
  baseUrl: string,
  ownerEmail: string,
  email: string,
  password: string,
  options?: { readonly cleanupScope?: PrismaTestPrincipalScope },
): Promise<HubClientTokens> => {
  const registerRes = await request(baseUrl).post("/api/v1/client-auth/register").send({
    ownerEmail,
    email,
    password,
    name: "E2E",
    lastName: "Client",
  });
  if (registerRes.status !== 201) {
    throw new Error(
      `client register failed: ${registerRes.status} ${JSON.stringify(registerRes.body)}`,
    );
  }
  const approvalToken = registerRes.body.approvalToken as string | undefined;
  if (!approvalToken) {
    throw new Error(
      "client register response missing approvalToken; e2e expects NODE_ENV !== production.",
    );
  }

  await approveClientRegistrationByToken(baseUrl, approvalToken);

  const loginRes = await request(baseUrl)
    .post("/api/v1/client-auth/login")
    .send({ email, password });
  if (loginRes.status !== 200) {
    throw new Error(`client login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  const clientId = registerRes.body.client.id as string;
  trackPrismaTestPrincipal({
    scope: options?.cleanupScope ?? "test",
    clientId,
  });

  return {
    clientId,
    email,
    password,
    accessToken: loginRes.body.accessToken as string,
    refreshToken: loginRes.body.refreshToken as string,
  };
};
