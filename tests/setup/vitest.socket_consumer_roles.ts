/**
 * Integration tests for client realtime (e.g. profile broadcast) require `role: client`
 * JWTs to connect to `/consumers`. Local `.env` may set `SOCKET_CONSUMER_ROLES=user,admin`
 * without `client`; merge it in so tests stay deterministic.
 */
const raw = process.env.SOCKET_CONSUMER_ROLES?.trim();
const roles = new Set(
  (raw !== undefined && raw !== "" ? raw : "user,admin,client")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
roles.add("client");
process.env.SOCKET_CONSUMER_ROLES = [...roles].join(",");
