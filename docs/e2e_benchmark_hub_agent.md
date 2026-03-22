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

Variáveis e modo de correr (incl. `ODBC_E2E_BENCHMARK`, `ODBC_E2E_REQUIRE_MULTI_RESULT`): ver **`plug_agente`** — `tool/check_e2e_env.dart` e `test/helpers/e2e_env.dart`.  
Isto **não passa pelo `plug_server`**.

### Testes e2e no `plug_server` (comunicação com o agente)

Suíte focada no contrato **hub ↔ plug_agente** (sem ODBC real no servidor):

- Comando: `npm run test:e2e` (Vitest, `vitest.e2e.config.ts`). **Só corre** com `E2E_TESTS_ENABLED=true` no `.env` (ver `.env.example`); caso contrário termina com exit 0 sem executar testes.
- Ficheiros: `tests/e2e/flows/plug_agente_communication.e2e.test.ts` (handshake `/agents`, `PayloadFrame`, heartbeat, `POST /api/v1/agents/commands`, `agents:command`, namespace `/` rejeitado); `tests/e2e/flows/plug_agente_multi_command.e2e.test.ts` (JSON-RPC **batch** REST e Socket, **`sql.executeBatch`** REST e **`agents:command`**, **notificações `id: null`** REST **202** e Socket **`agents:command_response`**, batch **misto** REST e Socket).
- Helpers: `tests/e2e/helpers/plug_agente_socket.ts` (`emitAgentRpcResponseWithAck` alinhado com ack do hub), `e2e_hub_fixture.ts`, `auth_tokens.ts`, `consumer_socket.ts`.
- Config: `vitest.e2e.config.ts` — `fileParallelism: false` (menos carga em DB), `E2E_SILENCE_LOGS` → `logger.info` omitido durante e2e (ver `src/shared/utils/logger.ts`).

O agente real é simulado com `socket.io-client` + `encodePayloadFrame`; valida encaminhamento e envelopes, não a execução SQL no `plug_agente`.

---

## Carga com hub no meio (REST ou Socket)

Quando o tráfego vem de `POST /api/v1/agents/commands` ou `agents:command` no `/consumers`:

- O hub aplica **inflight + fila por `agentId`** e o limite global de pendências (`SOCKET_REST_MAX_PENDING_REQUESTS`).
- O agente trata `rpc:request` e **gera erros de recurso** (ex. pool esgotado) no próprio contrato RPC; o hub propaga a resposta ao consumidor.

Para `multi_result` com payloads grandes, atenção no hub a `PAYLOAD_FRAME_*`, gzip assíncrono e memória — ver `docs/performance_hub_agent.md`.

Ferramentas: `autocannon` / `k6` — `docs/load_testing.md`.

---

## O que o `plug_server` ainda não inclui

- Runner de benchmark integrado hub+agente+BD neste repositório (`tests/e2e/` = smoke de arranque).
- Persistência partilhada de pedidos REST entre réplicas — `docs/api_rest_bridge.md` (gaps / réplicas).

---

## Leituras relacionadas

- `docs/load_testing.md`
- `docs/performance_hub_agent.md`
- `docs/api_rest_bridge.md` — `multi_result`, overload REST, streaming materializado.
