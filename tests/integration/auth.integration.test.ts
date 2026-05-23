import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { User } from "../../src/domain/entities/user.entity";
import { getTestNoopEmailSender, getTestRepositoryAccess } from "../../src/shared/di/container";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();

const testUser = {
  email: "integration@test.com",
  password: "Integration1",
};
const repositories = getTestRepositoryAccess();
const emailSender = getTestNoopEmailSender();

let accessToken = "";
let refreshToken = "";

describe("Auth API", () => {
  // ─── Register ──────────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/register", () => {
    it("should register as pending, then allow login after admin approval", async () => {
      const response = await request(app).post("/api/v1/auth/register").send(testUser);

      expect(response.status).toBe(201);
      expect(response.body.message).toBeDefined();
      expect(response.body.user).toMatchObject({
        email: testUser.email,
        role: "user",
        status: "pending",
      });
      expect(response.body.user.id).toBeDefined();
      expect(response.body.approvalToken).toBeDefined();
      expect(response.body).not.toHaveProperty("accessToken");
      expect(response.body.user).not.toHaveProperty("passwordHash");

      await approveRegistrationByToken(app, response.body.approvalToken as string);

      const loginResponse = await request(app).post("/api/v1/auth/login").send(testUser);
      expect(loginResponse.status).toBe(200);
      accessToken = loginResponse.body.accessToken as string;
      refreshToken = loginResponse.body.refreshToken as string;
    });

    it("should return 409 when email is already registered", async () => {
      const response = await request(app).post("/api/v1/auth/register").send(testUser);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("CONFLICT");
    });

    it("should return 400 for invalid email", async () => {
      const response = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: "not-an-email", password: "Password1" });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for a weak password", async () => {
      const response = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: "weak@test.com", password: "simple" });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 409 when celular is already registered", async () => {
      const phone = "11987654321";
      const first = await request(app)
        .post("/api/v1/auth/register")
        .send({
          email: `dup-phone-a-${Date.now()}@test.com`,
          password: "Password1",
          celular: phone,
        });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/v1/auth/register")
        .send({
          email: `dup-phone-b-${Date.now()}@test.com`,
          password: "Password1",
          celular: phone,
        });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe("CONFLICT");
      expect(String(second.body.message)).toContain("Phone");
    });
  });

  describe("HTTP email validation (registration retry and login)", () => {
    it("returns 400 for invalid email on registration retry", async () => {
      const response = await request(app)
        .post("/api/v1/auth/registration/retry")
        .send({ email: "not-an-email", password: "RetryReg1" });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Registration approval (POST + review page)", () => {
    it("GET /api/v1/auth/registration/status returns pending for a valid token", async () => {
      const reg = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: `status-flow-${Date.now()}@test.com`, password: "StatusFlow1" });
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const st = await request(app).get("/api/v1/auth/registration/status").query({ token });
      expect(st.status).toBe(200);
      expect(st.body.status).toBe("pending");
    });

    it("GET /api/v1/auth/registration/review returns HTML with POST forms only", async () => {
      const email = `review-page-${Date.now()}@test.com`;
      const reg = await request(app)
        .post("/api/v1/auth/register")
        .send({ email, password: "ReviewPage1" });
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const page = await request(app).get("/api/v1/auth/registration/review").query({ token });
      expect(page.status).toBe(200);
      expect(page.text).toContain('method="post"');
      expect(page.text).toContain("/api/v1/auth/registration/approve");
      expect(page.text).toContain("/api/v1/auth/registration/reject");
      expect(page.text).toContain(email);

      const status = await request(app).get("/api/v1/auth/registration/status").query({ token });
      expect(status.status).toBe(200);
      expect(status.body.status).toBe("pending");
    });

    it("POST /api/v1/auth/registration/approve allows opaque Origin (email webviews)", async () => {
      const email = `origin-null-user-${Date.now()}@test.com`;
      const password = "OriginNullUser1";
      const reg = await request(app).post("/api/v1/auth/register").send({ email, password });
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const approve = await request(app)
        .post("/api/v1/auth/registration/approve")
        .set("Origin", "null")
        .send({ token });
      expect(approve.status).toBe(200);

      const login = await request(app).post("/api/v1/auth/login").send({ email, password });
      expect(login.status).toBe(200);
    });

    it("OPTIONS /api/v1/auth/registration/approve CORS preflight allows opaque Origin", async () => {
      const response = await request(app)
        .options("/api/v1/auth/registration/approve")
        .set("Origin", "null")
        .set("Access-Control-Request-Method", "POST");

      expect(response.status).toBe(204);
    });

    it("POST /api/v1/auth/registration/reject allows opaque Origin (email webviews)", async () => {
      const rejectedUser = {
        email: `reject-origin-null-${Date.now()}@test.com`,
        password: "RejectOrig1",
      };
      const reg = await request(app).post("/api/v1/auth/register").send(rejectedUser);
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const reject = await request(app)
        .post("/api/v1/auth/registration/reject")
        .set("Origin", "null")
        .send({ token, reason: "Opaque origin regression test" });
      expect(reject.status).toBe(200);
      expect(reject.text).toContain("Registration rejected");
      expect(reject.text).toContain(rejectedUser.email);

      const login = await request(app).post("/api/v1/auth/login").send(rejectedUser);
      expect(login.status).toBe(403);
      expect(login.body.code).toBe("FORBIDDEN");
    });

    it("OPTIONS /api/v1/auth/registration/reject CORS preflight allows opaque Origin", async () => {
      const response = await request(app)
        .options("/api/v1/auth/registration/reject")
        .set("Origin", "null")
        .set("Access-Control-Request-Method", "POST");

      expect(response.status).toBe(204);
    });

    it("second POST /registration/approve with same token returns 404", async () => {
      const reg = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: `double-approve-${Date.now()}@test.com`, password: "DoubleTap1" });
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const first = await request(app).post("/api/v1/auth/registration/approve").send({ token });
      expect(first.status).toBe(200);
      const second = await request(app).post("/api/v1/auth/registration/approve").send({ token });
      expect(second.status).toBe(404);
    });

    it("concurrent approve/approve for the same registration token has one winner", async () => {
      const credentials = {
        email: `concurrent-approve-${Date.now()}@test.com`,
        password: "Concurrent1",
      };
      const reg = await request(app).post("/api/v1/auth/register").send(credentials);
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const [first, second] = await Promise.all([
        request(app).post("/api/v1/auth/registration/approve").send({ token }),
        request(app).post("/api/v1/auth/registration/approve").send({ token }),
      ]);

      const statuses = [first.status, second.status];
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses).toContain(404);
      expect(await repositories.registrationApprovalToken.findById(token)).toBeNull();

      const login = await request(app).post("/api/v1/auth/login").send(credentials);
      expect(login.status).toBe(200);
    });

    it("concurrent approve/reject for the same registration token has one winner", async () => {
      const credentials = {
        email: `concurrent-decision-${Date.now()}@test.com`,
        password: "Concurrent2",
      };
      const reg = await request(app).post("/api/v1/auth/register").send(credentials);
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;
      const userId = reg.body.user.id as string;

      const [approve, reject] = await Promise.all([
        request(app).post("/api/v1/auth/registration/approve").send({ token }),
        request(app).post("/api/v1/auth/registration/reject").send({ token, reason: "race" }),
      ]);

      const statuses = [approve.status, reject.status];
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses).toContain(404);
      expect(await repositories.registrationApprovalToken.findById(token)).toBeNull();
      const stored = await repositories.user.findById(userId);
      expect(["active", "rejected"]).toContain(stored?.status);
    });

    it("POST /api/v1/auth/registration/reject rejects the registration and blocks login", async () => {
      const rejectedUser = { email: `rejected-${Date.now()}@test.com`, password: "Rejected1" };
      const reg = await request(app).post("/api/v1/auth/register").send(rejectedUser);
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const reject = await request(app)
        .post("/api/v1/auth/registration/reject")
        .send({ token, reason: "Manual review failed" });
      expect(reject.status).toBe(200);
      expect(reject.text).toContain("Registration rejected");
      expect(reject.text).toContain(rejectedUser.email);

      const login = await request(app).post("/api/v1/auth/login").send(rejectedUser);
      expect(login.status).toBe(403);
      expect(login.body.code).toBe("FORBIDDEN");
      expect(String(login.body.message)).toContain("rejected");
    });

    it("POST /api/v1/auth/registration/retry reopens rejected registrations generically", async () => {
      const rejectedUser = {
        email: `retry-rejected-${Date.now()}@test.com`,
        password: "RetryReg1",
      };
      const reg = await request(app).post("/api/v1/auth/register").send(rejectedUser);
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const reject = await request(app).post("/api/v1/auth/registration/reject").send({ token });
      expect(reject.status).toBe(200);
      const beforeCount = emailSender.adminApprovalRequests.length;

      const retry = await request(app).post("/api/v1/auth/registration/retry").send(rejectedUser);
      expect(retry.status).toBe(202);
      expect(retry.body.message).toBe("If eligible, a new approval request will be sent.");
      expect(emailSender.adminApprovalRequests.length).toBe(beforeCount + 1);

      const retryToken = emailSender.adminApprovalRequests.at(-1)?.reviewToken;
      expect(typeof retryToken).toBe("string");
      const approve = await request(app)
        .post("/api/v1/auth/registration/approve")
        .send({ token: retryToken });
      expect(approve.status).toBe(200);

      const login = await request(app).post("/api/v1/auth/login").send(rejectedUser);
      expect(login.status).toBe(200);
    });

    it("POST /api/v1/auth/registration/retry returns generic 202 for ineligible accounts", async () => {
      const retry = await request(app)
        .post("/api/v1/auth/registration/retry")
        .send({ email: `missing-retry-${Date.now()}@test.com`, password: "RetryReg1" });
      expect(retry.status).toBe(202);
      expect(retry.body.message).toBe("If eligible, a new approval request will be sent.");
    });

    it("POST /api/v1/auth/registration/retry stays generic for wrong password and active accounts", async () => {
      const rejectedUser = { email: `retry-wrong-${Date.now()}@test.com`, password: "RetryReg1" };
      const reg = await request(app).post("/api/v1/auth/register").send(rejectedUser);
      expect(reg.status).toBe(201);
      const reject = await request(app)
        .post("/api/v1/auth/registration/reject")
        .send({ token: reg.body.approvalToken });
      expect(reject.status).toBe(200);

      const wrongPasswordRetry = await request(app)
        .post("/api/v1/auth/registration/retry")
        .send({ email: rejectedUser.email, password: "WrongPassword1" });
      expect(wrongPasswordRetry.status).toBe(202);
      expect(wrongPasswordRetry.body.message).toBe(
        "If eligible, a new approval request will be sent.",
      );

      const activeUser = { email: `retry-active-${Date.now()}@test.com`, password: "RetryReg1" };
      const activeReg = await request(app).post("/api/v1/auth/register").send(activeUser);
      expect(activeReg.status).toBe(201);
      await approveRegistrationByToken(app, activeReg.body.approvalToken as string);

      const activeRetry = await request(app)
        .post("/api/v1/auth/registration/retry")
        .send(activeUser);
      expect(activeRetry.status).toBe(202);
      expect(activeRetry.body.message).toBe("If eligible, a new approval request will be sent.");
    });

    it("GET /api/v1/auth/registration/status returns expired and approve returns 410 for expired tokens", async () => {
      const reg = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: `expired-user-${Date.now()}@test.com`, password: "ExpiredFlow1" });
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const storedToken = await repositories.registrationApprovalToken.findById(token);
      expect(storedToken).not.toBeNull();
      await repositories.registrationApprovalToken.save({
        ...storedToken!,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const status = await request(app).get("/api/v1/auth/registration/status").query({ token });
      expect(status.status).toBe(200);
      expect(status.body.status).toBe("expired");

      const approve = await request(app).post("/api/v1/auth/registration/approve").send({ token });
      expect(approve.status).toBe(410);
      expect(approve.body.code).toBe("REGISTRATION_TOKEN_EXPIRED");
    });
  });

  // ─── Login ─────────────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/login", () => {
    it("should return 403 when account is still pending approval", async () => {
      const pendingUser = { email: "still-pending@test.com", password: "StillPending1" };
      const reg = await request(app).post("/api/v1/auth/register").send(pendingUser);
      expect(reg.status).toBe(201);

      const loginRes = await request(app).post("/api/v1/auth/login").send(pendingUser);
      expect(loginRes.status).toBe(403);
      expect(loginRes.body.code).toBe("FORBIDDEN");
    });

    it("should login and return tokens", async () => {
      const response = await request(app).post("/api/v1/auth/login").send(testUser);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.token).toBe(response.body.accessToken);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
      expect(response.headers["set-cookie"]).toBeDefined();
    });

    it("should return 401 for wrong password", async () => {
      const response = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: testUser.email, password: "WrongPass1" });

      expect(response.status).toBe(401);
    });

    it("should return 401 for non-existent email", async () => {
      const response = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@test.com", password: "Password1" });

      expect(response.status).toBe(401);
    });

    it("should return 400 when email field is not a valid address", async () => {
      const response = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "not-an-email", password: "Password1" });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 403 when account was blocked after approval", async () => {
      const blockedCredentials = {
        email: `blocked-login-${Date.now()}@test.com`,
        password: "Blocked1A",
      };
      const reg = await request(app).post("/api/v1/auth/register").send(blockedCredentials);
      expect(reg.status).toBe(201);
      await approveRegistrationByToken(app, reg.body.approvalToken as string);

      const user = await repositories.user.findById(reg.body.user.id as string);
      expect(user).not.toBeNull();
      await repositories.user.save(
        new User({
          id: user!.id,
          email: user!.email,
          passwordHash: user!.passwordHash,
          role: user!.role,
          status: "blocked",
          createdAt: user!.createdAt,
          ...(user!.celular !== undefined ? { celular: user!.celular } : {}),
        }),
      );

      const login = await request(app).post("/api/v1/auth/login").send(blockedCredentials);
      expect(login.status).toBe(403);
      expect(login.body.code).toBe("FORBIDDEN");
      expect(String(login.body.message)).toContain("blocked");
    });
  });

  describe("POST /auth/login", () => {
    it("should support the plug_agente login contract", async () => {
      const response = await request(app).post("/auth/login").send({
        username: testUser.email,
        password: testUser.password,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.token).toBeDefined();
      expect(response.body.token).toBe(response.body.accessToken);
      expect(response.body.refreshToken).toBeDefined();
    });
  });

  // ─── Agent Login ───────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/agent-login", () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";

    beforeAll(async () => {
      await seedAgent({ agentId, name: "Auth Test Agent", cnpjCpf: "auth-test-unique" });
      const user = await repositories.user.findByEmail(testUser.email);
      if (user) {
        await seedAgentBinding(user.id, agentId);
      }
    });

    it("should login as agent and return tokens with role agent and agentId", async () => {
      const response = await request(app).post("/api/v1/auth/agent-login").send({
        email: testUser.email,
        password: testUser.password,
        agentId,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
      expect(response.body.user).toMatchObject({
        email: testUser.email,
        role: "agent",
        agentId,
      });
      expect(response.body.user.id).toBeDefined();
    });

    it("should return 401 for wrong password", async () => {
      const response = await request(app).post("/api/v1/auth/agent-login").send({
        email: testUser.email,
        password: "WrongPass1",
        agentId,
      });

      expect(response.status).toBe(401);
    });

    it("should return 400 for invalid agentId", async () => {
      const response = await request(app).post("/api/v1/auth/agent-login").send({
        email: testUser.email,
        password: testUser.password,
        agentId: "not-a-uuid",
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for invalid email", async () => {
      const response = await request(app).post("/api/v1/auth/agent-login").send({
        email: "bad-email",
        password: testUser.password,
        agentId,
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });
  });

  // ─── Refresh ───────────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/refresh", () => {
    it("should issue new tokens with a valid refresh token", async () => {
      const response = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();

      // Update tokens for the next tests (rotation)
      refreshToken = response.body.refreshToken as string;
    });

    it("should issue new tokens when refresh token is sent via cookie", async () => {
      const response = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", [`refresh_token=${refreshToken}`])
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
      refreshToken = response.body.refreshToken as string;
    });

    it("should prefer body refresh token over a conflicting cookie (body > cookie)", async () => {
      const staleToken = refreshToken;
      const rotateResponse = await request(app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: staleToken });
      expect(rotateResponse.status).toBe(200);
      const currentToken = rotateResponse.body.refreshToken as string;

      const response = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", [`refresh_token=${staleToken}`])
        .send({ refreshToken: currentToken });

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
      refreshToken = response.body.refreshToken as string;
    });

    it("should reject when body refresh token is invalid even if cookie is valid", async () => {
      const response = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", [`refresh_token=${refreshToken}`])
        .send({ refreshToken: "not-a-valid-token" });

      expect(response.status).toBe(401);
    });

    it("should return 401 when the used refresh token is presented again (rotation)", async () => {
      const firstRefreshToken = refreshToken;

      // Rotate the token
      const rotateResponse = await request(app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: firstRefreshToken });
      expect(rotateResponse.status).toBe(200);
      refreshToken = rotateResponse.body.refreshToken as string;

      // Try to reuse the old one
      const reuseResponse = await request(app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: firstRefreshToken });
      expect(reuseResponse.status).toBe(401);
    });

    it("should return 401 for an invalid refresh token", async () => {
      const response = await request(app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: "not-a-valid-token" });

      expect(response.status).toBe(401);
    });
  });

  describe("POST /auth/refresh", () => {
    it("should support the plug_agente refresh contract", async () => {
      const response = await request(app).post("/auth/refresh").send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.token).toBe(response.body.accessToken);
      expect(response.body.refreshToken).toBeDefined();
      refreshToken = response.body.refreshToken as string;
    });
  });

  // ─── Me ────────────────────────────────────────────────────────────────────

  describe("GET /api/v1/auth/me", () => {
    it("should return current user info with a valid access token", async () => {
      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({
        id: expect.any(String),
        sub: expect.any(String),
        email: testUser.email,
        role: "user",
        status: "active",
      });
      expect(response.body.user.id).toBe(response.body.user.sub);
    });

    it("should return 401 with no token", async () => {
      const response = await request(app).get("/api/v1/auth/me");
      expect(response.status).toBe(401);
    });

    it("should return 401 with an invalid token", async () => {
      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", "Bearer invalid.token.here");

      expect(response.status).toBe(401);
    });
  });

  // ─── Logout ────────────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/logout", () => {
    it("should logout and revoke the refresh token", async () => {
      const response = await request(app).post("/api/v1/auth/logout").send({ refreshToken });

      expect(response.status).toBe(204);
    });

    it("should return 401 when trying to refresh after logout", async () => {
      const response = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });

      expect(response.status).toBe(401);
    });
  });
});
