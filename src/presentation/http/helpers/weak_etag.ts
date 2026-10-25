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
 * Sets ETag before checking Express freshness (including tag lists, HEAD and
 * Cache-Control). Returns `true` after `304 Not Modified`; otherwise the caller
 * proceeds to write the body. Both 200 and 304 retain the response validator.
 */
export const sendIfNoneMatch = (request: Request, response: Response, etag: string): boolean => {
  response.setHeader("ETag", etag);
  if (request.fresh) {
    response.status(304).end();
    return true;
  }
  return false;
};

/** Default Express JSON settings allow hashing and sending the exact same serialization. */
export const sendJsonWithWeakETag = (
  request: Request,
  response: Response,
  payload: unknown,
): void => {
  if (
    response.app.get("json replacer") !== undefined ||
    response.app.get("json spaces") !== undefined ||
    response.app.get("json escape") !== undefined
  ) {
    if (!sendIfNoneMatch(request, response, buildWeakETag(payload)))
      response.status(200).json(payload);
    return;
  }
  const json = JSON.stringify(payload);
  const etag = `W/"${createHash("sha1").update(json).digest("base64")}"`;
  if (sendIfNoneMatch(request, response, etag)) return;
  if (!response.getHeader("Content-Type")) response.type("application/json");
  response.status(200).send(json);
};
