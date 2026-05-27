import { createHash } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Builds a weak `ETag` from a JSON-serializable payload using SHA-1 of its
 * canonical JSON representation. The result is prefixed with `W/` (weak)
 * because it relies on `JSON.stringify` field ordering — which is stable for
 * plain object literals but not guaranteed for foreign sources. Weak ETags are
 * sufficient for revalidation (`If-None-Match`) on cacheable read endpoints.
 *
 * Used selectively on idempotent GETs (`/agents`, `/agents/catalog`) where the
 * global `app.set("etag", false)` would otherwise prevent any 304 caching.
 * The cost is one SHA-1 pass over the response body, traded for skipping the
 * entire downstream response write when nothing changed.
 */
export const buildWeakETag = (payload: unknown): string => {
  const json = JSON.stringify(payload);
  const digest = createHash("sha1").update(json).digest("base64");
  return `W/"${digest}"`;
};

/**
 * Short-circuits the response with `304 Not Modified` when the client sent
 * `If-None-Match: <etag>`. Returns `true` when the response was already
 * finalized as `304` and the caller should stop further work; otherwise sets
 * the `ETag` response header and returns `false` so the caller proceeds to
 * write the body.
 */
export const sendIfNoneMatch = (request: Request, response: Response, etag: string): boolean => {
  const ifNoneMatch = request.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
    response.status(304).end();
    return true;
  }
  response.setHeader("ETag", etag);
  return false;
};
