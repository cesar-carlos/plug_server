import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    healthReadinessService: {
      check: vi.fn(async () => ({
        ready: false,
        checks: { envLoaded: true, database: false, databaseError: "private database diagnostic" },
      })),
    },
  },
}));
vi.mock("../../../../../src/shared/utils/logger", () => ({ logger: { warn: vi.fn() } }));
import {
  getHealth,
  getHealthReady,
} from "../../../../../src/presentation/http/controllers/health.controller";
import { logger } from "../../../../../src/shared/utils/logger";

it("should hide database diagnostics on both public readiness routes while retaining server logs", async () => {
  const app = express();
  app.get("/health", getHealth);
  app.get("/health/ready", getHealthReady);
  for (const url of ["/health", "/health/ready"]) {
    const response = await request(app).get(url);
    expect(response.status).toBe(503);
    expect(response.body.checks.database).toBe(false);
    expect(response.body.checks.envLoaded).toBe(true);
    expect(response.body.checks).not.toHaveProperty("databaseError");
    expect(response.text).not.toContain("private database diagnostic");
  }
  expect(logger.warn).toHaveBeenCalledWith(
    "health_ready_db_probe_failed",
    expect.objectContaining({ error: "private database diagnostic" }),
  );
});
