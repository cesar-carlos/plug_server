# Load testing

Use este guia junto de `docs/performance_hub_agent.md`,
`docs/observability.md` e `docs/e2e_benchmark_hub_agent.md`. O repositorio inclui
um probe Socket leve (`npm run load:socket-bridge`) para smoke/capacidade do hub;
para benchmark profundo de SQL/ODBC, mantenha a carga no repositorio do agente.
O probe tambem cobre os campos do profile 2.11 para medir o custo do transporte
no hub antes de comparar o runtime ODBC do agente.

## Escopo

- **Hub (`plug_server`)**: mede inflight, fila por agente, relay, encode/decode de
  `PayloadFrame`, auditoria, pub/sub `client:custom.*` e overload.
- **Agente (`plug_agente`)**: benchmark ODBC, `multi_result` e carga SQL real vivem
  no repositorio do agente; ver `docs/e2e_benchmark_hub_agent.md`.

## HTTP (REST bridge)

Com token de utilizador valido:

```bash
# Exemplo: autocannon (npm i -g autocannon)
autocannon -m POST -H "Authorization=Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type=application/json" \
  -b '{"agentId":"YOUR_AGENT","command":{"jsonrpc":"2.0","id":"1","method":"rpc.discover","params":{}}}' \
  http://localhost:3000/api/v1/agents/commands
```

Durante o teste, acompanhe `plug_rest_bridge_*`,
`plug_bridge_rpc_method_*`, `plug_socket_relay_rest_dispatch_*` e
`plug_rest_http_rate_limit_*` em `GET /metrics`.

## Socket.IO

Cenarios realistas precisam de **dois lados**:

1. um agente ligado em `/agents`;
2. consumidores ligados em `/consumers`.

Para smoke de latencia, um unico cliente pode stressar `agents:command`, relay ou
pub/sub custom. Para carga representativa, use:

- 200 a 500 sockets em `/consumers`;
- mistura aproximada de `60% client` e `40% user`;
- 30% com conversa relay ativa;
- bursts de `relay:conversation.start`;
- `relay:rpc.request` com requests unicas e retries deduplicados;
- streams com `relay:rpc.chunk` + `relay:rpc.stream.pull`;
- rajadas de `client:agent.profile.updated` para o mesmo `agentId`;
- fan-out de `client:custom.*` com sala vazia, sala media e sala acima de
  `REST_SOCKET_EVENT_MAX_RECIPIENTS`.

O probe leve assume um hub em execucao e tokens ja obtidos:

```bash
HUB_URL=http://localhost:3000 \
CONSUMER_TOKEN=YOUR_ACCESS_TOKEN \
AGENT_ID=YOUR_AGENT \
CONSUMERS=100 \
REQUESTS_PER_CONSUMER=20 \
CONCURRENCY=25 \
MODE=agents-command \
npm run load:socket-bridge

MODE=relay npm run load:socket-bridge
```

### Metodos RPC 2.11

O probe aceita `RPC_METHOD=sql.execute|sql.executeBatch|sql.bulkInsert` para
comparar REST materializado, `agents:command` e relay com o mesmo payload.

Consulta grande com preferencia por streaming no agente:

```bash
HUB_URL=http://localhost:3000 \
CONSUMER_TOKEN=YOUR_ACCESS_TOKEN \
AGENT_ID=YOUR_AGENT \
MODE=relay \
RPC_METHOD=sql.execute \
PREFER_DB_STREAMING=true \
SQL_TEXT="SELECT * FROM heavy_report" \
CONSUMERS=25 \
REQUESTS_PER_CONSUMER=10 \
CONCURRENCY=10 \
npm run load:socket-bridge
```

Comparacao REST materializado vs Socket/relay para o mesmo SQL:

```bash
MODE=rest RPC_METHOD=sql.execute PREFER_DB_STREAMING=true npm run load:socket-bridge
MODE=relay RPC_METHOD=sql.execute PREFER_DB_STREAMING=true npm run load:socket-bridge
```

Relay stream real com `relay:rpc.stream.pull` e backpressure explicito:

```bash
HUB_URL=http://localhost:3000 \
CONSUMER_TOKEN=YOUR_ACCESS_TOKEN \
AGENT_ID=YOUR_AGENT \
MODE=relay-stream \
RPC_METHOD=sql.execute \
PREFER_DB_STREAMING=true \
STREAM_PULL_WINDOW=256 \
STREAM_MAX_PULLS=1000 \
SQL_TEXT="SELECT * FROM heavy_report" \
npm run load:socket-bridge
```

`STREAM_EXPECT_ROWS` e opcional; quando definido, o probe falha se o total
observado no stream nao bater exatamente. O JSON final de `MODE=relay-stream`
inclui latencia, chunks, linhas, bytes recebidos, pulls enviados e p95/p99 do
intervalo entre chunks.

