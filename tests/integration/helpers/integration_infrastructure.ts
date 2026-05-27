import { prismaClient } from "../../../src/infrastructure/database/prisma/client";

export const DEFAULT_INTEGRATION_REDIS_URL = "redis://127.0.0.1:6379";

export const isCi = (): boolean =>
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

export const isIntegrationRedisTestsEnabled = (): boolean =>
  process.env.INTEGRATION_REDIS_TESTS_ENABLED === "true";

export const integrationHookTimeoutMs = isCi() ? 60_000 : 30_000;

const redisProbeTimeoutMs = 3_000;

const redactUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
};

export interface InfrastructureProbeResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export const resolveIntegrationRedisUrl = (envValue: string | undefined): string | undefined => {
  const trimmed = envValue?.trim() ?? "";
  if (trimmed !== "") {
    return trimmed;
  }
  if (isIntegrationRedisTestsEnabled() || isCi()) {
    return DEFAULT_INTEGRATION_REDIS_URL;
  }
  return undefined;
};

export const formatInfrastructureSkipReason = (parts: string[]): string =>
  `requires ${parts.join("; ")} — configure env vars or run Postgres/Redis locally (see .env.example; CI: set INTEGRATION_REDIS_TESTS_ENABLED=true and provision services)`;

export const canReachDatabase = async (): Promise<boolean> => {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (databaseUrl === "") {
    return false;
  }
  try {
    await prismaClient.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
    return true;
  } catch {
    return false;
  }
};

export const canReachRedis = async (url: string): Promise<boolean> => {
  if (url.trim() === "") {
    return false;
  }

  const probe = async (): Promise<boolean> => {
    const { createClient } = await import("redis");
    const client = createClient({
      url,
      socket: {
        connectTimeout: redisProbeTimeoutMs,
        reconnectStrategy: () => false,
      },
    });
    client.on("error", () => {});

    try {
      await client.connect();
      const pong = await client.ping();
      return pong === "PONG";
    } catch {
      return false;
    } finally {
      await client.disconnect().catch(() => {});
    }
  };

  try {
    return await Promise.race([
      probe(),
      new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error("redis probe timeout")), redisProbeTimeoutMs + 500);
      }),
    ]);
  } catch {
    return false;
  }
};

export interface DistributedRedisInfrastructure {
  readonly databaseUrl: string;
  readonly socketIoRedisAdapterUrl: string;
  readonly restSocketEventIdempotencyRedisUrl: string;
  readonly probe: InfrastructureProbeResult;
}

export const probeDistributedRedisInfrastructure =
  async (): Promise<DistributedRedisInfrastructure> => {
    const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
    const socketIoRedisAdapterUrl = resolveIntegrationRedisUrl(
      process.env.SOCKET_IO_REDIS_ADAPTER_URL,
    );
    const restSocketEventIdempotencyRedisUrl = resolveIntegrationRedisUrl(
      process.env.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL,
    );

    const missingEnv: string[] = [];
    if (databaseUrl === "") {
      missingEnv.push("DATABASE_URL");
    }
    if (socketIoRedisAdapterUrl === undefined) {
      missingEnv.push("SOCKET_IO_REDIS_ADAPTER_URL");
    }
    if (restSocketEventIdempotencyRedisUrl === undefined) {
      missingEnv.push("REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL");
    }
    if (missingEnv.length > 0) {
      return {
        databaseUrl,
        socketIoRedisAdapterUrl: socketIoRedisAdapterUrl ?? "",
        restSocketEventIdempotencyRedisUrl: restSocketEventIdempotencyRedisUrl ?? "",
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason(missingEnv),
        },
      };
    }

    const [databaseAvailable, socketIoRedisAvailable, idempotencyRedisAvailable] =
      await Promise.all([
        canReachDatabase(),
        canReachRedis(socketIoRedisAdapterUrl),
        canReachRedis(restSocketEventIdempotencyRedisUrl),
      ]);

    const unreachable: string[] = [];
    if (!databaseAvailable) {
      unreachable.push(`Postgres unreachable (${redactUrl(databaseUrl)})`);
    }
    if (!socketIoRedisAvailable) {
      unreachable.push(`Redis adapter unreachable (${redactUrl(socketIoRedisAdapterUrl)})`);
    }
    if (!idempotencyRedisAvailable) {
      unreachable.push(
        `Idempotency Redis unreachable (${redactUrl(restSocketEventIdempotencyRedisUrl)})`,
      );
    }
    if (unreachable.length > 0) {
      return {
        databaseUrl,
        socketIoRedisAdapterUrl,
        restSocketEventIdempotencyRedisUrl,
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason(unreachable),
        },
      };
    }

    return {
      databaseUrl,
      socketIoRedisAdapterUrl,
      restSocketEventIdempotencyRedisUrl,
      probe: { ok: true },
    };
  };

