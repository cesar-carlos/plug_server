import request from "supertest";

import { approveClientRegistrationByToken } from "./approve_client_registration";
import { approveRegistrationByToken } from "./approve_registration";

export interface RegisteredOwnerSession {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
}

export interface RegisteredClientSession {
  readonly clientId: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface RegisteredOwnerAndClientSession {
  readonly owner: RegisteredOwnerSession;
  readonly client: RegisteredClientSession;
}

const uniqueSuffix = (): string => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

export const registerOwnerSession = async (
  httpTarget: Parameters<typeof request>[0],
  options?: {
    readonly suffix?: string;
    readonly emailPrefix?: string;
    readonly password?: string;
  },
): Promise<RegisteredOwnerSession> => {
  const suffix = options?.suffix ?? uniqueSuffix();
  const email = `${options?.emailPrefix ?? "client-owner"}-${suffix}@test.com`;
  const password = options?.password ?? "OwnerClientReg1";

  const registerRes = await request(httpTarget).post("/api/v1/auth/register").send({ email, password });
  if (registerRes.status !== 201) {
    throw new Error(`owner register failed: ${registerRes.status} ${registerRes.text}`);
  }
  await approveRegistrationByToken(httpTarget, registerRes.body.approvalToken as string);

  const loginRes = await request(httpTarget).post("/api/v1/auth/login").send({ email, password });
  if (loginRes.status !== 200) {
    throw new Error(`owner login failed: ${loginRes.status} ${loginRes.text}`);
  }

  return {
    userId: registerRes.body.user.id as string,
    email,
    password,
    accessToken: loginRes.body.accessToken as string,
  };
};

export const registerApprovedClientSession = async (
  httpTarget: Parameters<typeof request>[0],
  ownerEmail: string,
  options?: {
    readonly suffix?: string;
    readonly emailPrefix?: string;
    readonly password?: string;
    readonly name?: string;
    readonly lastName?: string;
  },
): Promise<RegisteredClientSession> => {
  const suffix = options?.suffix ?? uniqueSuffix();
  const email = `${options?.emailPrefix ?? "client"}-${suffix}@test.com`;
  const password = options?.password ?? "Client1234";

  const registerRes = await request(httpTarget).post("/api/v1/client-auth/register").send({
    ownerEmail,
    email,
    password,
    name: options?.name ?? "Client",
    lastName: options?.lastName ?? "Viewer",
  });
  if (registerRes.status !== 201) {
    throw new Error(`client register failed: ${registerRes.status} ${registerRes.text}`);
  }
  await approveClientRegistrationByToken(httpTarget, registerRes.body.approvalToken as string);

  const loginRes = await request(httpTarget).post("/api/v1/client-auth/login").send({ email, password });
  if (loginRes.status !== 200) {
    throw new Error(`client login failed: ${loginRes.status} ${loginRes.text}`);
  }

  return {
    clientId: registerRes.body.client.id as string,
    email,
    password,
    accessToken: loginRes.body.accessToken as string,
    refreshToken: loginRes.body.refreshToken as string,
  };
};

export const registerOwnerAndClientSession = async (
  httpTarget: Parameters<typeof request>[0],
  options?: {
    readonly suffix?: string;
  },
): Promise<RegisteredOwnerAndClientSession> => {
  const suffix = options?.suffix ?? uniqueSuffix();
  const owner = await registerOwnerSession(httpTarget, { suffix, emailPrefix: "client-owner" });
  const client = await registerApprovedClientSession(httpTarget, owner.email, {
    suffix,
    emailPrefix: "client",
  });

  return {
    owner,
    client,
  };
};
