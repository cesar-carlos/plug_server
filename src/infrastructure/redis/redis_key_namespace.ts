/**
 * Centralised builder for the `{plug}[:<tenantId>]` namespace segment that
 * every Redis-backed module embeds in its key prefix. Two consumers:
 *
 *   1. **Module key prefixes** (`plug_socket_rl:{plug}:...`,
 *      `plug_agent_stream:{plug}:...`, etc.) — call `redisKeyNamespace()` and
 *      drop the result wherever the literal `{plug}` was hard-coded before.
 *      The hash tag stays inside `{}` so Redis Cluster slots remain stable
 *      regardless of tenant id.
 *   2. **Cluster topology validator** sample keys — same helper used to
 *      build the probe keys passed to `validateRedisClusterTopology`.
 *
 * Multi-tenant deployments set `REDIS_TENANT_ID=<tenant>` and every module
 * automatically isolates its keys under the tenant subspace without per-
 * module changes.
 */

import { env } from "../../shared/config/env";

/**
 * Returns the namespace string that goes between the literal module prefix
 * and the user-supplied key segment. Includes the `{plug}` hash tag so the
 * caller writes `prefix:<namespace>:<key>` (the colon between `<namespace>`
 * and `<key>` is provided by the caller).
 *
 * Examples:
 *
 *   - `REDIS_TENANT_ID=""`        → `"{plug}"`
 *   - `REDIS_TENANT_ID="acme"`    → `"{plug}:acme"`
 */
export const redisKeyNamespace = (): string => {
  const tenant = env.redisTenantId;
  if (tenant === "") {
    return "{plug}";
  }
  return `{plug}:${tenant}`;
};

/**
 * Normalises a user-supplied key segment (rate-limit identity, principal id)
 * into the safe `[A-Za-z0-9:_-]` alphabet, replacing every other character
 * with `_`. Centralised so every module shares one definition instead of each
 * re-declaring the same regex (`normalizeKey` / `sanitizePrincipalId`).
 */
export const sanitizeRedisKeySegment = (segment: string): string =>
  segment.replace(/[^A-Za-z0-9:_-]/g, "_");
