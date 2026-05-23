import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

export interface DistributedHubProcess {
  readonly baseUrl: string;
  close(): Promise<void>;
  getConsumerRoomCount(room: string): Promise<number>;
  setFetchSocketsFailure(enabled: boolean): Promise<void>;
}

interface SpawnDistributedHubProcessOptions {
  readonly restSocketEventBestEffortLocalMaxRecipients?: number;
  readonly restSocketEventDistributedCountFailureOpenMs?: number;
  readonly restSocketEventDistributedCountFailureThreshold?: number;
  readonly restSocketEventIdempotencyRedisUrl?: string;
  readonly restSocketEventMaxRecipients?: number;
  readonly socketConsumerClientAgentRoomReconcileStartJitterMs?: number;
  readonly socketConsumerClientAgentRoomReconcileIntervalMs?: number;
  readonly socketIoRedisAdapterUrl?: string;
}

const rootDir = path.resolve(__dirname, "..", "..", "..");
const tsxCliPath = path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
const childScriptPath = path.join(
  rootDir,
  "tests",
  "integration",
  "helpers",
  "distributed_hub_child.ts",
);

const waitForProcessExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for distributed hub child to exit"));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
        resolve();
        return;
      }
      reject(
        new Error(
          `Distributed hub child exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  });

const connectTestNamespace = (baseUrl: string): Promise<ClientSocket> =>
  new Promise<ClientSocket>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/__test`, {
      transports: ["websocket"],
      forceNew: true,
    });

    const onConnect = (): void => {
      socket.off("connect_error", onError);
      resolve(socket);
    };

    const onError = (error: Error): void => {
      socket.off("connect", onConnect);
      socket.disconnect();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
  });

export const spawnDistributedHubProcess = async (
  options?: SpawnDistributedHubProcessOptions,
): Promise<DistributedHubProcess> => {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    CONTAINER_PERSISTENCE_MODE: "prisma",
    ...(options?.socketIoRedisAdapterUrl !== undefined
      ? { SOCKET_IO_REDIS_ADAPTER_URL: options.socketIoRedisAdapterUrl }
      : {}),
    ...(options?.restSocketEventIdempotencyRedisUrl !== undefined
      ? { REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL: options.restSocketEventIdempotencyRedisUrl }
      : {}),
    ...(options?.socketConsumerClientAgentRoomReconcileIntervalMs !== undefined
      ? {
          SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS: String(
            options.socketConsumerClientAgentRoomReconcileIntervalMs,
          ),
        }
      : {}),
    ...(options?.socketConsumerClientAgentRoomReconcileStartJitterMs !== undefined
      ? {
          SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS: String(
            options.socketConsumerClientAgentRoomReconcileStartJitterMs,
          ),
        }
      : {}),
    ...(options?.restSocketEventMaxRecipients !== undefined
      ? { REST_SOCKET_EVENT_MAX_RECIPIENTS: String(options.restSocketEventMaxRecipients) }
      : {}),
    ...(options?.restSocketEventDistributedCountFailureThreshold !== undefined
      ? {
          REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_THRESHOLD: String(
            options.restSocketEventDistributedCountFailureThreshold,
          ),
        }
      : {}),
    ...(options?.restSocketEventDistributedCountFailureOpenMs !== undefined
      ? {
          REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_OPEN_MS: String(
            options.restSocketEventDistributedCountFailureOpenMs,
          ),
        }
      : {}),
    ...(options?.restSocketEventBestEffortLocalMaxRecipients !== undefined
      ? {
          REST_SOCKET_EVENT_BEST_EFFORT_LOCAL_MAX_RECIPIENTS: String(
            options.restSocketEventBestEffortLocalMaxRecipients,
          ),
        }
      : {}),
  };

  const child = spawn(process.execPath, [tsxCliPath, childScriptPath], {
    cwd: rootDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for distributed hub child bootstrap.\nstdout:\n${stdoutBuffer}\nstderr:\n${stderrBuffer}`,
        ),
      );
    }, 20_000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    const onStdout = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      stdoutBuffer += text;
      const marker = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("TEST_SERVER_READY "));
      if (!marker) {
        return;
      }
      cleanup();
      resolve(marker.slice("TEST_SERVER_READY ".length));
    };

    const onStderr = (chunk: Buffer): void => {
      stderrBuffer += chunk.toString("utf8");
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `Distributed hub child exited during bootstrap (code=${code ?? "null"}, signal=${signal ?? "null"}).\nstdout:\n${stdoutBuffer}\nstderr:\n${stderrBuffer}`,
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });

  return {
    baseUrl,
    close: async () => {
      if (child.killed || child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await waitForProcessExit(child, 10_000);
    },
    getConsumerRoomCount: async (room: string) => {
      const socket = await connectTestNamespace(baseUrl);
      try {
        const count = await new Promise<number>((resolve, reject) => {
          socket
            .timeout(2_000)
            .emit("room-count", { room }, (error: Error | null, response?: { count?: unknown }) => {
              if (error) {
                reject(error);
                return;
              }
              resolve(typeof response?.count === "number" ? response.count : 0);
            });
        });
        return count;
      } finally {
        socket.disconnect();
      }
    },
    setFetchSocketsFailure: async (enabled: boolean) => {
      const socket = await connectTestNamespace(baseUrl);
      try {
        await new Promise<void>((resolve, reject) => {
          socket
            .timeout(2_000)
            .emit(
              "set-fetch-sockets-failure",
              { enabled },
              (error: Error | null, response?: { enabled?: unknown }) => {
                if (error) {
                  reject(error);
                  return;
                }
                if (response?.enabled !== enabled) {
                  reject(new Error("set-fetch-sockets-failure ack mismatch"));
                  return;
                }
                resolve();
              },
            );
        });
      } finally {
        socket.disconnect();
      }
    },
  };
};
