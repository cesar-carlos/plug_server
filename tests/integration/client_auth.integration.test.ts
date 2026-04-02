import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { User } from "../../src/domain/entities/user.entity";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { approveRegistrationByToken } from "./helpers/approve_registration";

const app = createApp();
const repositories = getTestRepositoryAccess();

const registerOwner = async (suffix: string): Promise<{ userId: string; email: string }> => {
  const email = `client-owner-${suffix}@test.com`;
  const password = "OwnerClientReg1";
  const registerRes = await request(app).post("/api/v1/auth/register").send({ email, password });
  expect(registerRes.status).toBe(201);
  await approveRegistrationByToken(app, registerRes.body.approvalToken as string);
  return {
    userId: registerRes.body.user.id as string,
    email,
  };
};

describe("Client auth registration approval flow", () => {
  it("creates pending client registration for a valid owner email", async () => {
    const owner = await registerOwner(`${Date.now()}-a`);
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
    const owner = await registerOwner(`${Date.now()}-b`);
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
    const owner = await registerOwner(`${Date.now()}-c`);
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
    const owner = await registerOwner(`${Date.now()}-d`);
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
    const owner = await registerOwner(`${Date.now()}-e`);
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
    const owner = await registerOwner(`${Date.now()}-f`);
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
