import type { DatabaseReadinessProbe } from "../../../application/services/health_readiness.service";
import { prismaClient } from "./client";

export class PrismaDatabaseReadinessProbe implements DatabaseReadinessProbe {
  async probe(timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const probe = prismaClient.$queryRawUnsafe<unknown>("SELECT 1");
    try {
      await Promise.race([
        probe,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`db_probe_timeout_${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
