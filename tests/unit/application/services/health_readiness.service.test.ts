import { describe, expect, it, vi } from "vitest";

import {
  HealthReadinessService,
  type DatabaseReadinessProbe,
} from "../../../../src/application/services/health_readiness.service";

describe("HealthReadinessService", () => {
  it("skips the database probe when configured", async () => {
    const probe: DatabaseReadinessProbe = {
      probe: vi.fn(),
    };
    const service = new HealthReadinessService(probe, {
      databaseTimeoutMs: 1_500,
      skipDatabaseProbe: true,
    });

    await expect(service.check()).resolves.toEqual({
      ready: true,
      checks: {
        envLoaded: true,
        database: true,
      },
    });
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it("returns degraded readiness when the database probe fails", async () => {
    const probe: DatabaseReadinessProbe = {
      probe: vi.fn().mockResolvedValue({ ok: false, error: "db_probe_timeout_1500ms" }),
    };
    const service = new HealthReadinessService(probe, {
      databaseTimeoutMs: 1_500,
      skipDatabaseProbe: false,
    });

    await expect(service.check()).resolves.toEqual({
      ready: false,
      checks: {
        envLoaded: true,
        database: false,
        databaseError: "db_probe_timeout_1500ms",
      },
    });
    expect(probe.probe).toHaveBeenCalledWith(1_500);
  });
});