export interface DatabaseInfrastructure {
  readonly databaseUrl: string;
  readonly probe: InfrastructureProbeResult;
}

export const probeDatabaseInfrastructure = async (): Promise<DatabaseInfrastructure> => {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (databaseUrl === "") {
    return {
      databaseUrl,
      probe: {
        ok: false,
        reason: formatInfrastructureSkipReason(["DATABASE_URL"]),
      },
    };
  }
  if (!(await canReachDatabase())) {
    return {
      databaseUrl,
      probe: {
        ok: false,
        reason: formatInfrastructureSkipReason([
          `Postgres unreachable (${redactUrl(databaseUrl)})`,
        ]),
      },
    };
  }
  return {
    databaseUrl,
    probe: { ok: true },
  };
};

export interface AgentEventStreamInfrastructure {
  readonly redisUrl: string;
  readonly probe: InfrastructureProbeResult;
}

export const probeAgentEventStreamInfrastructure =
  async (): Promise<AgentEventStreamInfrastructure> => {
    const redisUrl = resolveIntegrationRedisUrl(process.env.AGENT_EVENT_STREAM_REDIS_URL);
    if (redisUrl === undefined) {
      return {
        redisUrl: "",
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason(["AGENT_EVENT_STREAM_REDIS_URL"]),
        },
      };
    }
    if (!(await canReachRedis(redisUrl))) {
      return {
        redisUrl,
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason([
            `Agent event stream Redis unreachable (${redactUrl(redisUrl)})`,
          ]),
        },
      };
    }
    return {
      redisUrl,
      probe: { ok: true },
    };
  };

export interface SocketRateLimitRedisInfrastructure {
  readonly redisUrl: string;
  readonly probe: InfrastructureProbeResult;
}

export const probeSocketRateLimitRedisInfrastructure =
  async (): Promise<SocketRateLimitRedisInfrastructure> => {
    const redisUrl = resolveIntegrationRedisUrl(process.env.SOCKET_RATE_LIMIT_REDIS_URL);
    if (redisUrl === undefined) {
      return {
        redisUrl: "",
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason(["SOCKET_RATE_LIMIT_REDIS_URL"]),
        },
      };
    }
    if (!(await canReachRedis(redisUrl))) {
      return {
        redisUrl,
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason([
            `Socket rate-limit Redis unreachable (${redactUrl(redisUrl)})`,
          ]),
        },
      };
    }
    return {
      redisUrl,
      probe: { ok: true },
    };
  };

export interface RestRateLimitRedisInfrastructure {
  readonly redisUrl: string;
  readonly probe: InfrastructureProbeResult;
}

export const probeRestRateLimitRedisInfrastructure =
  async (): Promise<RestRateLimitRedisInfrastructure> => {
    const redisUrl = resolveIntegrationRedisUrl(process.env.REST_RATE_LIMIT_REDIS_URL);
    if (redisUrl === undefined) {
      return {
        redisUrl: "",
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason(["REST_RATE_LIMIT_REDIS_URL"]),
        },
      };
    }
    if (!(await canReachRedis(redisUrl))) {
      return {
        redisUrl,
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason([
            `REST rate-limit Redis unreachable (${redactUrl(redisUrl)})`,
          ]),
        },
      };
    }
    return {
      redisUrl,
      probe: { ok: true },
    };
  };

export interface SocketIoRedisAdapterInfrastructure {
  readonly redisUrl: string;
  readonly probe: InfrastructureProbeResult;
}

export const probeSocketIoRedisAdapterInfrastructure =
  async (): Promise<SocketIoRedisAdapterInfrastructure> => {
    const redisUrl = resolveIntegrationRedisUrl(process.env.SOCKET_IO_REDIS_ADAPTER_URL);
    if (redisUrl === undefined) {
      return {
        redisUrl: "",
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason(["SOCKET_IO_REDIS_ADAPTER_URL"]),
        },
      };
    }
    if (!(await canReachRedis(redisUrl))) {
      return {
        redisUrl,
        probe: {
          ok: false,
          reason: formatInfrastructureSkipReason([
            `Socket.IO Redis adapter unreachable (${redactUrl(redisUrl)})`,
          ]),
        },
      };
    }
    return {
      redisUrl,
      probe: { ok: true },
    };
  };

export const assertInfrastructureOrSkip = (
  ctx: { skip: (reason?: string) => void },
  probe: InfrastructureProbeResult,
): void => {
  if (probe.ok) {
    return;
  }
  const reason = probe.reason ?? "integration infrastructure unavailable";
  if (isCi() && isIntegrationRedisTestsEnabled()) {
    throw new Error(`CI integration infrastructure required but unavailable: ${reason}`);
  }
  ctx.skip(reason);
};
