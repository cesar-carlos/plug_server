# ADR 0010: Agent hub presence and inter-replica bridge forward via Redis

- **Status**: Accepted
- **Date**: 2026-05-29

## Context

With multiple hub replicas, `agentRegistry` is in-memory per process. REST
clients (e.g. n8n on the server IP) and agent sockets (e.g. store IP) can land
on different replicas under `ip_hash` or round-robin, so
`POST /api/v1/agents/commands` returns HTTP 404 even when the agent is online
on another replica.

Socket.IO Redis adapter only synchronizes room broadcasts; it does not expose
which replica owns a given `/agents` socket.

## Decision

1. **Distributed presence** — On successful `agent:register`, write
   `agentId → { hubInstanceId, socketId, connectedAtMs, lastSeenAtMs }` to
   Redis with a renewable TTL. On disconnect, delete only when `socketId`
   still matches (takeover-safe). Renew TTL on register and protocol touch.

2. **Inter-replica forward** — When dispatch runs on a replica that does not
   hold the agent locally, resolve presence, publish a command envelope on
   `plug_bridge_cmd:{plug}[:tenant]:<hubInstanceId>`, and await a reply on
   `plug_bridge_reply:{plug}[:tenant]:<correlationId>` with a configurable
   timeout.

3. **Identity** — Each PM2 process must set a unique `HUB_INSTANCE_ID` when
   presence is active in production.

4. **Redis URL** — `AGENT_HUB_PRESENCE_REDIS_URL` when set; otherwise
   `SOCKET_IO_REDIS_ADAPTER_URL`. Presence is off when the resolved URL is
   empty or `AGENT_HUB_PRESENCE_ENABLED=false`.

5. **Fail-open (ADR-0001)** — Boot or runtime Redis failures disable presence
   and forward; the hub keeps local-only `agentRegistry` behaviour.
   Operators should alert on `plug_agent_hub_presence_redis_fallback_events_total`
   and related `plug_agent_hub_presence_*` gauges — fail-open must not be silent
   in production multi-replica deployments.

## Key layout

- Presence: `plug_agent_presence:{plug}[:tenant]:agent:<agentId>`
- Command channel: `plug_bridge_cmd:{plug}[:tenant]:<hubInstanceId>`
- Reply channel: `plug_bridge_reply:{plug}[:tenant]:<correlationId>`

All keys include the `{plug}` hash tag via `redisKeyNamespace()`.

## Scope (v1)

- `POST /api/v1/agents/commands` and shared `dispatchRpcCommandToAgent` used
  by `agents:command` (**unary** only when forwarded). Commands that bind live
  `streamHandlers` (Socket `agents:command` streaming) refuse cross-replica
  forward with HTTP/socket **503** and require sticky affinity to the owning hub.
- `isAgentConnectedToHub` reads Redis when presence is active.

Out of scope: relay `conversationRegistry` (sticky affinity required;
`relay:conversation.start` returns **503** when presence shows another hub —
not the same as agent offline **404**), cross-node pending REST
materialization, cluster-wide `GET /agents` listing, streaming chunk relay over
Redis.

## Requirements for multi-replica production

- Unique `HUB_INSTANCE_ID` per replica.
- Resolved presence Redis URL (typically same cluster as Socket.IO adapter).
- Boot aborts in production when presence is enabled and `HUB_INSTANCE_ID` is
  empty.

## Alternatives considered

- **Nginx hash by agentId** — Does not help REST from n8n without agent id in
  routing; rejected as sole fix.
- **Sticky sessions only** — Insufficient when client IPs differ; rejected.
- **Fail-closed when Redis down** — Rejected per ADR-0001; operators alert on
  `plug_agent_hub_presence_*` fallback metrics instead.
