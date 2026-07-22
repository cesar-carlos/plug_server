# Sincronizacao com `plug_agente`

## Objetivo

Este documento resume o estado atual de alinhamento entre o `plug_server` e a
documentacao de comunicacao do `plug_agente`.

Ele nao substitui os contratos normativos do hub. Use este ficheiro para:

- saber quais fontes do `plug_agente` devem ser acompanhadas
- ver o que ja esta alinhado no hub
- identificar lacunas intencionais ou operacionais
- seguir um checklist curto quando o protocolo evoluir

Mapa geral da documentacao: `docs/README.md`.

## Fontes de referencia no `plug_agente`

Quando houver um checkout local do repositório irmao, estas sao as referencias
principais:

- `../plug_agente/docs/communication/socket_communication_standard.md`
- `../plug_agente/docs/communication/socketio_client_binary_transport.md`
- `../plug_agente/docs/communication/openrpc.json`
- `../plug_agente/docs/communication/schemas/`

Validacao automatizada no hub: `npm run test:contract`.

## Documentos canonicos no `plug_server`

- `docs/api/api_rest_bridge.md`
- `docs/socket/socket_relay_protocol.md`
- `docs/socket/socket_client_sdk.md`
- `docs/configuration.md`
- `docs/performance/performance_hub_agent.md`
- [`docs/plug_agente/`](plug_agente/) — orientacoes especificas para o
  time do agente: o que muda (ou nao muda) no agente para cada melhoria
  do hub, **mais** roadmap proativo de melhorias cross-repo. Use como
  porta de entrada quando uma mudanca no contrato afetar o
  `plug_agente`.

Regras de negocio de ownership de `Agent`, acesso de `Client` e aprovacao por
owner nao sao mantidas neste resumo de sincronizacao; a fonte canonica para esse
tema e `docs/api/client_agent_business_rules.md`.

Historico detalhado de mudancas: `CHANGELOG.md`.

## Versao do profile

O hub anuncia `extensions.plugProfile = "plug-jsonrpc-profile/2.11.2"` em
`agent:capabilities` (`HUB_TRANSPORT_EXTENSIONS` em
`src/shared/constants/agent_transport_contract.ts`). A versao acompanha o
OpenRPC `info.version` do `plug_agente` quando o suporte e completo no hub.

## Alinhamento atual

