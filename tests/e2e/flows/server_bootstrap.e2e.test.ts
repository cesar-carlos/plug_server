import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer } from "../helpers/e2e_server";

/**
 * Smoke: bound HTTP server with Socket.IO attached (unlike tests/integration/health.test.ts
 * which uses createApp() without listening or Socket).
 */
describe("E2E server bootstrap", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();
  });

  afterAll(async () => {
    await server.close();
  });

  it("should serve liveness on the listening server", async () => {
    const response = await request(baseUrl).get("/api/v1/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      mode: "live",
    });
  });
});
