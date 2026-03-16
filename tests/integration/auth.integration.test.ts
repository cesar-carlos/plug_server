import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";

const app = createApp();

const testUser = {
  email: "integration@test.com",
  password: "Integration1",
};

let accessToken = "";
let refreshToken = "";

describe("Auth API", () => {
  // ─── Register ──────────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/register", () => {
    it("should register a new user and return tokens", async () => {
      const response = await request(app).post("/api/v1/auth/register").send(testUser);

      expect(response.status).toBe(201);
      expect(response.body.user).toMatchObject({ email: testUser.email, role: "user" });
      expect(response.body.user.id).toBeDefined();
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
      expect(response.headers["set-cookie"]).toBeDefined();
      expect(response.body.user).not.toHaveProperty("passwordHash");

      accessToken = response.body.accessToken as string;
      refreshToken = response.body.refreshToken as string;
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

  // ─── Login ─────────────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/login", () => {
    it("should login and return tokens", async () => {
      const response = await request(app).post("/api/v1/auth/login").send(testUser);

      expect(response.status).toBe(200);
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

  // ─── Refresh ───────────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/refresh", () => {
    it("should issue new tokens with a valid refresh token", async () => {
      const response = await request(app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken });

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
      const response = await request(app)
        .post("/api/v1/auth/logout")
        .send({ refreshToken });

      expect(response.status).toBe(204);
    });

    it("should return 401 when trying to refresh after logout", async () => {
      const response = await request(app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken });

      expect(response.status).toBe(401);
    });
  });
});
