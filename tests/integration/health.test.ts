import request from "supertest";
import { describe, it, expect } from "vitest";

import { createApp } from "../../src/app";

const app = createApp();

describe("GET /api/v1/health", () => {
  it("should return 200 for liveness endpoint", async () => {
    const response = await request(app).get("/api/v1/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      mode: "live",
    });
  });

  it("should return 200 for readiness endpoint", async () => {
    const response = await request(app).get("/api/v1/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      mode: "ready",
      checks: {
        envLoaded: true,
        memoryStoreReady: true,
      },
    });
  });

  it("should return 200 with health status", async () => {
    const response = await request(app).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      service: expect.any(String),
      environment: expect.any(String),
      timestamp: expect.any(String),
      uptimeInSeconds: expect.any(Number),
    });
  });

  it("should include x-request-id header in response", async () => {
    const response = await request(app).get("/api/v1/health");

    expect(response.headers["x-request-id"]).toBeDefined();
    expect(typeof response.headers["x-request-id"]).toBe("string");
  });

  it("should echo the x-request-id header when provided", async () => {
    const customId = "test-request-id-123";

    const response = await request(app)
      .get("/api/v1/health")
      .set("x-request-id", customId);

    expect(response.headers["x-request-id"]).toBe(customId);
    expect(response.body.requestId).toBe(customId);
  });

  it("should return 404 for unknown routes", async () => {
    const response = await request(app).get("/api/v1/unknown-route");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      message: "Route not found",
      code: "ROUTE_NOT_FOUND",
    });
  });
});
