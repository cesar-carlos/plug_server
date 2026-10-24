import { logger } from "../../shared/utils/logger";
import { createInstrumentedRedisClient } from "../redis/connection/instrumented_redis_client";
import type { InstrumentedRedisClient } from "../redis/connection/instrumented_redis_client";
import { toSafeRedisErrorMessage } from "../redis/connection/redis_auth";

const AGENT_CATALOG_GENERATION_KEY = "plug:agent-catalog-generation";

/** Shared catalog revision. A failed Redis call disables caching for this process. */
export class RedisAgentCatalogGeneration {
  private unavailable = false;
  private client: InstrumentedRedisClient | undefined;
  private connectOnce: Promise<InstrumentedRedisClient | undefined> | undefined;

  constructor(private readonly url: string) {}

  async read(): Promise<number | null> {
    const client = await this.ensureClient();
    if (client === undefined) return null;
    try {
      const raw = await client.get(AGENT_CATALOG_GENERATION_KEY);
      if (raw === null) return 0;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
      return parsed;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  async bump(): Promise<void> {
    const client = await this.ensureClient();
    if (client === undefined) return;
    try {
      await client.incr(AGENT_CATALOG_GENERATION_KEY);
    } catch (error) {
      this.fail(error);
    }
  }

  private async ensureClient(): Promise<InstrumentedRedisClient | undefined> {
    if (this.unavailable) return undefined;
    if (this.client !== undefined) return this.client;
    this.connectOnce ??= createInstrumentedRedisClient({
      url: this.url,
      logName: "agent_catalog_generation",
      callbacks: {
        onConnected: () => undefined,
        onError: (error) => this.fail(error),
        onEnd: () => this.fail(new Error("redis connection ended")),
        onFallback: (error) => this.fail(error),
      },
    }).then((client) => {
      this.client = client;
      if (client === undefined) this.unavailable = true;
      return client;
    });
    return this.connectOnce;
  }

  private fail(error: unknown): void {
    if (this.unavailable) return;
    this.unavailable = true;
    logger.warn("agent_catalog_generation_unavailable", {
      message: toSafeRedisErrorMessage(error),
    });
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) void client.quit().catch(() => undefined);
  }
}
