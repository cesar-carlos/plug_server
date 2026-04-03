import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { User } from "../../src/domain/entities/user.entity";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import {
  registerOwnerSession,
  registerOwnerAndClientSession,
} from "./helpers/client_sessions";

const app = createApp();
const repositories = getTestRepositoryAccess();

describe("Client auth registration approval flow", () => {
  it("creates pending client registration for a valid owner email", async () => {
    const owner = await registerOwnerSession(app, { suffix: `${Date.now()}-a`, emailPrefix: "client-owner" });
    const response = await request(app).post("/api/v1/client-auth/register").send({
      ownerEmail: owner.email,
      email: `pending-client-${Date.now()}@test.com`,
      password: "ClientRegPwd1",
      name: "Pending",
      lastName: "Client",
    });

    expect(response.status).toBe(201);
    expect(response.body.message).toBe("Client registration pending owner approval");
    expect(response.body.client.status).toBe("pending");
    expect(response.body.client.userId).toBe(owner.userId);
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
    expect(response.body.approvalToken).toBeDefined();
  });

  it("denies login while client registration is pending", async () => {
    const owner = await registerOwnerSession(app, { suffix: `${Date.now()}-b`, emailPrefix: "client-owner" });
    const email = `pending-login-${Date.now()}@test.com`;
    const password = "ClientRegPwd1";

    const registerRes = await request(app).post("/api/v1/client-auth/register").send({
      ownerEmail: owner.email,
      email,
      password,
      name: "PendingLogin",
      lastName: "Client",
    });
    expect(registerRes.status).toBe(201);

    const loginRes = await request(app).post("/api/v1/client-auth/login").send({ email, password });
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.code).toBe("FORBIDDEN");
  });

  it("activates pending client after approval token and allows login", async () => {
    const owner = await registerOwnerSession(app, { suffix: `${Date.now()}-c`, emailPrefix: "client-owner" });
    const email = `approved-client-${Date.now()}@test.com`;
    const password = "ClientRegPwd1";

    const registerRes = await request(app).post("/api/v1/client-auth/register").send({
      ownerEmail: owner.email,
      email,
      password,
      name: "Approved",
      lastName: "Client",
    });
    expect(registerRes.status).toBe(201);

    const approveRes = await request(app)
      .post("/api/v1/client-auth/registration/approve")
      .send({ token: registerRes.body.approvalToken });
    expect(approveRes.status).toBe(200);

    const loginRes = await request(app).post("/api/v1/client-auth/login").send({ email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.accessToken).toBeDefined();
  });

  it("returns 400 when owner email is not eligible", async () => {
    const response = await request(app).post("/api/v1/client-auth/register").send({
      ownerEmail: `missing-owner-${Date.now()}@test.com`,
      email: `missing-owner-client-${Date.now()}@test.com`,
      password: "ClientRegPwd1",
      name: "Missing",
      lastName: "Owner",
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("BAD_REQUEST");
  });

  it("returns same public validation response when owner user is not active", async () => {
    const owner = await registerOwnerSession(app, { suffix: `${Date.now()}-d`, emailPrefix: "client-owner" });
    const currentOwner = await repositories.user.findById(owner.userId);
    expect(currentOwner).not.toBeNull();
    await repositories.user.save(
      User.create({
        id: currentOwner!.id,
        email: currentOwner!.email,
        passwordHash: currentOwner!.passwordHash,
        role: currentOwner!.role,
        status: "blocked",
        createdAt: currentOwner!.createdAt,
        ...(currentOwner!.celular !== undefined ? { celular: currentOwner!.celular } : {}),
      }),
    );

    const response = await request(app).post("/api/v1/client-auth/register").send({
      ownerEmail: owner.email,
      email: `blocked-owner-client-${Date.now()}@test.com`,
      password: "ClientRegPwd1",
      name: "Blocked",
      lastName: "Owner",
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("BAD_REQUEST");
  });

  it("keeps client blocked after rejection and token cannot be reused", async () => {
    const owner = await registerOwnerSession(app, { suffix: `${Date.now()}-e`, emailPrefix: "client-owner" });
    const email = `rejected-client-${Date.now()}@test.com`;
    const password = "ClientRegPwd1";

    const registerRes = await request(app).post("/api/v1/client-auth/register").send({
      ownerEmail: owner.email,
      email,
      password,
      name: "Rejected",
      lastName: "Client",
    });
    expect(registerRes.status).toBe(201);
    const token = registerRes.body.approvalToken as string;

    const rejectRes = await request(app)
      .post("/api/v1/client-auth/registration/reject")
      .send({ token, reason: "Not approved" });
    expect(rejectRes.status).toBe(200);

    const loginRes = await request(app).post("/api/v1/client-auth/login").send({ email, password });
    expect(loginRes.status).toBe(403);

    const secondApprove = await request(app).post("/api/v1/client-auth/registration/approve").send({ token });
    expect(secondApprove.status).toBe(404);
  });

  it("returns expired status and blocks approve when registration token is expired", async () => {
    const owner = await registerOwnerSession(app, { suffix: `${Date.now()}-f`, emailPrefix: "client-owner" });
    const email = `expired-token-client-${Date.now()}@test.com`;
    const registerRes = await request(app).post("/api/v1/client-auth/register").send({
      ownerEmail: owner.email,
      email,
      password: "ClientRegPwd1",
      name: "Expired",
      lastName: "Token",
    });
    expect(registerRes.status).toBe(201);

    const clientId = registerRes.body.client.id as string;
    const expiredToken = "expired-client-reg-token-0123456789";
    await repositories.clientRegistrationApprovalToken.save({
      id: expiredToken,
      clientId,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });

    const statusRes = await request(app)
      .get("/api/v1/client-auth/registration/status")
      .query({ token: expiredToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("expired");

    const approveRes = await request(app)
      .post("/api/v1/client-auth/registration/approve")
      .send({ token: expiredToken });
    expect(approveRes.status).toBe(410);
    expect(approveRes.body.code).toBe("REGISTRATION_TOKEN_EXPIRED");
  });
});

describe("Client auth authenticated session flow", () => {
  it("returns current client profile from /api/v1/client-auth/me", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-me`,
    });

    const response = await request(app)
      .get("/api/v1/client-auth/me")
      .set("Authorization", `Bearer ${client.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.client).toMatchObject({
      id: client.clientId,
      email: client.email,
      role: "client",
      status: "active",
    });
  });

  it("rotates client refresh token and rejects reuse of the previous token", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-refresh`,
    });
    const firstRefreshToken = client.refreshToken;

    const rotateResponse = await request(app)
      .post("/api/v1/client-auth/refresh")
      .send({ refreshToken: firstRefreshToken });
    expect(rotateResponse.status).toBe(200);
    expect(rotateResponse.body.accessToken).toBeDefined();
    expect(rotateResponse.body.refreshToken).toBeDefined();

    const reuseResponse = await request(app)
      .post("/api/v1/client-auth/refresh")
      .send({ refreshToken: firstRefreshToken });
    expect(reuseResponse.status).toBe(401);
  });

  it("refreshes client session when refresh token is sent via cookie", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-refresh-cookie`,
    });

    const response = await request(app)
      .post("/api/v1/client-auth/refresh")
      .set("Cookie", [`client_refresh_token=${client.refreshToken}`])
      .send({});
    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeDefined();
    expect(response.body.refreshToken).toBeDefined();
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("revokes client refresh token on logout", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-logout`,
    });

    const logoutResponse = await request(app)
      .post("/api/v1/client-auth/logout")
      .send({ refreshToken: client.refreshToken });
    expect(logoutResponse.status).toBe(204);

    const refreshAfterLogout = await request(app)
      .post("/api/v1/client-auth/refresh")
      .send({ refreshToken: client.refreshToken });
    expect(refreshAfterLogout.status).toBe(401);
  });

  it("revokes client refresh token on logout when token is sent via cookie", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-logout-cookie`,
    });

    const logoutResponse = await request(app)
      .post("/api/v1/client-auth/logout")
      .set("Cookie", [`client_refresh_token=${client.refreshToken}`])
      .send({});
    expect(logoutResponse.status).toBe(204);
    expect(responseClearsCookie(logoutResponse.headers["set-cookie"])).toBe(true);

    const refreshAfterLogout = await request(app)
      .post("/api/v1/client-auth/refresh")
      .send({ refreshToken: client.refreshToken });
    expect(refreshAfterLogout.status).toBe(401);
  });
});

const responseClearsCookie = (setCookieHeader: string[] | string | undefined): boolean => {
  const values = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : typeof setCookieHeader === "string"
      ? [setCookieHeader]
      : [];
  return values.some((value) => value.startsWith("client_refresh_token="));
};
