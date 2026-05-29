# Runbook: n8n / REST 404 com agente online (multi-replica)

## Sintoma

- n8n (`plugDatabase`, `executeSql`) falha com:
  - *"The selected agent was not found in the active Plug hub registry."*
- HTTP real: **404** em `POST /api/v1/agents/commands`
- plug_agente parece ligado; catálogo PostgreSQL mostra agente `active`

## Causa raiz (confirmado em producao)

O hub guarda agentes ligados em **`agentRegistry` em memória por processo Node**.
Com varias replicas PM2 (4000/4001/4002) e Nginx `ip_hash`:

| Cliente | IP típico | Réplica |
|---------|-----------|---------|
| n8n (REST) | IP do servidor VPS | ex.: 4002 |
| plug_agente (Socket `/agents`) | IP da rede do cliente | ex.: 4000 |

O dispatch REST só vê o registry **local**:

```text
agentRegistry.findByAgentId(agentId) → null → HTTP 404
```

Se a réplica já tivesse visto o agente mas estivesse offline, seria **HTTP 200** com `agent_offline` (`-32000`), não 404.

**Uma única réplica elimina o problema** (teste A/B confirmado).

## Evidências úteis

```bash
# Nginx — 404 no bridge
grep "agents/commands" /var/log/nginx/access.log | grep " 404 "

# PM2 — agente nunca registou na réplica X
grep "<agent-uuid>" /root/.pm2/logs/plug-server-4002-out*.log
```

## Mitigações

### Imediata (recomendada hoje)

**Padrão de produção neste servidor: 2 réplicas** (`4000`–`4001` em `deploy/pm2/ecosystem.config.cjs`).

Para isolar o problema:

1. Uma réplica: `ports = [4000]` em `deploy/pm2/ecosystem.config.cjs`
2. Nginx upstream com um só `server 127.0.0.1:4000;` (sem `ip_hash`)
3. `pm2 delete` réplicas extra; `nginx -t && systemctl reload nginx`

### O que NÃO resolve sozinho

- **`ip_hash`** — sticky por IP do *cliente HTTP*; n8n e plug_agente são clientes diferentes
- **Cookie sticky** — cookies diferentes por cliente (n8n vs app agente)
- **`SOCKET_IO_REDIS_ADAPTER_URL`** — fan-out Socket entre réplicas; **não** partilha `agentRegistry` nem `findAgentSocketById` local

### Correcção permanente (ADR-0010, implementado)

Com **presença Redis** + **forward** de `POST /api/v1/agents/commands`:

1. `SOCKET_IO_REDIS_ADAPTER_URL` (ou `AGENT_HUB_PRESENCE_REDIS_URL`) no `.env`
2. `HUB_INSTANCE_ID` **único** por processo PM2 (`plug-4000`, `plug-4001`, `plug-4002`)
3. `AGENT_HUB_PRESENCE_ENABLED=true` (default)
4. Várias réplicas + Nginx round-robin ou `ip_hash` — REST encaminha para a réplica dona do socket

Métricas: `plug_bridge_forward_*`, `plug_agent_hub_presence_redis_*` em `GET /metrics`.

Ver `docs/adrs/0010-agent-hub-presence-redis.md` e `docs/configuration.md`.

## Multi-replica (padrão: 2)

Com presença Redis activa e `HUB_INSTANCE_ID` por réplica:

```bash
# Padrao: ports = [4000, 4001] em deploy/pm2/ecosystem.config.cjs
# Opcional (apos validar): acrescentar 4002 no ecosystem e no upstream nginx
cd /root/plug_server && npm run build && pm2 start deploy/pm2/ecosystem.config.cjs && pm2 save
nginx -t && systemctl reload nginx
# Aceite: workflow n8n SQL com agente ligado — sem 404; plug_bridge_forward_requests_total > 0 quando IPs diferem
```
