import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = {
  nodeEnv: "production",
  restGlobalRateLimitWindowMs: 60_000,
  restGlobalRateLimitMax: 100,
  restCredentialAuthRateLimitWindowMs: 60_000,
  restCredentialAuthRateLimitMax: 25,
  restTokenRefreshRateLimitWindowMs: 60_000,
  restTokenRefreshRateLimitMax: 400,
  restAgentsCommandsRateLimitWindowMs: 60_000,
  restAgentsCommandsRateLimitMax: 100,
  restAgentsCommandsRateLimitIpMax: 100,
  restAdminUserStatusRateLimitWindowMs: 60_000,
  restAdminUserStatusRateLimitMax: 20,
  restClientMeAgentsPostRateLimitWindowMs: 60_000,
  restClientMeAgentsPostRateLimitMax: 20,
  restSocketEventRateLimitWindowMs: 60_000,
  restSocketEventRateLimitMax: 20,
  restClientThumbnailRateLimitWindowMs: 60_000,
  restClientThumbnailRateLimitMax: 20,
  restClientPasswordRecoveryRateLimitWindowMs: 60_000,
  restClientPasswordRecoveryRateLimitMax: 20,
};

const expectedScopes = [
  "global",
  "credential_auth",
  "token_refresh",
  "agents_commands_ip",
  "agents_commands_user",
  "agents_self_profile",
  "admin_user_status",
  "client_me_agents_post",
  "client_socket_event_publish",
  "client_thumbnail",
  "client_password_recovery_request",
];

interface CapturedRateLimitOptions {
  readonly passOnStoreError?: boolean;
  readonly store?: unknown;
}

interface RateLimitModuleSetup {
  readonly capturedOptions: CapturedRateLimitOptions[];
  readonly createStoreMock: ReturnType<typeof vi.fn>;
  readonly rateLimitMock: ReturnType<typeof vi.fn>;
}

const setupRateLimitModule = async (withRedisStore: boolean): Promise<RateLimitModuleSetup> => {
  vi.resetModules();

  const capturedOptions: CapturedRateLimitOptions[] = [];
  const rateLimitMock = vi.fn((options: CapturedRateLimitOptions) => {
    capturedOptions.push(options);
    return vi.fn();
  });
  const createStoreMock = vi.fn((scope: string) =>
    withRedisStore
      ? {
          scope,
          increment: vi.fn(),
          decrement: vi.fn(),
          resetKey: vi.fn(),
        }
      : undefined,
  );

  vi.doMock("express-rate-limit", () => ({
    rateLimit: rateLimitMock,
  }));
  vi.doMock("../../../../../src/shared/config/env", () => ({
    env: envMock,
  }));
  vi.doMock("../../../../../src/infrastructure/redis/rest_rate_limit_redis", () => ({
    createRestHttpRateLimitStore: createStoreMock,
  }));
  vi.doMock("../../../../../src/application/services/rest_http_rate_limit_metrics.service", () => ({
    incrementRestHttpAdminUserStatusRateLimitRejected: vi.fn(),
    incrementRestHttpAgentsCommandsIpRateLimitRejected: vi.fn(),
    incrementRestHttpAgentsCommandsUserRateLimitRejected: vi.fn(),
    incrementRestHttpAgentsSelfProfileRateLimitRejected: vi.fn(),
    incrementRestHttpClientMeAgentsPostRateLimitRejected: vi.fn(),
    incrementRestHttpClientPasswordRecoveryRequestRateLimitRejected: vi.fn(),
    incrementRestHttpClientSocketEventPublishRateLimitRejected: vi.fn(),
    incrementRestHttpClientThumbnailRateLimitRejected: vi.fn(),
    incrementRestHttpCredentialAuthRateLimitRejected: vi.fn(),
    incrementRestHttpGlobalRateLimitRejected: vi.fn(),
    incrementRestHttpTokenRefreshRateLimitRejected: vi.fn(),
  }));

  const module = await import("../../../../../src/presentation/http/middlewares/rate_limit.middleware");
  module.registerHttpRateLimits();

  return { capturedOptions, createStoreMock, rateLimitMock };
};

describe("registerHttpRateLimits Redis store wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("express-rate-limit");
    vi.doUnmock("../../../../../src/shared/config/env");
    vi.doUnmock("../../../../../src/infrastructure/redis/rest_rate_limit_redis");
    vi.doUnmock("../../../../../src/application/services/rest_http_rate_limit_metrics.service");
  });

  it("creates one Redis store per limiter with fail-open enabled", async () => {
    const { capturedOptions, createStoreMock, rateLimitMock } = await setupRateLimitModule(true);

    expect(rateLimitMock).toHaveBeenCalledTimes(expectedScopes.length);
    expect(createStoreMock.mock.calls.map(([scope]) => scope)).toEqual(expectedScopes);
    expect(capturedOptions.map((options) => options.store)).toHaveLength(expectedScopes.length);
    expect(new Set(capturedOptions.map((options) => options.store)).size).toBe(expectedScopes.length);
    expect(capturedOptions.every((options) => options.passOnStoreError === true)).toBe(true);
  });

  it("keeps memory stores unchanged when Redis is not configured", async () => {
    const { capturedOptions, createStoreMock, rateLimitMock } = await setupRateLimitModule(false);

    expect(rateLimitMock).toHaveBeenCalledTimes(expectedScopes.length);
    expect(createStoreMock.mock.calls.map(([scope]) => scope)).toEqual(expectedScopes);
    expect(capturedOptions.every((options) => options.store === undefined)).toBe(true);
    expect(capturedOptions.every((options) => options.passOnStoreError === undefined)).toBe(true);
  });
});
