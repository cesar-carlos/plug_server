/**
 * Alias do perfil de 2 replicas (igual a deploy/pm2/ecosystem.config.cjs, padrao producao).
 * Mantido para testes manuais / scripts que referenciam este ficheiro.
 *
 *   npm run build
 *   pm2 delete plug_server-4000 plug_server-4001 2>/dev/null
 *   PORT=4000 HUB_INSTANCE_ID=plug-4000 NODE_ENV=production pm2 start dist/server.js --name plug_server-4000 --cwd /root/plug_server
 *   PORT=4001 HUB_INSTANCE_ID=plug-4001 NODE_ENV=production pm2 start dist/server.js --name plug_server-4001 --cwd /root/plug_server
 *   (PM2 only auto-loads `ecosystem*.config.cjs` as a multi-app file; this filename is documentation + ports list.)
 *   scripts/test_multi_replica_bridge.py
 */
const path = require("node:path");

const cwd = path.resolve(__dirname, "..", "..");
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
    },
    max_memory_restart: "1G",
    kill_timeout: 10000,
    wait_ready: false,
    autorestart: true,
  })),
};
