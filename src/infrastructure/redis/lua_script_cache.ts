/**
 * Lua script cache: pre-loads scripts via `SCRIPT LOAD` in `onConnected` and
 * runs them with `EVALSHA`. On `NOSCRIPT` (Redis evicted the cache or this is
 * a different Redis instance), falls back to `EVAL` with the source body.
 *
 * Saves ~1 round-trip per command for the heavily-used rate-limit and
 * idempotency Lua scripts and reduces bandwidth (`EVALSHA` sends a 40-char
 * SHA1 instead of the full script body on every call).
 */

import type { InstrumentedRedisClient } from "./instrumented_redis_client";

export interface CachedLuaScript {
  /** Stable identifier used for logs. */
  readonly name: string;
  /** Raw Lua source body sent on `SCRIPT LOAD` and `EVAL` fallback. */
  readonly source: string;
}

export interface LuaScriptInvokeArgs {
  readonly keys: readonly string[];
  readonly arguments: readonly string[];
}

const isNoScriptError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message ?? "";
  // node-redis surfaces `NOSCRIPT No matching script. Please use EVAL.` when
  // the SHA isn't loaded on the server (e.g. failover, FLUSH, different node).
  return /NOSCRIPT/i.test(message);
};

export class LuaScriptCache {
  private readonly shas = new Map<string, string>();

  constructor(private readonly client: InstrumentedRedisClient) {}

  /**
   * Pre-loads `script` and stores its SHA. Idempotent: re-calling with the
   * same name re-loads (useful after a `SCRIPT FLUSH`).
   */
  async load(script: CachedLuaScript): Promise<void> {
    const sha = await this.client.scriptLoad(script.source);
    if (typeof sha === "string" && sha.length > 0) {
      this.shas.set(script.name, sha);
    }
  }

  /**
   * Runs `script` with the given keys/args. Uses `EVALSHA` when a cached SHA
   * exists; on `NOSCRIPT` reloads via `SCRIPT LOAD` and retries `EVALSHA` once
   * before falling back to `EVAL` with the script body.
   */
  async invoke<T = unknown>(script: CachedLuaScript, args: LuaScriptInvokeArgs): Promise<T> {
    const evalShaArgs = {
      keys: [...args.keys],
      arguments: [...args.arguments],
    };
    const cachedSha = this.shas.get(script.name);
    if (cachedSha !== undefined) {
      try {
        return (await this.client.evalSha(cachedSha, evalShaArgs)) as T;
      } catch (error: unknown) {
        if (!isNoScriptError(error)) {
          throw error;
        }
        // Reload and retry once.
        try {
          await this.load(script);
          const reloadedSha = this.shas.get(script.name);
          if (reloadedSha !== undefined) {
            return (await this.client.evalSha(reloadedSha, evalShaArgs)) as T;
          }
        } catch {
          // Fall through to EVAL fallback below.
        }
      }
    }
    return (await this.client.eval(script.source, evalShaArgs)) as T;
  }

  /** For tests only: clear cached SHAs to force the EVAL fallback path. */
  resetForTests(): void {
    this.shas.clear();
  }
}
