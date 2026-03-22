import request from "supertest";

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
  return {
    email,
    password,
    accessToken: res.body.accessToken as string,
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
