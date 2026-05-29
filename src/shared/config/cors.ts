import type { CorsOptions } from "cors";

import { env } from "./env";

export const buildCorsOptions = (corsOrigins: readonly string[] | "*"): CorsOptions => {
  if (corsOrigins === "*") {
    return { origin: "*", credentials: false };
  }

  const allowed = new Set(corsOrigins);
  return {
    origin: (origin, callback) => {
      // A missing `Origin` header (non-browser clients, same-origin navigations,
      // server-to-server) is always allowed: cross-site browser attacks always
      // carry an `Origin`.
      if (!origin) {
        callback(null, true);
        return;
      }
      // Browsers send the literal string `Origin: null` for opaque origins
      // (sandboxed iframes, some in-app browsers). Reflecting it back together
      // with `credentials: true` is unnecessarily permissive, so it is only
      // accepted outside production. In production an explicit allow-list entry
      // is required instead.
      if (origin === "null") {
        callback(null, env.nodeEnv !== "production");
        return;
      }
      if (allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: true,
  };
};
