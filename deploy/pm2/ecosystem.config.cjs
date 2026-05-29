/**
 * Multi-replica runner for the plug_server hub (uses all CPU cores).
 *
 * The hub is single-threaded per process, so we run one fork per core on
 * separate ports; nginx load-balances across 4000/4001 by default (round-robin).
 * Cross-replica Socket.IO fan-out, shared rate limits and distributed
 * idempotency require Redis (see SOCKET_IO_REDIS_ADAPTER_URL etc. in .env).
 *
 * `dotenv` does NOT override variables already present in the environment, so
 * the per-app PORT below takes precedence over PORT in .env.
 *
 * Usage:
 *   pm2 start deploy/pm2/ecosystem.config.cjs
 *   pm2 save && pm2 startup        # persist across reboots
 *   pm2 reload plug_server          # zero-downtime rolling restart
 */
const path = require("node:path");

const cwd = path.resolve(__dirname, "..", "..");
// Producao padrao: 2 replicas (estavel). Requer SOCKET_IO_REDIS_ADAPTER_URL + presenca/forward (ADR-0010).
// HUB_INSTANCE_ID=plug-{port}. Para 3 replicas: ports = [4000, 4001, 4002] apos validar em carga.
const ports = [4000, 4001];

module.exports = {
  apps: ports.map((port) => ({
    name: `plug_server-${port}`,
    cwd,
    script: "dist/server.js",
    exec_mode: "fork",
    instances: 1,
    env: {
      NODE_ENV: "production",
      PORT: String(port),
      HUB_INSTANCE_ID: `plug-${port}`,
      AGENT_HUB_CLUSTER_INSTANCE_IDS: "plug-4000,plug-4001",
    },
    max_memory_restart: "1G",
    kill_timeout: 10000,
    wait_ready: false,
    autorestart: true,
  })),
};
