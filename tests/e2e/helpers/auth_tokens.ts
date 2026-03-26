import request from "supertest";

import { approveRegistrationByToken } from "../../integration/helpers/approve_registration";

export interface HubUserTokens {
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
}

export const registerHubUser = async (
  baseUrl: string,
  email: string,
  password: string,
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
  await approveRegistrationByToken(baseUrl, approvalToken);
  const loginRes = await request(baseUrl).post("/api/v1/auth/login").send({ email, password });
  if (loginRes.status !== 200) {
    throw new Error(`login after register failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  return {
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
