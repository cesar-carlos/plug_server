import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({
  default: {
    config: vi.fn(() => ({ parsed: {} })),
  },
}));

describe("Swagger disabled (SWAGGER_ENABLED=false)", () => {
  let app: Express;
  const previousSwaggerEnabled = process.env.SWAGGER_ENABLED;

  beforeAll(async () => {
    process.env.SWAGGER_ENABLED = "false";
    vi.resetModules();
    const { createApp } = await import("../../src/app");
    app = createApp();
  });

  afterAll(() => {
    if (previousSwaggerEnabled === undefined) {
      delete process.env.SWAGGER_ENABLED;
    } else {
      process.env.SWAGGER_ENABLED = previousSwaggerEnabled;
    }
    vi.resetModules();
  });

  it("should not mount /docs when SWAGGER_ENABLED=false", async () => {
    const docsPage = await request(app).get("/docs/");
    expect(docsPage.status).toBe(404);
    expect(docsPage.body?.code).toBe("ROUTE_NOT_FOUND");

    const spec = await request(app).get("/docs.json");
    expect(spec.status).toBe(404);

    const fallback = await request(app).get("/docs/swagger-onload-fallback.js");
    expect(fallback.status).toBe(404);
  });
});
