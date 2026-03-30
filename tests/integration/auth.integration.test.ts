import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();

const testUser = {
  email: "integration@test.com",
  password: "Integration1",
};
const repositories = getTestRepositoryAccess();

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
      const reg = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: `review-page-${Date.now()}@test.com`, password: "ReviewPage1" });
      expect(reg.status).toBe(201);
      const token = reg.body.approvalToken as string;

      const page = await request(app).get("/api/v1/auth/registration/review").query({ token });
      expect(page.status).toBe(200);
      expect(page.text).toContain('method="post"');
      expect(page.text).toContain("/api/v1/auth/registration/approve");
      expect(page.text).toContain("/api/v1/auth/registration/reject");
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
      expect(response.body.user).toHaveProperty("sub");
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
