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

> As referências a `plug_agente/docs/plug_server/` são históricas e pertencem
> ao outro repositório; esse diretório não está disponível no checkout local
> revisado em 24/10/2026. Não são evidência de validação atual.

## Fontes de referencia no `plug_agente`

Quando houver um checkout local do repositório irmao, estas sao as referencias
principais:

- `../plug_agente/docs/communication/socket_communication_standard.md`
- `../plug_agente/docs/communication/socket_communication_roadmap.md`
- `../plug_agente/docs/communication/socket_communication_backlog.md`
- `../plug_agente/docs/communication/action_io.md`
- `../plug_agente/docs/communication/socket_agent_actions.md`
- `../plug_agente/docs/communication/source_discovery.md`
- `../plug_agente/docs/communication/sql_operations.md`
- `../plug_agente/docs/communication/socketio_client_binary_transport.md`
- `../plug_agente/docs/communication/openrpc.json`
- `../plug_agente/docs/communication/schemas/`

Validação automatizada no hub: `npm run test:contract`. Em gates entre projetos,
defina `REQUIRE_PLUG_AGENTE_CONTRACT=true`; ausência do checkout deve falhar,
não ser interpretada como paridade comprovada.

## Documentos canonicos no `plug_server`

- `docs/api/api_rest_bridge.md`
- `docs/socket/socket_relay_protocol.md`
- `docs/socket/socket_client_sdk.md`
- `docs/configuration.md`
- `docs/performance/performance_hub_agent.md`
- [esta pasta](./) — orientacoes especificas para o
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
OpenRPC `info.version` do `plug_agente`. A versão anunciada não comprova,
isoladamente, cobertura completa de integração ou homologação.

## Alinhamento atual

Revisão documental de 30/10/2026: OpenRPC do checkout irmão permanece em
**2.11.2**. Os 156 testes de contrato do hub passaram com
`REQUIRE_PLUG_AGENTE_CONTRACT=true`, incluindo paridade dos schemas, fixtures
compartilhadas de I/O e exemplos REST/JSON-RPC. Essa verificação não é uma nova
execução nativa ponta a ponta nem comprovação dos gates de produção.

Revisão de comunicação de 2026-10-03: profile **2.11.2** preservado.
As correções abaixo são de implementação, sem métodos novos no discover ou
endurecimento incidental dos schemas públicos.

Revisão de paridade de 2026-10-24, ainda no perfil **2.11.2** e sem método novo
em `rpc.discover`. O hub valida dialetos `postgres`, `mssql` e `sybase`,
`offset`/`pageSize` obrigatórios em `sql.describeSchema` e `schema` não nulo no
pedido. `SCHEMA_UNAVAILABLE` (`-32603`) é falha interna do agente; o hub
preserva o `id`. `failureCode` e os tetos UTF-8 de 1 MiB por SQL e 2 MiB no
plano coincidem. O contrato MCP 2.0.0 registra o estreitamento; o artefato
1.15.0 permanece. A revisão não conclui a homologação coordenada nem libera
persona-v2. O backlog do agente mantém `execution_mode` fora de
`sql.executeBatch` e `agent.autoUpdate.diagnostics.push` fora do discover.

| Caminho | Representação e garantia | Validação / pendência |
| --- | --- | --- |
| Agente → hub, chunks colunares | JSON UTF-8 em `PayloadFrame`; `rows: []` pode coexistir com `columnar` desde `ODBC_STREAM_COLUMNAR_WIRE`, mesmo sem wire-only | Fixture produzida pelo codec Dart; vetores e orçamentos verificados antes de expandir |
| Hub → REST / `agents:command` / relay | Row maps atuais; `rows` não vazio prevalece; `columnar` removido; transformação exige reencode e nova assinatura | Testes de codec, sequenciamento, materialização e transporte; não anunciar capability colunar ao cliente |
| Pool Dart / emissores | Encerramento imediato, conclusão única, TTL invalida produtor, callback vinculado à instância e fila FIFO limitada | Testes determinísticos de startup, falha, envio lento, substituição e 20 mil ciclos |
| Heartbeat / controle | Preparação única; pulls e ACKs em sequências independentes por sessão; resultados antigos descartados | Gates de encode/decode, relógio controlado e codecs assinados/gzip |
| CI cruzada | Checkouts dos dois projetos, revisions registradas, contrato irmão obrigatório no gate | Acesso ao checkout privado necessário; indisponibilidade deve falhar |
| ODBC / homologação | Gateway determinístico valida transporte; smoke separado usa ODBC real e `SELECT 1 AS n` | SQL Anywhere selecionou row-major; não comprova todos os tipos colunares nativos. Janelas de 15 minutos ainda pendentes |