Batch read-only com paralelismo opt-in. Rode a mesma carga com `1`, `2`, `4` e
`8`, observando p95/p99, erros de pool no agente e saturacao de fila:

```bash
MODE=agents-command \
RPC_METHOD=sql.executeBatch \
BATCH_ITEMS=8 \
BATCH_PARALLELISM=4 \
BATCH_SQL_TEXT="SELECT 1" \
npm run load:socket-bridge
```

Bulk insert deve ser medido com tabelas de teste descartaveis. Use tamanhos como
`1000`, `10000` e `50000` linhas por request para comparar contra inserts
tradicionais em batch no agente:

```bash
MODE=agents-command \
RPC_METHOD=sql.bulkInsert \
BULK_INSERT_TABLE=load_test_bulk_insert \
BULK_INSERT_ROW_COUNT=1000 \
BULK_INSERT_COLUMNS_JSON='[{"name":"id","type":"i64"},{"name":"payload","type":"text"}]' \
npm run load:socket-bridge
```

Para `client:custom.*`, `AGENT_ID` nao e necessario. Todos os sockets subscrevem
`CUSTOM_EVENT_NAME`; cada job publica e espera `socket:event.published`:

```bash
HUB_URL=http://localhost:3000 \
CONSUMER_TOKEN=YOUR_CLIENT_ACCESS_TOKEN \
CONSUMERS=100 \
REQUESTS_PER_CONSUMER=20 \
CONCURRENCY=25 \
MODE=custom-event \
CUSTOM_EVENT_NAME=client:custom.load.demo \
IDEMPOTENCY_MODE=unique \
npm run load:socket-bridge
```

`IDEMPOTENCY_MODE` aceita:

- `none`: sem chave, mede fan-out bruto.
- `unique`: uma chave por publicacao, mede lock/escrita idempotente sem replay.
- `shared`: mesma chave para todas as publicacoes, valida replay/conflito sob concorrencia.

Em multi-replica, rode o mesmo teste com e sem `SOCKET_IO_REDIS_ADAPTER_URL` e,
para retries, com `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL` ligado. Compare
`recipients`, taxa de replay, timeouts de lock e latencia p95/p99.

O script reporta sucesso/falha e p50/p95/p99. Em `MODE=relay-stream`, tambem
reporta estatisticas de stream real com pulls. Ele foi desenhado para smoke de
capacidade do bridge; para benchmark de banco/ODBC, manter os testes de carga no
`plug_agente`.

## O que medir

- CPU do processo Node e event-loop lag.
- RSS / heap durante streams SQL grandes no REST materializado.
- `plug_rest_bridge_*` para throughput e falhas REST.
- `plug_bridge_rpc_method_*` para latencia e erro por `channel`, `method` e
  `outcome` (`sql.execute`, `sql.executeBatch`, `sql.bulkInsert`, etc.).
- `plug_socket_relay_outbound_queue_*` para backlog e latencia da fila outbound.
- `plug_socket_relay_chunks_dropped_total` e `plug_socket_relay_circuit_open_rejects_total`.
- `plug_socket_consumers_guard_db_*`.
- `plug_socket_consumers_profile_push_*`.
- `plug_socket_consumers_commands_aborted_on_disconnect_total`.
- `plug_socket_agents_command_rate_limit_weighted_costs_enabled`.
- `plug_socket_custom_event_publish_*` para pub/sub `client:custom.*`.
- `plug_socket_io_redis_adapter_*` quando usar adapter distribuido.
- `plug_socket_custom_event_idempotency_redis_*` quando usar idempotencia Redis.

## Sinais de regressao

- backlog da outbound queue sobe e nao recupera;
- `commands_aborted_on_disconnect_total` cresce com pending preso;
- `guard_db_max_ms` sobe muito durante bursts;
- `profile_push_fanout_max` explode sem aumento proporcional de recipients;
- `503 SERVICE_UNAVAILABLE` por overload fora de picos esperados;
- `plug_socket_relay_dispatch_total_queued_waiters` nao retorna a zero depois de encerrado o burst;
- `plug_socket_custom_event_idempotency_redis_lock_wait_timeouts_total` sobe de forma sustentada;
- `plug_socket_io_redis_adapter_runtime_errors_total` cresce durante carga normal.

## Validacoes operacionais

- bloquear um `User` e um `Client` durante o teste e confirmar desconexao ativa;
- revogar um `ClientAgentAccess` durante stream ativo e confirmar corte da sessao;
- repetir `relay:rpc.request` com o mesmo `client_request_id` e confirmar `deduplicated`;
- repetir `socket:event.publish` com mesma chave/corpo e confirmar `idempotentReplay`;
- repetir `socket:event.publish` com mesma chave/corpo diferente e confirmar `IDEMPOTENCY_KEY_CONFLICT`;
- comparar o comportamento com sticky sessions habilitado e desabilitado;
- comparar `client:custom.*` com Redis adapter ligado e desligado quando houver mais de uma replica.
