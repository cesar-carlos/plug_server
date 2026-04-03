import { access, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { User } from "../../src/domain/entities/user.entity";
import { env } from "../../src/shared/config/env";
import { getTestNoopEmailSender, getTestRepositoryAccess } from "../../src/shared/di/container";
import {
  registerOwnerSession,
  registerOwnerAndClientSession,
} from "./helpers/client_sessions";

const app = createApp();
const repositories = getTestRepositoryAccess();
const noopEmailSender = getTestNoopEmailSender();

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

  it("updates authenticated client profile from /api/v1/client-auth/me", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-patch-me`,
    });

    const patchResponse = await request(app)
      .patch("/api/v1/client-auth/me")
      .set("Authorization", `Bearer ${client.accessToken}`)
      .send({
        name: "Updated",
        lastName: "Client",
        mobile: "+55 (11) 91234-5678",
      });
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.client).toMatchObject({
      id: client.clientId,
      name: "Updated",
      lastName: "Client",
      mobile: "+5511912345678",
    });
  });

  it("rejects direct thumbnail URL updates in /api/v1/client-auth/me", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-patch-thumbnail-url`,
    });

    const response = await request(app)
      .patch("/api/v1/client-auth/me")
      .set("Authorization", `Bearer ${client.accessToken}`)
      .send({
        thumbnailUrl: "https://cdn.example.com/clients/updated.png",
      });

    expect(response.status).toBe(400);
  });

  it("changes authenticated client password and revokes previous refresh token", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-change-password`,
    });
    const newPassword = "ClientNewPass1";

    const response = await request(app)
      .patch("/api/v1/client-auth/password")
      .set("Authorization", `Bearer ${client.accessToken}`)
      .send({
        currentPassword: client.password,
        newPassword,
      });
    expect(response.status).toBe(204);

    const oldAccessOnMe = await request(app)
      .get("/api/v1/client-auth/me")
      .set("Authorization", `Bearer ${client.accessToken}`);
    expect(oldAccessOnMe.status).toBe(401);

    const oldLogin = await request(app).post("/api/v1/client-auth/login").send({
      email: client.email,
      password: client.password,
    });
    expect(oldLogin.status).toBe(401);

    const refreshAfterChange = await request(app)
      .post("/api/v1/client-auth/refresh")
      .send({ refreshToken: client.refreshToken });
    expect(refreshAfterChange.status).toBe(401);

    const newLogin = await request(app).post("/api/v1/client-auth/login").send({
      email: client.email,
      password: newPassword,
    });
    expect(newLogin.status).toBe(200);
  });

  it("uploads thumbnail file for authenticated client", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-thumbnail-upload`,
    });
    // 1x1 transparent PNG
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2x0AAAAASUVORK5CYII=",
      "base64",
    );

    const response = await request(app)
      .post("/api/v1/client-auth/thumbnail")
      .set("Authorization", `Bearer ${client.accessToken}`)
      .attach("thumbnail", tinyPng, {
        filename: "thumbnail.png",
        contentType: "image/png",
      });

    expect(response.status).toBe(200);
    expect(response.body.client.thumbnailUrl).toContain("/uploads/client-thumbnails/");
    expect(response.body.client.thumbnailUrl).toMatch(/\.webp$/);

    const savedPath = resolveUploadPathFromUrl(response.body.client.thumbnailUrl as string);
    await access(savedPath);
    const metadata = await sharp(await readFile(savedPath)).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(env.clientThumbnailWidth);
    expect(metadata.height).toBe(env.clientThumbnailHeight);
  });

  it("rejects invalid thumbnail payload even with image mime type", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-thumbnail-invalid`,
    });

    const response = await request(app)
      .post("/api/v1/client-auth/thumbnail")
      .set("Authorization", `Bearer ${client.accessToken}`)
      .attach("thumbnail", Buffer.from("not-a-real-image"), {
        filename: "invalid.png",
        contentType: "image/png",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("BAD_REQUEST");
  });
});

describe("Client auth password recovery flow", () => {
  it("returns generic response for unknown email", async () => {
    const beforeCount = noopEmailSender.clientPasswordRecovery.length;

    const response = await request(app)
      .post("/api/v1/client-auth/password-recovery/request")
      .send({ email: `missing-${Date.now()}@test.com` });

    expect(response.status).toBe(202);
    expect(noopEmailSender.clientPasswordRecovery.length).toBe(beforeCount);
  });

  it("sends recovery email and resets password with token", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-password-recovery`,
    });
    const newPassword = "ClientRecover2";
    const beforeCount = noopEmailSender.clientPasswordRecovery.length;

    const requestResponse = await request(app)
      .post("/api/v1/client-auth/password-recovery/request")
      .send({ email: client.email });
    expect(requestResponse.status).toBe(202);
    expect(noopEmailSender.clientPasswordRecovery.length).toBe(beforeCount + 1);
    const token = noopEmailSender.clientPasswordRecovery.at(-1)?.recoveryToken;
    expect(token).toEqual(expect.any(String));
    if (!token) {
      throw new Error("Expected recovery token to be generated");
    }

    const statusResponse = await request(app)
      .get("/api/v1/client-auth/password-recovery/status")
      .query({ token });
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.status).toBe("pending");

    const resetResponse = await request(app)
      .post("/api/v1/client-auth/password-recovery/reset")
      .send({ token, newPassword });
    expect(resetResponse.status).toBe(204);

    const oldAccessOnMe = await request(app)
      .get("/api/v1/client-auth/me")
      .set("Authorization", `Bearer ${client.accessToken}`);
    expect(oldAccessOnMe.status).toBe(401);

    const oldLogin = await request(app).post("/api/v1/client-auth/login").send({
      email: client.email,
      password: client.password,
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post("/api/v1/client-auth/login").send({
      email: client.email,
      password: newPassword,
    });
    expect(newLogin.status).toBe(200);

    const reuseResponse = await request(app)
      .post("/api/v1/client-auth/password-recovery/reset")
      .send({ token, newPassword: "AnotherPass2" });
    expect(reuseResponse.status).toBe(404);
  });

  it("returns 404 for missing password recovery token", async () => {
    const response = await request(app)
      .get("/api/v1/client-auth/password-recovery/status")
      .query({ token: "missing-password-recovery-token-012345678901234567890" });

    expect(response.status).toBe(404);
  });

  it("returns 410 for expired password recovery token", async () => {
    const { client } = await registerOwnerAndClientSession(app, {
      suffix: `${Date.now()}-password-recovery-expired`,
    });

    const expiredToken = "expired-password-recovery-token-0123456789012345678";
    await repositories.clientPasswordRecoveryToken.save({
      id: expiredToken,
      clientId: client.clientId,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });

    const statusResponse = await request(app)
      .get("/api/v1/client-auth/password-recovery/status")
      .query({ token: expiredToken });
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.status).toBe("expired");

    const resetResponse = await request(app)
      .post("/api/v1/client-auth/password-recovery/reset")
      .send({ token: expiredToken, newPassword: "ClientRecover2" });
    expect(resetResponse.status).toBe(410);
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

const resolveUploadPathFromUrl = (url: string): string => {
  const publicBase = new URL(env.uploadsPublicBaseUrl);
  const fileUrl = new URL(url);
  const relativePath = fileUrl.pathname.replace(publicBase.pathname.replace(/\/+$/, ""), "").replace(/^\/+/, "");
  return path.resolve(env.uploadsDir, relativePath);
};
