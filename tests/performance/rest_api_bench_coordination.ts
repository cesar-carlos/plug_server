import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

export type RestBenchLabel = "base" | "head";

export const readRestBenchCpuAffinity = (): string => {
  if (process.platform !== "linux") return "unavailable";
  const allowed = readFileSync("/proc/self/status", "utf8").match(
    /^Cpus_allowed_list:\s*(.+)$/m,
  )?.[1];
  if (!allowed) throw new Error("Cannot verify Linux benchmark CPU affinity");
  return allowed.trim();
};

interface PendingTurn {
  readonly stage: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface RestBenchTurn {
  readonly label: RestBenchLabel;
  readonly stage: string;
  readonly grantedAt: string;
  completedAt?: string;
}

/** A worker acknowledges its previous turn by requesting the next one. */
export class RestBenchTurnCoordinator {
  readonly turns: RestBenchTurn[] = [];
  completed = false;
  private readonly pending = new Map<RestBenchLabel, PendingTurn>();
  private readonly lastStage = new Map<RestBenchLabel, string>();
  private active: RestBenchTurn | undefined;
  private remaining: RestBenchLabel[] = [];
  private stage: string | undefined;
  private ordinal = 0;
  private failure: Error | undefined;

  constructor(private readonly first: RestBenchLabel) {}

  wait(label: RestBenchLabel, stage: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.completed || this.pending.has(label) || this.lastStage.get(label) === stage) {
      this.abort(new Error("Duplicate or completed REST benchmark turn"));
      return Promise.reject(this.failure);
    }
    if (this.active?.label === label) {
      this.active.completedAt = new Date().toISOString();
      this.active = undefined;
    }
    this.lastStage.set(label, stage);
    return new Promise<void>((resolve, reject) => {
      this.pending.set(label, { stage, resolve, reject });
      this.advance();
    });
  }

  abort(error: Error): void {
    this.failure ??= error;
    for (const turn of this.pending.values()) turn.reject(this.failure);
    this.pending.clear();
  }

  private advance(): void {
    if (this.active) return;
    if (this.remaining.length === 0) {
      if (this.pending.size !== 2) return;
      const base = this.pending.get("base")!;
      const head = this.pending.get("head")!;
      if (base.stage !== head.stage) {
        this.abort(new Error("REST benchmark workers requested different stages"));
        return;
      }
      if (base.stage === "complete") {
        this.completed = true;
        base.resolve();
        head.resolve();
        this.pending.clear();
        return;
      }
      this.stage = base.stage;
      const other = this.first === "base" ? "head" : "base";
      this.remaining = this.ordinal++ % 2 === 0 ? [this.first, other] : [other, this.first];
    }
    const label = this.remaining[0]!;
    const next = this.pending.get(label);
    if (!next) return;
    if (next.stage !== this.stage) {
      this.abort(new Error("REST benchmark worker skipped a stage"));
      return;
    }
    this.remaining.shift();
    this.pending.delete(label);
    this.active = { label, stage: next.stage, grantedAt: new Date().toISOString() };
    this.turns.push(this.active);
    next.resolve();
  }
}

export const startRestBenchCoordinator = async (
  first: RestBenchLabel,
): Promise<{
  readonly url: string;
  readonly token: string;
  readonly coordinator: RestBenchTurnCoordinator;
  readonly close: () => Promise<void>;
}> => {
  const coordinator = new RestBenchTurnCoordinator(first);
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const label = url.searchParams.get("label");
    const stage = url.searchParams.get("stage");
    if (
      request.method !== "GET" ||
      url.pathname !== "/turn" ||
      request.headers["x-benchmark-token"] !== token ||
      (label !== "base" && label !== "head") ||
      !stage ||
      !/^(?:complete|[a-z_]+:(?:warmup|\d+))$/.test(stage)
    ) {
      response.writeHead(400).end();
      return;
    }
    void coordinator.wait(label, stage).then(
      () => response.writeHead(204).end(),
      () => response.writeHead(409).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing coordinator address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    coordinator,
    close: async () => {
      coordinator.abort(new Error("REST benchmark coordinator closed"));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

/** Coordination and GC remain outside each timed repetition. */
export const createRestBenchTurnWaiter = (): ((stage: string) => Promise<void>) => {
  const endpoint = process.env.REST_BENCH_COORDINATOR_URL;
  if (!endpoint) return async () => undefined;
  const url = new URL(endpoint);
  const label = process.env.REST_BENCH_COORDINATOR_LABEL;
  const token = process.env.REST_BENCH_COORDINATOR_TOKEN;
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.REST_BENCH_ISOLATED_DATABASE !== "true" ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    (label !== "base" && label !== "head") ||
    !token
  ) {
    throw new Error("REST benchmark coordination requires an isolated loopback test endpoint");
  }
  return async (stage: string): Promise<void> => {
    const turn = new URL("/turn", url);
    turn.searchParams.set("label", label);
    turn.searchParams.set("stage", stage);
    const response = await fetch(turn, {
      headers: { "x-benchmark-token": token },
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status !== 204) throw new Error(`REST benchmark turn refused: ${response.status}`);
  };
};
