/**
 * Production PM2 profile: single hub process on port 4000.
 *
 * `dotenv` does not override variables already present in the environment, so
 * the PORT below takes precedence over PORT in .env.
 *
 * Usage:
 *   npm install
 *   npm run build
 *   pm2 start deploy/pm2/ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *   pm2 reload plug_server
 *
 * `postinstall` runs `sync:swagger-static` when /var/lib/plug_server exists.
 */
const fs = require("node:fs");
const path = require("node:path");

const cwd = path.resolve(__dirname, "..", "..");
const nvmrcVersion = fs.readFileSync(path.join(cwd, ".nvmrc"), "utf8").trim();
const nvmNode = path.join(
  process.env.HOME || "/root",
  ".nvm/versions/node",
  `v${nvmrcVersion}`,
  "bin/node",
);

module.exports = {
  apps: [
    {
      name: "plug_server",
      cwd,
      script: "dist/server.js",
      interpreter: fs.existsSync(nvmNode) ? nvmNode : "node",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: "4000",
        HUB_INSTANCE_ID: "plug-4000",
        UV_THREADPOOL_SIZE: "8",
        NODE_OPTIONS: "--max-old-space-size=1536",
      },
      max_memory_restart: "2G",
      kill_timeout: 10000,
      wait_ready: true,
      autorestart: true,
    },
  ],
};
