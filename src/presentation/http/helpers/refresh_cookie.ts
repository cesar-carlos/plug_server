import type { CookieOptions, Request, Response } from "express";

import { env } from "../../../shared/config/env";
import { parseExpiryToMs } from "../../../shared/utils/date";

/**
 * Cookie options shared by the user (`/auth`) and client (`/client-auth`)
 * refresh-token cookies.
 *
 * - `httpOnly: true` — never readable from JS.
 * - `secure` — required when running in production (TLS termination).
 * - `sameSite: "strict"` — blocks cross-site automatic sending (CSRF defense).
 * - `path: "/"` — both `/auth/*` and `/api/v1/auth/*` aliases see the cookie.
 *   Hardening to a stricter path is intentionally NOT done here because the
 *   server exposes auth under both prefixes and a cookie can only declare one
 *   path. `httpOnly + sameSite=strict` already blocks the relevant attacks.
 * - `maxAge` — derived from the matching JWT_*_EXPIRES_IN so the browser drops
 *   the cookie when the token can no longer be refreshed (avoids stale cookies
 *   that survive past server-side revocation horizons).
 */
const buildBaseOptions = (maxAgeMs: number): CookieOptions => ({
  httpOnly: true,
  secure: env.nodeEnv === "production",
  sameSite: "strict",
  path: "/",
  maxAge: maxAgeMs,
});

const refreshTokenMaxAgeMs = (): number => {
  try {
    return parseExpiryToMs(env.jwtRefreshExpiresIn);
  } catch {
    // Conservative fallback: 7 days. Mirrors the historical default and avoids
    // turning every request into an error if the env value is malformed.
    return 7 * 24 * 60 * 60 * 1000;
  }
};

export const setRefreshCookie = (response: Response, name: string, token: string): void => {
  response.cookie(name, token, buildBaseOptions(refreshTokenMaxAgeMs()));
};

export const clearRefreshCookie = (response: Response, name: string): void => {
  // Express-strict: when clearing a cookie, the same options that were used to
  // set it (path, secure, sameSite, httpOnly, domain) must be passed otherwise
  // some browsers ignore the deletion and keep sending the cookie.
  response.clearCookie(name, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    path: "/",
  });
};

/**
 * Resolves the refresh token following the documented `RefreshTokenTransport`
 * precedence: a non-empty JSON body field wins over the HttpOnly cookie
 * (`body > cookie`). Shared by the user (`/auth`) and client (`/client-auth`)
 * refresh/logout controllers so the precedence rule lives in one place.
 */
export const getRefreshTokenFromRequest = (
  request: Request,
  body: { readonly refreshToken?: string | undefined } | undefined,
  cookieName: string,
): string | undefined => {
  const bodyToken = body?.refreshToken;
  if (typeof bodyToken === "string" && bodyToken.trim() !== "") {
    return bodyToken;
  }
  const cookieToken = (request.cookies as Record<string, unknown> | undefined)?.[cookieName];
  if (typeof cookieToken === "string" && cookieToken.trim() !== "") {
    return cookieToken;
  }
  return undefined;
};