| Area | Estado no hub | Fonte principal |
| ---- | ------------- | --------------- |
| Namespace do agente em `/agents` | alinhado | `docs/plug_agente/migracao_plug_agente_namespaces.md` |
| Handshake autenticado e `agent:register` (zod schema) | alinhado | `docs/api/api_rest_bridge.md`, `src/shared/validators/agent_register.ts` |
| Rejeicao de `agent:register` via `agent:register_error` (JSON puro, `{ code, reason, message, details? }`) | alinhado | `docs/plug_agente/migracao_plug_agente_namespaces.md`, `src/presentation/socket/hub/handshake/agent_register_error.ts`; agente classifica por `reason` (`transient_failure`/`rate_limited` recuperaveis; demais forcam reconnect) |
| `agent:session.superseded` (takeover) | alinhado no hub; agente escuta e loga antes do disconnect | `agent_register_error.ts`, runtime `transport_socket_event_binder.dart` |
| Negociacao de capabilities (com hints de stream pull) | alinhado | `docs/socket/socket_relay_protocol.md` |
| Readiness explicito com `agent:ready` | alinhado | `docs/api/api_rest_bridge.md`, `docs/socket/socket_relay_protocol.md` |
| `PayloadFrame` com gzip, assinatura opcional e payload base64 | alinhado | `docs/socket/socket_relay_protocol.md` |
| Keyring HMAC (`PAYLOAD_SIGNING_KEY_ID` ativo + `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON` inbound) | alinhado | `docs/configuration.md`, `src/shared/utils/payload_frame.ts` |
| `rpc:response` invalido com fail-fast | alinhado | `docs/api/api_rest_bridge.md`, `docs/socket/socket_relay_protocol.md` |
| `rpc:chunk` / `rpc:complete` invalidos com fail-fast | alinhado | `docs/api/api_rest_bridge.md`, `docs/socket/socket_relay_protocol.md` |
| `rpc:complete.terminal_status` no REST materializado | alinhado | `docs/api/api_rest_bridge.md` |
| Backpressure relay com encerramento explicito | alinhado | `docs/socket/socket_relay_protocol.md` |
| Pull capability-aware (`recommendedStreamPullWindowSize`, `maxStreamPullWindowSize`) | publicado pelo hub; clamp final usa teto global do hub e menor teto do agente | `docs/socket/socket_relay_protocol.md`, `docs/api/api_rest_bridge.md` |
| `execution_mode`, `preserve_sql`, `prefer_db_streaming`, `effective_max_rows` | alinhado | `docs/api/api_rest_bridge.md` |
| `sql.bulkInsert` (introduzido no perfil 2.10) | alinhado | `docs/api/api_rest_bridge.md`, `docs/socket/socket_relay_protocol.md` |
| `max_parallel_read_only_batch_items` em `sql.executeBatch` | pass-through validado | `src/shared/validators/agent_command.ts` |
| `id` omitido vs `id: null` no bridge | alinhado | `docs/api/api_rest_bridge.md`, `docs/socket/socket_client_sdk.md` |
| `client_token.getPolicy` (introspecao de policy, introduzido no perfil 2.7) com **`Retry-After`** automatico em `-32013` | alinhado | `docs/api/api_rest_bridge.md` |
| `meta.outbound_compression` aceito no schema (no-op no runtime atual, alinhado a v2.8) | tolerancia | `src/shared/validators/agent_command.ts` |
| Teste de contrato contra OpenRPC/schemas do agente | alinhado | `docs/observability/observability.md` |
| `profile_version` no resultado de `agent.getProfile` | hub usa para *pull sync* / consistencia | `docs/api/client_agent_business_rules.md`, `docs/configuration.md`; o JSON Schema publicado em `plug_agente` inclui o campo como opcional e o hub continua tolerando agentes legados que o omitem |
| `agent:profile.update` para self-service do cadastro | alinhado no hub | `docs/api/client_agent_business_rules.md`; patch parcial por socket em `/agents`, com `snake_case` e ack `agent:profile.updated` |
| `observer.*` | fora do contrato atual | reservado para profile futuro; o hub rejeita estes metodos ate o `plug_agente` publicar implementacao, OpenRPC e schemas |
| Transport extensions ADR 0009/0010/0011 | alinhado (2026-06-24) | hub [`560ef2f`](https://github.com/cesar-carlos/plug_server/commit/560ef2f), agente [`741b5677`](https://github.com/cesar-carlos/plug_agente/commit/741b5677); ver [`../plug_agente/docs/plug_server/readme.md`](../../../plug_agente/docs/plug_server/readme.md) |
| `parallelBatchDispatch` em `agent:capabilities` | alinhado (hub anuncia; agente negocia paralelismo em batches REST/`sql.executeBatch`) | `src/shared/constants/agent_transport_contract.ts`, `plug_agente` `ProtocolNegotiator` |
| Gate defensivo `meta.agent_phases` no relay (hub strip quando `agentPhaseTimings` nao negociado) | alinhado hub-only (2026-07-07) | [ADR 0012](../adrs/0012-agent-phase-timings.md), `relay_route_response_forwarder.ts` — **sem mudanca no agente** |
| Erro sintetico `BRIDGE_OUTBOUND_PROCESSING_FAILED` em falha do job outbound relay | alinhado hub-only (2026-07-07) | `docs/socket/socket_relay_protocol.md` — consumer recebe `relay:rpc.response` com `error.data.code` |
| Metricas relay pós-auditoria (`late_response_after_timeout`, `outbound_job_failure_notified`, `parallel_batch_dispatch_negotiated`) | alinhado hub-only (2026-07-07) | `docs/observability/observability.md`, `docs/performance/performance_hub_agent.md` |

## Fontes inversas (`plug_agente` → hub)

Quando o agente passa a depender de comportamento novo no hub, o time do
agente mantem orientacoes em `../plug_agente/docs/plug_server/`:

- [`readme.md`](../../../plug_agente/docs/plug_server/readme.md) — resumo das extensoes
- [`01_transport_extensions.md`](../../../plug_agente/docs/plug_server/01_transport_extensions.md) — contrato tecnico
- [`02_implementation_checklist.md`](../../../plug_agente/docs/plug_server/02_implementation_checklist.md) — checklist de homologacao

Espelho hub → agente: esta pasta [`docs/plug_agente/`](plug_agente/).

## Diferencas intencionais

Estas diferencas nao sao gaps acidentais; fazem parte do desenho atual do hub:

- REST continua sem streaming progressivo para o cliente HTTP.
- O hub materializa streams SQL no REST e recomenda Socket para baixa latencia.
- Parte do estado do bridge e do relay continua em memoria por processo.
- O hub pode preencher `id` omitido no bridge REST e em `agents:command` para
  simplificar integracao do consumer.
- O hub aceita `agent:register` sem `timestamp` por compat com agentes mais
  antigos (o schema publicado marca como obrigatorio); idem para `extensions`
  e `limits` (defaultam a `{}` quando ausentes).
- O bloco `signature.key_id` e marcado como required no
  `payload-frame.schema.json`, mas o hub aceita sem `key_id` somente quando o
  deployment esta em modo single-key sem `PAYLOAD_SIGNING_KEY_ID` e sem
  `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON`.
- `meta.outbound_compression` e aceito no schema do hub apenas como
  forward-compat: o runtime atual do agente declara explicitamente que **nao
  suporta override por request** (ver `socket_communication_standard.md` ->
  "Nota operacional"); o campo nao tem efeito no fio.

Detalhes:

- `docs/api/api_rest_bridge.md`
- `docs/studies/scaling_and_roadmap.md`

## Checklist de sincronizacao

Sempre que o `plug_agente` mudar o contrato de comunicacao:

1. Rever `socket_communication_standard.md` e `socketio_client_binary_transport.md`.
2. Comparar `openrpc.json` com os metodos e versao minima esperada no hub. Para cada **metodo RPC novo ou alterado**, atualizar o hub em conjunto: `src/shared/validators/agent_command.ts` (Zod / `supportedAgentRpcMethods`), `src/presentation/docs/swagger/bridge_schemas.ts` (OpenAPI, incl. `BridgeSingleCommand`), e a documentacao aplicavel (`api_rest_bridge.md`, `socket_relay_protocol.md`, e remissoes em `socket_client_sdk.md` quando a lista de metodos mudar).
3. Revalidar `schemas/*.json` e exemplos com `npm run test:contract`.
4. Atualizar os docs normativos do hub, nao este ficheiro primeiro:
   `api_rest_bridge.md`, `socket_relay_protocol.md`, `socket_client_sdk.md`.
5. So depois ajustar este resumo, se houver mudanca relevante de alinhamento.

## Quando editar este ficheiro

Edite este documento apenas quando houver:

- novo item alinhado ou nova divergencia intencional
- mudanca nas fontes canonicas do `plug_agente`
- alteracao no processo de verificacao

Nao use este ficheiro como changelog detalhado por PR ou por dia. Esse historico
deve ficar no `CHANGELOG.md` e nos documentos normativos do hub.