Promover primeiro o hub normalizador com emissão colunar desligada. Habilitar
a configuração existente do agente após validar as revisions dos dois lados.
ADRs e estudos permanecem registros históricos; este documento e os contratos
Socket/REST descrevem a implementação atual.

### Evidências e escopo da revisão

O [snapshot da candidata anterior](../archive/communication_candidate_validation.md)
preserva resultados e limitações das revisions f39752f/55da4490. Ele não é o
resultado dos testes atuais do agente. A aceitação de I/O e suas limitações estão
na [referência de integração](remote_action_io_specification.md#verification).
Gates de desempenho, publicação e aceitação coordenada permanecem independentes.

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
| `sql.cancel` (streaming, materializado, batch e fila; token da mesma credencial; mismatch `-32002` / `cancel_token_mismatch`) | alinhado (2026-09-26) | `docs/api/api_rest_bridge.md`; hub aceita `client_token` / `clientToken` / `auth` em `sql.cancel` e encaminha |
| `agent.action.*` and faithful I/O | Implemented; planned development acceptance complete, default-off | run/validateRun accept trigger_id and negotiated io; see [integration reference](remote_action_io_specification.md). |
| `sql.bulkInsert` (perfil 2.10; chunked `executeDirect` atomico) | alinhado | falha parallel/BCP pode deixar escrita parcial — `docs/api/api_rest_bridge.md`, `docs/socket/socket_relay_protocol.md`, `docs/performance/load_testing.md` |
| Promocao de `SELECT` materializado para chunks | alinhado (nota) | sem paginacao/cursor/`multi_result`, o agente pode abrir stream acima do menor entre 512 KiB e 1/4 de `max_decoded_payload_bytes`; REST continua a materializar |
| `-32013` `outbound_response_capacity_exceeded` | pass-through | agente segura resposta ja aceita quando o hub esta lento; o hub nao reescreve o comando |
| Heartbeat `trace_id` + epoca de sessao | alinhado | hub espelha `trace_id` em `hub:heartbeat_ack`; ACK de sessao anterior nao reinicia liveness no agente |
| GZIP `auto` com cache negativa e gunzip limitado | alinhado (interno) | mesma cache do agente (evento + faixa log2, 30s, sem conteudo); gunzip para no menor teto ja existente (`originalSize`, 10 MiB, razao de inflacao). Sem campo novo no fio |
| Sessao perdida no reconnect L0 | alinhado | agente nao reenvia respostas da geracao anterior; hub encerra REST com 503 e relay com `AGENT_DISCONNECTED` |
| `agent.getHealth` contadores de processo (pos-2.11.2) | pass-through | campos aditivos (`process_*`, `process_start_duration_ms`); snapshot sem SQL, parametros, connection string, PID nem mensagem crua do driver |
| Rotacao de token opaco e `all_permissions` | nota de consumer | mudanca efetiva de permissao SQL, database, escopo de acao ou allowlist rotaciona o token no agente; `all_permissions` nao e bypass; so `token_revoked` pede refresh do JWT do hub |
| `max_parallel_read_only_batch_items` em `sql.executeBatch` | pass-through validado | `src/shared/validators/agent_command.ts` |
| `id` omitido vs `id: null` no bridge | alinhado | `docs/api/api_rest_bridge.md`, `docs/socket/socket_client_sdk.md` |
| `client_token.getPolicy` (introspecao de policy, introduzido no perfil 2.7) com **`Retry-After`** automatico em `-32013` | alinhado | `docs/api/api_rest_bridge.md` |
| `meta.outbound_compression` aceito no schema (no-op no runtime atual, alinhado a v2.8) | tolerancia | `src/shared/validators/agent_command.ts` |
| Teste de contrato contra OpenRPC/schemas do agente | alinhado | `docs/observability/observability.md` |
| `profile_version` no resultado de `agent.getProfile` | hub usa para *pull sync* / consistencia | `docs/api/client_agent_business_rules.md`, `docs/configuration.md`; o JSON Schema publicado em `plug_agente` inclui o campo como opcional e o hub continua tolerando agentes legados que o omitem |
| Dialetos de fonte e operação (`postgres`, `mssql`, `sybase`) | alinhado (2026-10-24) | `src/shared/validators/source_discovery.ts` recusa `firebird` em `expectedSource` e no resultado de `sql.describeSource` |
| `sql.describeSchema` `offset` / `pageSize` explícitos | alinhado (2026-10-24) | `src/shared/validators/source_schema.ts` exige os inteiros, sem default |
| `resources[].schema` no pedido de `sql.describeSchema` | alinhado (2026-10-24) | o pedido exige string; no resultado, `null` continua válido |
| `SCHEMA_UNAVAILABLE` / `-32603` | pass-through | falha interna do agente quando o schema JSON obrigatório falta ou é inválido; o hub preserva o `id` |
| `agent:profile.update` para self-service do cadastro | canal pronto no hub; o runtime desktop do agente ainda sincroniza perfil por REST `PATCH /api/v1/agents/{agentId}/profile` | `docs/api/client_agent_business_rules.md`; patch parcial por socket em `/agents`, com `snake_case` e ack `agent:profile.updated` |
| `agent.autoUpdate.diagnostics.push` | ingestao no hub, flag desligada por defeito; fora de `rpc.discover` e do bridge do consumer | notificacao sem `id` em `rpc:request` no `/agents`; `AGENT_AUTO_UPDATE_DIAGNOSTICS_*` em `docs/configuration.md`. O OpenRPC do agente ainda nao publica o metodo |
| `observer.*` | fora do contrato atual | reservado para profile futuro; o hub rejeita estes metodos ate o `plug_agente` publicar implementacao, OpenRPC e schemas |
| Transport extensions ADR 0009 / 0011 / 0012 (0010 e presenca Redis, nao phase timings) | alinhado (2026-06-24) | hub [`560ef2f`](https://github.com/cesar-carlos/plug_server/commit/560ef2f), agente [`741b5677`](https://github.com/cesar-carlos/plug_agente/commit/741b5677); ver `plug_agente/docs/plug_server/readme.md` |
| `parallelBatchDispatch` em `agent:capabilities` | alinhado (hub anuncia; agente negocia paralelismo em batches REST/`sql.executeBatch`) | `src/shared/constants/agent_transport_contract.ts`, `plug_agente` `ProtocolNegotiator` |
| Gate defensivo `meta.agent_phases` no relay (hub strip quando `agentPhaseTimings` nao negociado) | alinhado hub-only (2026-07-07) | [ADR 0012](../adrs/0012-agent-phase-timings.md), `relay_route_response_forwarder.ts` — **sem mudanca no agente** |
| Erro sintetico `BRIDGE_OUTBOUND_PROCESSING_FAILED` em falha do job outbound relay | alinhado hub-only (2026-07-07) | `docs/socket/socket_relay_protocol.md` — consumer recebe `relay:rpc.response` com `error.data.code` |
| Metricas relay pós-auditoria (`late_response_after_timeout`, `outbound_job_failure_notified`, `parallel_batch_dispatch_negotiated`) | alinhado hub-only (2026-07-07) | `docs/observability/observability.md`, `docs/performance/performance_hub_agent.md` |

## Fontes inversas (`plug_agente` → hub)

As fontes atuais do agente estão em `../plug_agente/docs/communication/`,
listadas acima. A antiga pasta `docs/plug_server/` é referência histórica; não
deve orientar novas implementações. Consulte `readme.md`, o standard, OpenRPC,
schemas e os guias específicos de I/O e operações SQL.

Espelho hub → agente: [índice de integração](README.md).

## Diferencas intencionais

Estas diferencas nao sao gaps acidentais; fazem parte do desenho atual do hub:

- REST continua sem streaming progressivo para o cliente HTTP. I/O de processos
  usa páginas persistidas por `readIo`, com espera longa e retomada por cursor,
  sem materializar a saída inteira como um stream SQL.
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
