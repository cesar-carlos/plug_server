# E2E, benchmark e desempenho: hub (`plug_server`) ↔ agente (`plug_agente`)

## Objetivo

Este documento alinha **dois níveis** de teste/carga:

1. **Benchmark ODBC no agente** — mede `sql.execute`, `multi_result`, batches e streaming **dentro do processo** do `plug_agente` (sem Socket.IO nem HTTP do hub). Pool ODBC, leases e tamanhos de pool são **só** documentados e configurados no repositório `plug_agente`.
2. **Carga através do hub** — consumidores usam REST ou `/consumers`; o hub limita paralelismo **por agente** e pendências globais. Execução SQL e gestão de ligações à BD são **exclusivas** do agente.

Para desempenho com base de dados, o **plug_server** ajusta filas e limites de encaminhamento; o **plug_agente** ajusta pool, concorrência RPC e limites de resultado.

---

## Onde está cada responsabilidade

| Concern | `plug_server` | `plug_agente` |
| ------- | ------------- | ------------- |
| Pool de ligações à BD | *(fora de escopo)* | Toda a configuração e o controlo do pool ODBC |
| Concorrência de `rpc:request` no socket | Encaminha eventos; não executa SQL | Handlers em voo, backpressure, execução |
| Paralelismo de pedidos HTTP ao mesmo `agentId` | `SOCKET_REST_AGENT_MAX_INFLIGHT`, `SOCKET_REST_AGENT_MAX_QUEUE`, `SOCKET_REST_AGENT_QUEUE_WAIT_MS` | O agente escala ou limita recursos internos conforme a sua implementação |
| `multi_result` | Valida e reencaminha; respostas grandes = mais CPU/memória no hub (encode/decode `PayloadFrame`) | Execução multi-recordset, buffers, normalização |
| Streaming / REST materializado | Pull interno + agregação (`SOCKET_REST_STREAM_PULL_WINDOW_SIZE`) | `rpc:chunk` / `rpc:complete`, backpressure |

---

## Benchmark E2E no `plug_agente` (ODBC, `multi_result`)

Ficheiro principal: `test/live/odbc_rpc_benchmark_live_e2e_test.dart` (tags `live`, `benchmark`).

Cenários úteis para **multi-consulta / multi_result**:

- `rpc_sql_execute_multi_result`
- `rpc_sql_execute_multi_result_parallel`

Variáveis e modo de correr (incl. `ODBC_E2E_BENCHMARK`, `ODBC_E2E_REQUIRE_MULTI_RESULT`): ver **`plug_agente`** — `tool/e2e/check_e2e_env.dart` e `test/helpers/e2e_env.dart`.
Isto **não passa pelo `plug_server`**.

### Testes e2e no `plug_server` (comunicação com o agente)

Suíte focada no contrato **hub ↔ plug_agente** (sem ODBC real no servidor):

- Comando: `npm run test:e2e` (Vitest, `vitest.e2e.config.ts`). **Só corre** com `E2E_TESTS_ENABLED=true` no `.env` (ver `.env.example`); caso contrário termina com exit 0 sem executar testes.
- Ficheiros: `tests/e2e/flows/plug_agente_communication.e2e.test.ts` (handshake `/agents`, `PayloadFrame`, heartbeat, readiness explícito com `agent:ready`, `POST /api/v1/agents/commands`, `agents:command`, namespace `/` rejeitado); `tests/e2e/flows/plug_agente_multi_command.e2e.test.ts` (JSON-RPC **batch** REST e Socket, **`sql.executeBatch`** REST e **`agents:command`**, **notificações `id: null`** REST **202** e Socket **`agents:command_response`**, batch **misto** REST e Socket); `tests/e2e/flows/plug_agente_live_server.e2e.test.ts` (hub **real** + agente online quando `E2E_LIVE_AGENT_ID` está no `.env` — health, REST `rpc.discover`, `client_token.getPolicy`, `sql.execute` paginado em `Cliente`, socket `agents:command`).
- Helpers: `tests/e2e/helpers/plug_agente_socket.ts` (`emitAgentRpcResponseWithAck` alinhado com ack do hub), `e2e_hub_fixture.ts`, `auth_tokens.ts`, `consumer_socket.ts`.
- Config: `vitest.e2e.config.ts` — `fileParallelism: false` (menos carga em DB), `E2E_SILENCE_LOGS` → `logger.info` omitido durante e2e (ver `src/shared/utils/logger.ts`).

O agente real é simulado com `socket.io-client` + `encodePayloadFrame`; valida encaminhamento e envelopes, não a execução SQL no `plug_agente`.

---

## Carga com hub no meio (REST ou Socket)

Quando o tráfego vem de `POST /api/v1/agents/commands` ou `agents:command` no `/consumers`:

- O hub aplica **inflight + fila por `agentId`** e o limite global de pendências (`SOCKET_REST_MAX_PENDING_REQUESTS`).
- O agente trata `rpc:request` e **gera erros de recurso** (ex. pool esgotado) no próprio contrato RPC; o hub propaga a resposta ao consumidor.

Para `multi_result` com payloads grandes, atenção no hub a `PAYLOAD_FRAME_*`, gzip assíncrono e memória — ver `docs/performance/performance_hub_agent.md`.

Ferramentas: `autocannon` / `k6` — `docs/performance/load_testing.md`.

---

## Harnesses atuais e limites de cobertura

- `npm run test:perf:socket-bridge`: microbenchmarks de handlers e relay
  Socket.IO real em loopback, incluindo crédito atrasado e consumidor lento.
  Gzip deve ser confirmado por `cmp`, com bytes originais/transmitidos e
  contagem de frames comprimidos. Resultados novos colunares ficam separados
  em `tmp/socket-columnar-bench.json`: versões antigas rejeitavam esses frames.
- `npm run test:perf:rest-api`: HTTP real, Prisma/PostgreSQL e Redis isolados,
  agentes Socket.IO simulados, planos SQL e nove repetições. Não mede Dart/ODBC.
- `RUN_DART_SOCKET_E2E=true RUN_DART_PRODUCTION_TRANSPORT=true npx vitest run
  tests/integration/agent_dart_socket_bridge.integration.test.ts`: processos
  Node/Dart separados, codecs e transporte de produção com gateway determinístico.
  `RUN_DART_ODBC_TRANSPORT=true` acrescenta o smoke ODBC real, somente com DSN
  de teste configurado no agente; ausência/falha não equivale a cobertura simulada.
  O smoke executa somente `SELECT 1 AS n` e encaminha ambos os callbacks do
  gateway: alguns drivers selecionam row-major mesmo com emissão colunar habilitada.
  Essa execução comprova o caminho ODBC real usado pelo driver, não todos os
  tipos e modos colunares nativos de outros drivers.
- O agente mede codecs em nove repetições via
  `test/infrastructure/codecs/transport_repeated_benchmark_test.dart`.
  Pool saturado, envio lento, expiração e reconexão também têm testes com gates.
- Ainda não há benchmark de carga representativa hub+Dart+ODBC com todas as
  métricas e janelas de homologação de 15 minutos executado automaticamente.
  Registre isso como pendência, sem declarar ganho percentual ou validação integral.
- Persistência partilhada de pedidos REST entre réplicas — `docs/api/api_rest_bridge.md` (gaps / réplicas).

---

## Leituras relacionadas

- `docs/performance/load_testing.md`
- `docs/performance/performance_hub_agent.md`
- `docs/api/api_rest_bridge.md` — `multi_result`, overload REST, streaming materializado.
