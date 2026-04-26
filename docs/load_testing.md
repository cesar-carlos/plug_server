# Load testing

Este repositório não inclui um runner de carga fixo. Use ferramentas externas para
validar o hub e combine este guia com `docs/performance_hub_agent.md`,
`docs/observability.md` e `docs/e2e_benchmark_hub_agent.md`.

## Escopo

- **Hub (`plug_server`)**: mede inflight, fila por agente, relay, encode/decode de
  `PayloadFrame`, auditoria e overload.
- **Agente (`plug_agente`)**: benchmark ODBC, `multi_result` e carga SQL real vivem
  no repositório do agente; ver `docs/e2e_benchmark_hub_agent.md`.

## HTTP (REST bridge)

Com token de utilizador válido:

```bash
# Exemplo: autocannon (npm i -g autocannon)
autocannon -m POST -H "Authorization=Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type=application/json" \
  -b '{"agentId":"YOUR_AGENT","command":{"jsonrpc":"2.0","id":"1","method":"rpc.discover","params":{}}}' \
  http://localhost:3000/api/v1/agents/commands
```

Durante o teste, acompanhe `plug_rest_bridge_*`,
`plug_socket_relay_rest_dispatch_*` e `plug_rest_http_rate_limit_*` em
`GET /metrics`.

## Socket.IO

Cenarios realistas precisam de **dois lados**:

1. um agente ligado em `/agents`;
2. consumidores ligados em `/consumers`.

Para smoke de latencia, um unico cliente pode stressar `agents:command` ou relay
apos login HTTP. Para carga representativa, use:

- 200 a 500 sockets em `/consumers`;
- mistura aproximada de `60% client` e `40% user`;
- 30% com conversa relay ativa;
- bursts de `relay:conversation.start`;
- `relay:rpc.request` com requests únicas e retries deduplicados;
- streams com `relay:rpc.chunk` + `relay:rpc.stream.pull`;
- rajadas de `client:agent.profile.updated` para o mesmo `agentId`.

## O que medir

- CPU do processo Node e event-loop lag.
- RSS / heap durante streams SQL grandes no REST materializado.
- `plug_rest_bridge_*` para throughput e falhas REST.
- `plug_socket_relay_outbound_queue_*` para backlog e latencia da fila outbound.
- `plug_socket_relay_chunks_dropped_total` e `plug_socket_relay_circuit_open_rejects_total`.
- `plug_socket_consumers_guard_db_*`.
- `plug_socket_consumers_profile_push_*`.
- `plug_socket_consumers_commands_aborted_on_disconnect_total`.

## Sinais de regressao

- backlog da outbound queue sobe e nao recupera;
- `commands_aborted_on_disconnect_total` cresce com pending preso;
- `guard_db_max_ms` sobe muito durante bursts;
- `profile_push_fanout_max` explode sem aumento proporcional de recipients;
- `503 SERVICE_UNAVAILABLE` por overload fora de picos esperados.

## Validacoes operacionais

- bloquear um `User` e um `Client` durante o teste e confirmar desconexao ativa;
- revogar um `ClientAgentAccess` durante stream ativo e confirmar corte da sessao;
- repetir `relay:rpc.request` com o mesmo `client_request_id` e confirmar `deduplicated`;
- comparar o comportamento com sticky sessions habilitado e desabilitado.
