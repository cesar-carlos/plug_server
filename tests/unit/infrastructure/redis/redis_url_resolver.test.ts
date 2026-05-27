import { afterEach, describe, expect, it } from "vitest";

import {
  resetRedisUrlWarningCacheForTests,
  resolveRedisUrl,
} from "../../../../src/infrastructure/redis/redis_url_resolver";

describe("resolveRedisUrl", () => {
  afterEach(() => {
    resetRedisUrlWarningCacheForTests();
  });

  it("returns standard redis:// URLs unchanged", () => {
    const result = resolveRedisUrl("redis://localhost:6379");
    expect(result.url).toBe("redis://localhost:6379");
    expect(result.warning).toBeUndefined();
    expect(result.sentinel).toBeUndefined();
  });

  it("returns standard rediss:// URLs unchanged", () => {
    const result = resolveRedisUrl("rediss://default:secret@example.com:6380/0");
    expect(result.url).toBe("rediss://default:secret@example.com:6380/0");
    expect(result.warning).toBeUndefined();
  });

  it("returns empty input as empty url with no warning", () => {
    expect(resolveRedisUrl("")).toEqual({ url: "" });
    expect(resolveRedisUrl("   ")).toEqual({ url: "" });
  });

  it("parses redis-sentinel:// URL into structured sentinel + first-host fallback", () => {
    const result = resolveRedisUrl(
      "redis-sentinel://user:pwd@s1:26379,s2:26379,s3:26379/mymaster/0",
    );
    expect(result.url).toBe("redis://user:pwd@s1:26379/0");
    expect(result.sentinel).toBeDefined();
    expect(result.sentinel?.hosts).toEqual([
      { host: "s1", port: 26379 },
      { host: "s2", port: 26379 },
      { host: "s3", port: 26379 },
    ]);
    expect(result.sentinel?.masterName).toBe("mymaster");
    expect(result.sentinel?.tls).toBe(false);
    expect(result.warning).toMatch(/Sentinel URL detected/);
  });

  it("parses rediss+sentinel:// URL with TLS flag set", () => {
    const result = resolveRedisUrl("rediss+sentinel://s1:26379/master-prod");
    expect(result.url).toBe("rediss://s1:26379");
    expect(result.sentinel?.tls).toBe(true);
    expect(result.sentinel?.masterName).toBe("master-prod");
  });

  it("parses comma-separated multi-host redis:// URL with first-host fallback", () => {
    const result = resolveRedisUrl("redis://user:pwd@h1:6379,h2:6379,h3:6379/0");
    expect(result.url).toBe("redis://user:pwd@h1:6379/0");
    expect(result.warning).toMatch(/Multi-host Redis URL/);
  });

  it("handles bare host without port in sentinel", () => {
    const result = resolveRedisUrl("redis-sentinel://s1/master/0");
    expect(result.url).toBe("redis://s1:6379/0");
    expect(result.sentinel?.hosts[0]?.port).toBe(6379);
  });

  it("defaults missing master name to 'mymaster'", () => {
    const result = resolveRedisUrl("redis-sentinel://s1:26379");
    expect(result.sentinel?.masterName).toBe("mymaster");
  });

  it("does not alter URLs with unknown schemes (passes through unchanged)", () => {
    const result = resolveRedisUrl("memory://local-only");
    expect(result.url).toBe("memory://local-only");
  });
});
