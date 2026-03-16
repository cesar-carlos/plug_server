import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";

import { env } from "../config/env";
import { invalidToken } from "../errors/http_errors";
import type { Result } from "../errors/result";
import { tryCatch } from "../errors/try_catch";

// ─── Access token ─────────────────────────────────────────────────────────────

export interface JwtAccessPayload {
  readonly sub: string;
  readonly email?: string;
  readonly role?: string;
  readonly tokenType: "access";
}

export const signAccessToken = (payload: JwtAccessPayload): string => {
  const options: SignOptions = {
    expiresIn: env.jwtAccessExpiresIn as NonNullable<SignOptions["expiresIn"]>,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  };
  return jwt.sign(payload, env.jwtAccessSecret, options);
};

export const verifyAccessToken = (token: string): Result<JwtAccessPayload> => {
  return tryCatch(
    () => {
      const decoded = jwt.verify(token, env.jwtAccessSecret, {
        issuer: env.jwtIssuer,
        audience: env.jwtAudience,
      });
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("sub" in decoded) ||
        decoded.tokenType !== "access"
      ) {
        throw invalidToken("Invalid access token payload");
      }
      return decoded as JwtAccessPayload;
    },
    "Invalid or expired access token",
    { statusCode: 401, code: "INVALID_TOKEN" },
  );
};

// ─── Refresh token ────────────────────────────────────────────────────────────

export interface JwtRefreshPayload {
  readonly sub: string;
  readonly jti: string;
  readonly tokenType: "refresh";
}

export const signRefreshToken = (payload: JwtRefreshPayload): string => {
  const options: SignOptions = {
    expiresIn: env.jwtRefreshExpiresIn as NonNullable<SignOptions["expiresIn"]>,
    jwtid: payload.jti,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  };
  return jwt.sign({ sub: payload.sub, tokenType: "refresh" }, env.jwtRefreshSecret, options);
};

export const verifyRefreshToken = (token: string): Result<JwtRefreshPayload> => {
  return tryCatch(
    () => {
      const decoded = jwt.verify(token, env.jwtRefreshSecret, {
        issuer: env.jwtIssuer,
        audience: env.jwtAudience,
      });
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("sub" in decoded) ||
        !("jti" in decoded) ||
        decoded.tokenType !== "refresh"
      ) {
        throw invalidToken("Invalid refresh token payload");
      }
      return decoded as JwtRefreshPayload;
    },
    "Invalid or expired refresh token",
    { statusCode: 401, code: "INVALID_TOKEN" },
  );
};
