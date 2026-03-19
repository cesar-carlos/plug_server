# Sincronização com plug_agente - Padrão de Comunicação

Data: 2026-03-19

## Objetivo

Este documento registra as mudanças trazidas do plug_agente (`docs/communication`) para manter
o plug_server alinhado ao protocolo atual.

## Referência do plug_agente

- **Padrão implementado**: `D:\Developer\plug_database\plug_agente\docs\communication\socket_communication_standard.md`
- **Guia de cliente binário**: `plug_agente\docs\communication\socketio_client_binary_transport.md`
- **OpenRPC**: `plug_agente\docs\communication\openrpc.json` (v2.5.0)
- **Schemas**: `plug_agente\docs\communication\schemas\`

## Mudanças aplicadas (v2.5)

### 1. `execution_mode` e `preserve_sql` em `sql.execute`

O agente v2.5 introduziu:

- **`options.execution_mode`**: `managed` (default) ou `preserve`
  - `managed`: permite reescrita gerenciada para paginacao quando aplicavel
  - `preserve`: executa a SQL exatamente como enviada, sem reescrita
- **`options.preserve_sql`**: alias legado para `execution_mode: "preserve"`

**Regras de combinação** (implementadas no plug_server):

- `execution_mode: "preserve"` e `preserve_sql: true` **não podem** ser combinados com
  `page`, `page_size` ou `cursor`
- `body.pagination` não pode ser usado quando `execution_mode: "preserve"` ou `preserve_sql: true`

### 2. Novos campos na response de `sql.execute`

O agente pode retornar (v2.5+ e schema de result):

- **`sql_handling_mode`**: modo efetivo usado (`managed` ou `preserve`)
- **`max_rows_handling`**: política ativa para `max_rows` (ex.: `response_truncation`)
- **`effective_max_rows`**: limite de linhas efetivamente aplicado após negociação (documentado no standard do agente e em `schemas/rpc.result.sql-execute.schema.json`; o bridge repassa o `result` sem remover o campo)

### 3. Atualização de versão

- **api_version**: `2.4` → `2.5` (bridge injeta `api_version: "2.5"`)
- **plugProfile**: `plug-jsonrpc-profile/2.5`

## Arquivos alterados no plug_server

| Arquivo | Alteração |
| ------- | --------- |
| `docs/api_rest_bridge.md` | `execution_mode`, `preserve_sql`, exemplos, api_version 2.5, tabela de gaps, `sql_handling_mode`, `max_rows_handling`, `effective_max_rows`, regra `ORDER BY` para paginacao |
| `src/shared/validators/agent_command.ts` | `execution_mode`, `preserve_sql`, validações de combinação |
| `src/presentation/socket/hub/rpc_bridge.ts` | `api_version: "2.5"` |
| `src/presentation/docs/swagger.ts` | schemas `execution_mode`, `preserve_sql` |
| `src/presentation/http/routes/agents.routes.ts` | exemplo `api_version: "2.5"` |
| `src/socket.ts` | `plugProfile: "plug-jsonrpc-profile/2.5"` |
| `tests/unit/shared/validators/agent_command.test.ts` | testes para `execution_mode`, `preserve_sql`, pagination + preserve |

## Itens já alinhados (sem alteração)

- `execution_order` em `sql.executeBatch` — já suportado
- `rpc.discover` — já suportado
- `sql.cancel` — já suportado
- Paginação (page/page_size, cursor keyset) — já suportado
- `multi_result` — já suportado
- PayloadFrame, GZIP, assinatura — transparente no bridge

## Melhorias aplicadas (2026-03-19) - segunda rodada

- Relay: normalizacao `preserve_sql` e validacao de schema em `dispatchRelayRpcToAgent`
- Limites: `options.timeout_ms` (300000), `options.page_size` (50000)
- Documentacao do relay (contrato, metodos, execution_mode)
- Log de depreciacao para `preserve_sql` (ambiente nao-prod)
- Teste de integracao relay + execution_mode
- Resiliencia do serializer (try/catch em `normalizeAgentRpcResponse`)
- Metricas REST bridge (requests_total, success, failed)
- Teste de database override no contrato

## Melhorias aplicadas (2026-03-19) - primeira rodada

- Validação de conflito `execution_mode: managed` + `preserve_sql: true`
- Normalização `preserve_sql` → `execution_mode: "preserve"` antes de enviar ao agente
- Testes de integração para `execution_mode` e normalização
- Documentação da precedência de `body.pagination` sobre `command.params.options`
- Export de `sqlExecuteOptionsSchema` e `AGENT_MAX_ROWS_LIMIT`
- Validação de `max_rows` contra limite (1.000.000)
- Testes de contrato com payloads válidos do plug_agente

## Melhorias aplicadas (2026-03-19) - terceira rodada (performance e resiliencia)

- **Performance relay**: `cleanupExpiredIdempotency` movido para timer em background (60s)
- **Performance relay**: `percentile()` otimizado com quickselect (O(n) vs O(n log n))
- **Performance relay**: loop redundante de UUID removido em `requestId`
- **REST bridge**: rate limit especifico para `POST /agents/commands` (100 req/min por IP)
- **REST bridge**: metricas de latencia (avg, max, p95, p99)
- **REST bridge**: validacao antecipada de `agentId` (fail-fast)
- **Config**: `SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS` (60_000)
- **Config**: `SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER` (3)
- **Config**: `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` e `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX`
- **Documentacao**: secao "Configuracao e tuning" em `api_rest_bridge.md` (REQUEST_BODY_LIMIT, rate limit, env vars)

## Melhorias aplicadas (2026-03-19) - documentacao alinhada ao plug_agente

- **`api_rest_bridge.md`**: campo `effective_max_rows` na tabela de resultado de `sql.execute` (alinhado a `rpc.result.sql-execute.schema.json`)
- **`api_rest_bridge.md`**: regra explicita de **`ORDER BY` obrigatorio** para paginacao (`page`/`page_size` e `cursor`), referencia ao contrato v2.4+ do agente
- **`api_rest_bridge.md`**: mesma orientacao na secao `pagination` (nivel do body)
- **`communication_sync_plug_agente.md`**: `effective_max_rows` listado nos novos campos de response; tabela de arquivos atualizada

## Melhorias aplicadas (2026-03-19) - `id` JSON-RPC opcional no bridge REST/consumers

- **`ensureJsonRpcIdsForBridge`** (`command_transformers.ts`): se `id` estiver **omitido**, o servidor gera **UUID** antes do dispatch; **`id: null`** continua sendo notification (202 quando tudo e notification).
- **`execute_agent_command.ts`**: aplica o passo acima apos paginacao e `normalizeCommandForAgent` (HTTP e Socket `agents:command`).
- **Relay direto** (`dispatchRelayRpcToAgent`): ja sobrescrevia `id` com UUID interno; sem mudanca.
- **Documentacao**: `api_rest_bridge.md`, OpenAPI em `agents.routes.ts`, testes de integracao e unitarios.

| Arquivo | Alteração |
| ------- | --------- |
| `src/application/agent_commands/command_transformers.ts` | `ensureJsonRpcIdsForBridge` |
| `src/application/agent_commands/execute_agent_command.ts` | chama `ensureJsonRpcIdsForBridge` |
| `docs/api_rest_bridge.md` | semantica `id` omitido vs `null`, batch, gaps |
| `src/presentation/http/routes/agents.routes.ts` | descricao OpenAPI + exemplo batch com `id: null` |
| `tests/integration/agents_http.integration.test.ts` | 200 com id omitido; 202 com `id: null`; batch misto |
| `tests/unit/.../command_transformers.test.ts` | testes do novo transformer |
| `tests/unit/.../agent_command.test.ts` | batch misto com `id: null` explicito |

## Melhorias aplicadas (2026-03-19) - performance bridge, auditoria e metricas

- **`shared/utils/percentile.ts`**: quickselect compartilhado (REST bridge + relay)
- **`shared/utils/latency_ring_buffer.ts`**: amostras de latencia por agente sem `splice`
- **`rpc_bridge.ts`**: indices `streamRequestIdsByConsumer` / `ByAgent`, `relayRequestIdsByConsumer` / `ByAgent`; cleanup O(k); batch ack com `preencodePayloadFrameJson`; acks em `logger.debug`
- **`payload_frame.ts`**: `preencodePayloadFrameJson` + `finishPayloadFrameEnvelope`
- **`socket_audit.service.ts`**: fila + transacao em lote (`SOCKET_AUDIT_BATCH_*`), `flushPendingSocketAuditEvents`, metrica `plug_socket_audit_queued_events`
- **`server.ts`**: flush de auditoria antes do drain no shutdown
- **Docs**: `api_rest_bridge.md` (auditoria batch, acks DEBUG), `CHANGELOG.md`

## Melhorias aplicadas (2026-03-19) - documentacao e observabilidade do `id`

- **`api_rest_bridge.md`**: secao *Hub vs agente direto*; tuning `BRIDGE_LOG_JSONRPC_AUTO_ID`; mapa de arquivos (`command_transformers`)
- **`CHANGELOG.md`**: breaking/migracao (`id` omitido), roadmap `rpc_bridge`
- **`README.md`**: links para CHANGELOG e `api_rest_bridge`
- **`socket_client_sdk.md`**: secao `agents:command` e semantica de `id`
- **`swagger.ts`**: descricoes em `JsonRpcId` e `BridgeCommand`
- **`logger.ts`**: metodo `debug` (somente `NODE_ENV=development`)
- **`env`**: `BRIDGE_LOG_JSONRPC_AUTO_ID`
- **`command_transformers`**: log estruturado ao auto-atribuir `id`
- **Testes**: integracao Socket `agents:command` sem `id`; unicidade de UUIDs em batch

## Próximas sincronizações

Ao atualizar o plug_agente, verificar:

1. `socket_communication_standard.md` — changelog e novos itens
2. `openrpc.json` — versão e métodos
3. `schemas/*.json` — novos campos em params/result
4. `socketio_client_binary_transport.md` — regras de transporte
