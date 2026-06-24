/**
 * Force test-deterministic env before any `src/` import (see vitest.config setup order).
 * Local `.env` may tune performance flags; tests assume `.env.example` defaults for
 * immediate revalidation, agent-access cache TTL, and profile push behaviour.
 */
process.env.SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS = "0";
process.env.SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS = "0";
process.env.AGENT_ACCESS_CACHE_TTL_MS = "30000";
process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED = "true";
process.env.SWAGGER_ENABLED = "true";
process.env.REST_GLOBAL_RATE_LIMIT_MAX = "0";
process.env.REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_MAX = "0";
