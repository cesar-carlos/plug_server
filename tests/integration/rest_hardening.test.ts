import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { User } from "../../src/domain/entities/user.entity";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { approveRegistrationByToken } from "./helpers/approve_registration";

const app = createApp();
const repositories = getTestRepositoryAccess();

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const promoteToAdmin = async (
  userId: string,
  email: string,
  passwordHash: string,
  createdAt: Date,
): Promise<void> => {
  await repositories.user.save(
    User.create({
      id: userId,
      email,
      passwordHash,
      role: "admin",
      status: "active",
      createdAt,
    }),
  );
};

const registerLogin = async (
  email: string,
  password: string,
): Promise<{ userId: string; accessToken: string; passwordHash: string; createdAt: Date }> => {
  const reg = await request(app).post("/api/v1/auth/register").send({ email, password });
  expect(reg.status).toBe(201);
  await approveRegistrationByToken(app, reg.body.approvalToken as string);
  const userId = reg.body.user.id as string;
  const stored = await repositories.user.findById(userId);
  expect(stored).not.toBeNull();
  const login = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(login.status).toBe(200);
  return {
    userId,
    accessToken: login.body.accessToken as string,
    passwordHash: stored!.passwordHash,
    createdAt: stored!.createdAt,
  };
};

describe("REST hardening", () => {
  describe("HTTP error normalization", () => {
    it("returns a standardized 404 for missing /assets static files", async () => {
      const response = await request(app).get("/assets/missing-static-file.png");

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        success: false,
        code: "NOT_FOUND",
        message: "Resource not found",
        error: {
          code: "NOT_FOUND",
          message: "Resource not found",
        },
      });
      expect(response.body.requestId).toEqual(expect.any(String));
    });

    it("returns a standardized 404 for missing /uploads static files", async () => {
      const response = await request(app).get("/uploads/missing-static-file.png");

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        success: false,
        code: "NOT_FOUND",
        message: "Resource not found",
        error: {
          code: "NOT_FOUND",
          message: "Resource not found",
        },
      });
      expect(response.body.requestId).toEqual(expect.any(String));
    });

    it("returns a standardized 400 for malformed JSON bodies", async () => {
      const response = await request(app)
        .post("/auth/login")
        .set("content-type", "application/json")
        .send("{");

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        code: "BAD_REQUEST",
        message: "Invalid request",
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request",
        },
      });
      expect(response.body.requestId).toEqual(expect.any(String));
    });
  });

  // ─── F1.A1: socketId leak in GET /agents ─────────────────────────────────
  describe("GET /api/v1/agents serializer", () => {
    it("returns agents without exposing internal socketId", async () => {
      const unique = Date.now().toString(36);
      const { accessToken } = await registerLogin(
        `rest-hardening-list-${unique}@test.com`,
        "RestHardening1",
      );

      const response = await request(app)
        .get("/api/v1/agents")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      const agents = response.body.agents as Array<Record<string, unknown>>;
      for (const agent of agents) {
        expect(agent).not.toHaveProperty("socketId");
      }
    });
  });

  // ─── F2.M1: /metrics admin guard ─────────────────────────────────────────
  describe("GET /metrics admin guard", () => {
    it("rejects non-admin authenticated users with 403", async () => {
      const unique = Date.now().toString(36);
      const { accessToken } = await registerLogin(
        `rest-hardening-metrics-user-${unique}@test.com`,
        "RestHardening1",
      );

      const response = await request(app)
        .get("/metrics")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    });

    it("allows admin authenticated users", async () => {
      const unique = Date.now().toString(36);
      const email = `rest-hardening-metrics-admin-${unique}@test.com`;
      const { userId, passwordHash, createdAt } = await registerLogin(email, "RestHardening1");
      await promoteToAdmin(userId, email, passwordHash, createdAt);

      const adminLogin = await request(app)
        .post("/api/v1/auth/login")
        .send({ email, password: "RestHardening1" });
      expect(adminLogin.status).toBe(200);
      const adminToken = adminLogin.body.accessToken as string;

      const response = await request(app)
        .get("/metrics")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
    });
  });

  // ─── F1.M4: x-request-id sanitization ────────────────────────────────────
  describe("x-request-id middleware", () => {
    it("echoes a safe inbound request id", async () => {
      const safeId = "abc-123_DEF.456";
      const response = await request(app).get("/api/v1/health/live").set("x-request-id", safeId);
      expect(response.status).toBe(200);
      expect(response.headers["x-request-id"]).toBe(safeId);
    });

    it("replaces an unsafe inbound request id with a server-generated UUID", async () => {
      const evilId = "<script>alert(1)</script>";
      const response = await request(app).get("/api/v1/health/live").set("x-request-id", evilId);
      expect(response.status).toBe(200);
      expect(response.headers["x-request-id"]).not.toBe(evilId);
      const echoed = response.headers["x-request-id"] as string;
      expect(SAFE_REQUEST_ID.test(echoed)).toBe(true);
    });

    it("replaces an oversized inbound request id with a server-generated UUID", async () => {
      const tooLong = "a".repeat(200);
      const response = await request(app).get("/api/v1/health/live").set("x-request-id", tooLong);
      expect(response.status).toBe(200);
      expect(response.headers["x-request-id"]).not.toBe(tooLong);
      expect((response.headers["x-request-id"] as string).length).toBeLessThanOrEqual(128);
    });
  });

  // ─── F1.A3 / F2.M8: logout always clears refresh cookie ─────────────────
  describe("POST /api/v1/auth/logout cookie hygiene", () => {
    it("clears refresh_token cookie even when no token is sent", async () => {
      const response = await request(app).post("/api/v1/auth/logout").send({});
      expect(response.status).toBe(204);
      const setCookies = (response.headers["set-cookie"] ?? []) as string[];
      expect(setCookies.some((c) => c.startsWith("refresh_token=") && /Expires=/i.test(c))).toBe(
        true,
      );
    });

    it("clears refresh_token cookie even when token is invalid", async () => {
      const response = await request(app)
        .post("/api/v1/auth/logout")
        .send({ refreshToken: "definitely-not-a-valid-jwt" });
      expect([400, 401, 204]).toContain(response.status);
      const setCookies = (response.headers["set-cookie"] ?? []) as string[];
      expect(setCookies.some((c) => c.startsWith("refresh_token=") && /Expires=/i.test(c))).toBe(
        true,
      );
    });
  });

  // ─── F2.M8: refresh cookie carries Max-Age ──────────────────────────────
  describe("login emits refresh cookie with Max-Age", () => {
    it("sets refresh_token cookie with Max-Age aligned with JWT_REFRESH_EXPIRES_IN", async () => {
      const unique = Date.now().toString(36);
      const email = `rest-hardening-cookie-${unique}@test.com`;
      const password = "RestHardening1";
      const reg = await request(app).post("/api/v1/auth/register").send({ email, password });
      expect(reg.status).toBe(201);
      await approveRegistrationByToken(app, reg.body.approvalToken as string);
      const login = await request(app).post("/api/v1/auth/login").send({ email, password });
      expect(login.status).toBe(200);
      const setCookies = (login.headers["set-cookie"] ?? []) as string[];
      const refreshCookie = setCookies.find((c) => c.startsWith("refresh_token="));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie!).toMatch(/Max-Age=\d+/);
      expect(refreshCookie!).toMatch(/HttpOnly/i);
      expect(refreshCookie!).toMatch(/SameSite=Strict/i);
    });
  });
});
