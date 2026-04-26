import type { CorsOptions } from "cors";

export const buildCorsOptions = (corsOrigins: readonly string[] | "*"): CorsOptions => {
  if (corsOrigins === "*") {
    return { origin: "*", credentials: false };
  }

  const allowed = new Set(corsOrigins);
  return {
    origin: (origin, callback) => {
      if (!origin) {
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
