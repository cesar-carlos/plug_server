import type { CorsOptions } from "cors";

export const buildCorsOptions = (corsOrigins: readonly string[] | "*"): CorsOptions => {
  if (corsOrigins === "*") {
    return { origin: "*", credentials: false };
  }

  const allowed = new Set(corsOrigins);
  return {
    origin: (origin, callback) => {
      // Browsers send `Origin: null` (literal string) for opaque origins: sandboxed iframes,
      // some mobile/email in-app browsers, and similar contexts. Treat like a missing Origin.
      if (!origin || origin === "null") {
        callback(null, true);
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
