/**
 * Pre-parser for the URL strings that operators put into `*_REDIS_URL` envs.
 * Handles three families:
 *
 *   1. **Standard**: `redis://user:pass@host:port/db` and `rediss://...`
 *      (TLS). Pass-through.
 *   2. **Sentinel**: `redis-sentinel://[user:pass@]host1:port[,host2:port]/master/db`
 *      and `rediss+sentinel://...`. Parses to a structured shape; the caller
 *      decides how to wire it (today: warn + fall back to the first host
 *      with the `redis://` scheme rewritten in, since `node-redis@5` has
 *      `createSentinel()` but not all features we need).
 *   3. **Managed services with multi-host**: `redis://host1:port,host2:port@/...`
 *      Some managed providers expose comma-separated hosts in the authority.
 *      We accept the syntax and use the first host.
 *
 * The resolver is intentionally **conservative**: it never throws on a URL
 * that the underlying `createClient` would also accept. It only reshapes
 * Sentinel-style URLs that `createClient(url)` would otherwise reject.
 */

import { logger } from "../../../shared/utils/logger";

export interface ResolvedRedisUrl {
  /** URL acceptable to `node-redis@5 createClient({ url })`. */
  readonly url: string;
  /** Optional Sentinel topology metadata when the input was Sentinel-shaped. */
  readonly sentinel?: {
    readonly hosts: readonly { readonly host: string; readonly port: number }[];
    readonly masterName: string;
    readonly tls: boolean;
  };
  /** Operator-facing warning, if any (logged once at boot time by the caller). */
  readonly warning?: string;
}

const SENTINEL_SCHEMES = new Set(["redis-sentinel:", "rediss+sentinel:"]);

const parseHostList = (
  authority: string,
): readonly { readonly host: string; readonly port: number }[] => {
  const hosts: { host: string; port: number }[] = [];
  for (const piece of authority.split(",")) {
    const trimmed = piece.trim();
    if (trimmed === "") {
      continue;
    }
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon === -1) {
      hosts.push({ host: trimmed, port: 6379 });
      continue;
    }
    const host = trimmed.slice(0, lastColon);
    const portRaw = trimmed.slice(lastColon + 1);
    const port = Number.parseInt(portRaw, 10);
    hosts.push({ host, port: Number.isFinite(port) && port > 0 ? port : 6379 });
  }
  return hosts;
};

/**
 * Splits a Sentinel URL (`redis-sentinel://[user:pass@]hosts/master/db`) into
 * its components. The path's first segment is the master name; the rest
 * (database number) is preserved on the rewritten standard URL.
 */
const parseSentinelUrl = (input: string): ResolvedRedisUrl => {
  // Manual parsing because URL constructor mishandles multi-host authorities.
  const schemeEnd = input.indexOf("://");
  const scheme = input.slice(0, schemeEnd + 1);
  const tls = scheme === "rediss+sentinel:";
  const rest = input.slice(schemeEnd + 3);

  let credentials = "";
  let hostPath = rest;
  const atIdx = rest.lastIndexOf("@");
  if (atIdx !== -1) {
    credentials = rest.slice(0, atIdx);
    hostPath = rest.slice(atIdx + 1);
  }

  const slashIdx = hostPath.indexOf("/");
  const authority = slashIdx === -1 ? hostPath : hostPath.slice(0, slashIdx);
  const pathPart = slashIdx === -1 ? "" : hostPath.slice(slashIdx + 1);
  const [rawMasterName, ...rest2] = pathPart.split("/");
  const masterName =
    rawMasterName !== undefined && rawMasterName !== "" ? rawMasterName : "mymaster";
  const dbPart = rest2.length > 0 ? `/${rest2.join("/")}` : "";

  const hosts = parseHostList(authority);
  const fallbackHost = hosts[0];
  const credPart = credentials !== "" ? `${credentials}@` : "";
  const tlsScheme = tls ? "rediss" : "redis";
  const fallbackUrl =
    fallbackHost !== undefined
      ? `${tlsScheme}://${credPart}${fallbackHost.host}:${fallbackHost.port}${dbPart}`
      : `${tlsScheme}://${credPart}localhost:6379${dbPart}`;

  return {
    url: fallbackUrl,
    sentinel: { hosts, masterName, tls },
    warning:
      "Sentinel URL detected; this build connects directly to the first sentinel host as a Redis primary. " +
      "Sentinel master discovery is not yet supported; verify the first host is the actual primary or upgrade the deployment.",
  };
};

const parseManagedMultiHostUrl = (input: string): ResolvedRedisUrl | undefined => {
  // Pattern: `redis(s)://[creds@]host1:port,host2:port[,...][/db]`
  const schemeEnd = input.indexOf("://");
  if (schemeEnd === -1) {
    return undefined;
  }
  const scheme = input.slice(0, schemeEnd + 1);
  if (scheme !== "redis:" && scheme !== "rediss:") {
    return undefined;
  }
  const rest = input.slice(schemeEnd + 3);
  const atIdx = rest.lastIndexOf("@");
  const credentials = atIdx !== -1 ? rest.slice(0, atIdx) : "";
  const hostPath = atIdx !== -1 ? rest.slice(atIdx + 1) : rest;
  const slashIdx = hostPath.indexOf("/");
  const authority = slashIdx === -1 ? hostPath : hostPath.slice(0, slashIdx);
  if (!authority.includes(",")) {
    return undefined;
  }
  const dbPart = slashIdx === -1 ? "" : hostPath.slice(slashIdx);
  const hosts = parseHostList(authority);
  const first = hosts[0];
  if (first === undefined) {
    return undefined;
  }
  const credPart = credentials !== "" ? `${credentials}@` : "";
  return {
    url: `${scheme}//${credPart}${first.host}:${first.port}${dbPart}`,
    warning:
      `Multi-host Redis URL detected (${hosts.length} hosts); using first host (${first.host}:${first.port}). ` +
      "True multi-host failover requires Redis Cluster or Sentinel topology; consider rediss+sentinel:// when applicable.",
  };
};

export const resolveRedisUrl = (input: string): ResolvedRedisUrl => {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { url: "" };
  }

  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }

  if (parsed !== undefined && SENTINEL_SCHEMES.has(parsed.protocol)) {
    return parseSentinelUrl(trimmed);
  }

  // Manual scan because `new URL()` chokes on multi-host authorities.
  if (trimmed.startsWith("redis-sentinel://") || trimmed.startsWith("rediss+sentinel://")) {
    return parseSentinelUrl(trimmed);
  }

  const managed = parseManagedMultiHostUrl(trimmed);
  if (managed !== undefined) {
    return managed;
  }

  return { url: trimmed };
};

let warningLoggedFor: Set<string> | undefined;

/**
 * Wraps `resolveRedisUrl` with a one-shot logger so each unique warning is
 * surfaced only once per process (avoids log spam during reconnect storms).
 */
export const resolveRedisUrlWithWarning = (input: string, logName: string): ResolvedRedisUrl => {
  const result = resolveRedisUrl(input);
  if (result.warning !== undefined) {
    warningLoggedFor ??= new Set<string>();
    const key = `${logName}|${result.warning}`;
    if (!warningLoggedFor.has(key)) {
      warningLoggedFor.add(key);
      logger.warn(`${logName}_url_resolved_with_warning`, {
        warning: result.warning,
        sentinelDetected: result.sentinel !== undefined,
      });
    }
  }
  return result;
};

export const resetRedisUrlWarningCacheForTests = (): void => {
  warningLoggedFor = undefined;
};
