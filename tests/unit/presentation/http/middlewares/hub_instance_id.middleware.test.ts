import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const makeResponse = (): Response => {
  const response = {
    setHeader: vi.fn(),
  } as unknown as Response;
  return response;
};

describe("hubInstanceIdMiddleware", () => {
  it("sets X-Hub-Instance-Id when HUB_INSTANCE_ID is configured", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: { hubInstanceId: "hub-pod-7" },
    }));

    const { hubInstanceIdMiddleware } =
      await import("../../../../../src/presentation/http/middlewares/hub_instance_id.middleware");

    const response = makeResponse();
    const next = vi.fn() as NextFunction;

    hubInstanceIdMiddleware({} as Request, response, next);

    expect(response.setHeader).toHaveBeenCalledWith("X-Hub-Instance-Id", "hub-pod-7");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("trims surrounding whitespace from HUB_INSTANCE_ID before emitting it", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: { hubInstanceId: "  hub-pod-2 \n" },
    }));

    const { hubInstanceIdMiddleware } =
      await import("../../../../../src/presentation/http/middlewares/hub_instance_id.middleware");

    const response = makeResponse();
    const next = vi.fn() as NextFunction;

    hubInstanceIdMiddleware({} as Request, response, next);

    expect(response.setHeader).toHaveBeenCalledWith("X-Hub-Instance-Id", "hub-pod-2");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when HUB_INSTANCE_ID is empty (default)", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: { hubInstanceId: "" },
    }));

    const { hubInstanceIdMiddleware } =
      await import("../../../../../src/presentation/http/middlewares/hub_instance_id.middleware");

    const response = makeResponse();
    const next = vi.fn() as NextFunction;

    hubInstanceIdMiddleware({} as Request, response, next);

    expect(response.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when HUB_INSTANCE_ID is whitespace-only", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: { hubInstanceId: "   \t  " },
    }));

    const { hubInstanceIdMiddleware } =
      await import("../../../../../src/presentation/http/middlewares/hub_instance_id.middleware");

    const response = makeResponse();
    const next = vi.fn() as NextFunction;

    hubInstanceIdMiddleware({} as Request, response, next);

    expect(response.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
