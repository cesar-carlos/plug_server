import "dotenv/config";

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Tune pool via URL query: connection_limit, pool_timeout (see docs/configuration.md).
    url: env("DATABASE_URL"),
  },
});
