import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { env } from "../../src/shared/config/env";

const app = createApp();

describe("Root public surface", () => {
  it("should serve GET / as HTML with APP_NAME and Portuguese copy by default", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"] ?? "").toMatch(/text\/html/i);
    expect(response.text).toContain("/docs/");
    expect(response.text).toContain("/api/v1/health/live");
    expect(response.text).toContain(env.appName);
    expect(response.text).toContain("Serviço em execução");
    expect(response.text).toContain("/site.webmanifest");
    expect(response.text).toContain("apple-touch-icon");
  });

  it("should serve English copy when Accept-Language prefers English (auto mode)", async () => {
    const response = await request(app).get("/").set("Accept-Language", "en-GB,en;q=0.9");

    expect(response.status).toBe(200);
    expect(response.text).toContain("Service is running");
    expect(response.text).toContain("API documentation (Swagger)");
  });

  it("should expose site.webmanifest with APP_NAME and icon URLs", async () => {
    const response = await request(app).get("/site.webmanifest");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"] ?? "").toMatch(/json|manifest/i);
    const body = response.body as Record<string, unknown>;
    const parsed =
      typeof body === "object" && body !== null && Object.keys(body).length > 0
        ? body
        : (JSON.parse(response.text) as Record<string, unknown>);
    expect(parsed.name).toBe(env.appName);
    expect(Array.isArray(parsed.icons)).toBe(true);
    expect((parsed.icons as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(parsed)).toContain("/assets/app_icons/");
  });

  it("should not expose internal landing templates via /assets static (dotfiles deny)", async () => {
    const response = await request(app).get("/assets/.internal/root_landing.pt.html");

    expect(response.status).toBe(404);
  });
});
