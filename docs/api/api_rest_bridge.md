# REST Bridge - POST /api/v1/agents/commands

## Endpoint relacionado: GET /api/v1/agents

Lista os agentes **registrados** no namespace `/agents` (nao apenas conectados).
Requer `Authorization: Bearer <token>`. Em ambiente nao-producao, a resposta inclui
`_diagnostic.socketConnectionsInAgentsNamespace` (conexoes brutas no namespace) para
ajudar a debugar quando o agente conecta mas nao emite `agent:register` corretamente.

## Objetivo

Esta rota e o ponto unico de entrada HTTP para enviar comandos a um agente
conectado via Socket.IO. O servidor atua como proxy: recebe o request REST,
valida, empacota em `PayloadFrame`, emite via Socket.IO no namespace `/agents`
para o agente, aguarda a resposta e devolve ao cliente HTTP.

Este documento e normativo para o contrato REST e para o canal legado
`agents:*`. Regras de negocio de ownership, aprovacao de `Client`, revogacao,
conta ativa e autorizacao por principal vivem em
`docs/api/client_agent_business_rules.md`. Para o mapa geral da documentacao, ver
`docs/README.md`.

## Como ler este documento

Use este arquivo para:

- contrato da rota `POST /api/v1/agents/commands`
- comportamento do canal legado `agents:*` no consumer
- exemplos de payload, respostas e erros HTTP/JSON-RPC
- limites e escolhas especificas do bridge REST

Para a descricao viva de schemas HTTP, exemplos adicionais e rotas vizinhas
(`GET /api/v1/agents`, `PATCH /api/v1/agents/{agentId}/profile`, catalogo e afins),
consulte tambem o OpenAPI em `GET /docs` e `GET /docs.json`.

Use outros docs para:

- `docs/api/client_agent_business_rules.md`: ownership, aprovacao, revogacao e autorizacao
- `docs/socket/socket_relay_protocol.md`: relay `relay:*`
- `docs/configuration.md`: defaults e fonte de verdade das variaveis
- `docs/performance/performance_hub_agent.md`: tuning e operacao sob carga
- `docs/observability/observability.md`: metricas, traces e alertas

### Erros e fases do handshake Socket

Fases tipicas (apos o TCP/WebSocket do Socket.IO):

1. **Middleware de namespace** (`/agents` ou `/consumers`): valida JWT, `role` e conta activa. Falhas aqui aparecem ao cliente como **`connect_error`** (nao chega `connection`).
2. **Handler `connection`**: entra em salas de identidade (`agent:principal:{sub}` em `/agents` quando ha `sub`; em `/consumers` salas de principal, `client:{id}` e `consumer:client-agent:*` para agentes aprovados). Falha ao entrar nas salas → hub emite **`app:error`** (ex.: codigo `ROOM_JOIN_FAILED` em `/agents`, `CONSUMER_SOCKET_INITIALIZATION_FAILED` em `/consumers`) e **`disconnect`**.
3. **`connection:ready`**: emitido **depois** das salas de identidade estarem aplicadas no mesmo processo; o payload e normalmente um **`PayloadFrame`** (ver `SOCKET_CONNECTION_READY_COMPAT_MODE` / `docs/socket/socket_relay_protocol.md`). O cliente deve tratar `connection:ready` como sinal de sessao pronta para o protocolo de aplicacao (`agent:register`, `agents:command`, `relay:*`, etc.).

Outros **`app:error`** relevantes: ligacao ao namespace padrao `/` (codigo `NAMESPACE_DEPRECATED`) antes do disconnect.

Isto e independente da [matriz oficial de paridade do bridge](#matriz-oficial-de-paridade-do-bridge): o Socket **nao** duplica a API REST completa (auth, catalogo, CRUD, metricas HTTP continuam em REST).

### REST vs Socket no consumer (mesmo comando, canais diferentes)

- **Dois canais** chegam ao mesmo fluxo interno (`executeAgentCommand` → dispatch para o agente): **HTTP** (`POST /api/v1/agents/commands`) ou **Socket** (`agents:command` no `/consumers`, ou relay `relay:rpc.request`).
- O cliente pode usar **apenas REST** (sem abrir Socket de consumer), **apenas Socket**, ou **misturar** (ex.: login e `GET /agents` por HTTP e comandos por Socket).
- **Streaming**: no REST, o hub **nao** envia chunks progressivos ao cliente HTTP; quando o agente devolve `stream_id`, o servidor **materializa** o stream por dentro e responde com **um** JSON final. Para chunks em tempo real e `stream_pull`, usar o canal Socket (legado ou relay). Ver `docs/PROJECT_OVERVIEW.md` e `docs/performance/performance_hub_agent.md`.

#### Matriz de decisao de canal (operacao)

| Cenario                                         | Canal recomendado                              | Motivo                                                    |
| ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| Consulta curta/ocasional, cliente sem Socket    | REST `POST /agents/commands`                   | Integracao simples, custo operacional menor               |
| Resultado grande (`stream_id`) e baixa latencia | `relay:rpc.request` com `prefer_db_streaming`  | Evita materializacao REST e reduz RAM no hub              |
| Necessidade de progresso em tempo real          | `relay:*` ou `agents:*`                        | Chunks e `stream_pull` no consumer                        |
| Carga alta e continua por consumer              | `relay:*`                                      | Melhor controle de backpressure e isolamento por conversa |
| Inserts em massa                                | `sql.bulkInsert` por Socket ou REST controlado | Mede throughput real sem simular linha a linha            |

Regra pratica: se o mesmo fluxo gera streams grandes repetidamente, migre para
Socket/relay em vez de aumentar apenas limites de materializacao no REST.
Clientes/SDKs podem usar o helper de referencia em
[`docs/snippets/agent_command_performance_options.ts`](snippets/agent_command_performance_options.ts)
para ativar `prefer_db_streaming` e `max_parallel_read_only_batch_items` sem
espalhar heuristicas inconsistentes.

#### Matriz oficial de paridade do bridge

O Socket **nao** duplica a API REST inteira. REST continua sendo o canal para
bootstrap, auth, catalogo, CRUD/admin, health HTTP e metricas. A paridade abaixo
vale apenas para o bridge de comandos (`POST /api/v1/agents/commands`).

| Recurso do bridge                       | REST `POST /agents/commands`  | Socket `agents:command`        | Socket `relay:*`                                                                         |
| --------------------------------------- | ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `sql.execute`                           | Sim                           | Sim                            | Sim                                                                                      |
| `sql.executeBatch`                      | Sim                           | Sim                            | Sim, apenas request unico que pode chamar o metodo; nao batch JSON-RPC no envelope relay |
| `sql.bulkInsert`                        | Sim                           | Sim                            | Sim                                                                                      |
| `sql.cancel`                            | Sim                           | Sim                            | Sim                                                                                      |
| `rpc.discover`                          | Sim                           | Sim                            | Sim                                                                                      |
| `agent.getHealth`                       | Sim                           | Sim                            | Sim                                                                                      |
| `agent.getProfile`                      | Sim                           | Sim                            | Sim                                                                                      |
| `agent.action.*` (`run` / `validateRun` / `cancel` / `getExecution`) | Sim | Sim | Sim |
| `client_token.getPolicy`                | Sim                           | Sim                            | Sim                                                                                      |
| Batch JSON-RPC (`command: []`)          | Sim, ate 32 itens             | Sim, mesmo schema              | Nao no envelope unary; use `relay:rpc.request.batch` (gated)                             |
| Notification (`id: null`)               | Sim                           | Sim                            | Nao, por desenho                                                                         |
| `timeoutMs`                             | Sim                           | Sim                            | Usa timeout do relay por request                                                         |
| `pagination` no body                    | Sim, para `sql.execute` unico | Sim, mesmo schema              | Nao no envelope relay; use params/options do comando                                     |
| `payloadFrameCompression`               | Sim                           | Sim                            | Sim no envelope `relay:rpc.request`                                                      |
| Streaming progressivo ao cliente        | Nao, REST materializa         | Sim, `agents:command_stream_*` | Sim, `relay:rpc.*`                                                                       |
| Idempotencia forte por retry de cliente | Nao                           | Nao                            | Sim, via `client_request_id` por conversa                                                |

`relay:rpc.request` (unary) rejeita batch JSON-RPC e notification de forma
intencional: cada request precisa ser correlacionavel. Para N requests no mesmo
envelope consumer, use `relay:rpc.request.batch` (gated). Lista canónica de
metodos: `agent_bridge_parity.ts` + OpenAPI `GET /docs`.

A matriz tambem existe como contrato executavel em
`src/shared/constants/agent_bridge_parity.ts` e
`tests/contract/agent_bridge_parity.contract.test.ts`; qualquer novo metodo do
bridge deve atualizar os dois lados.

Alternativa em tempo real: consumers podem conectar ao namespace `/consumers`
e emitir `agents:command` com o mesmo payload. A resposta inicial chega em
`agents:command_response`. Quando a execucao entra em streaming, os chunks
chegam em `agents:command_stream_chunk` e o encerramento em
`agents:command_stream_complete`. Para controle de fluxo (backpressure), o
consumer envia `agents:stream_pull` e recebe `agents:stream_pull_response`.

Para modo chat-like com conversa isolada (`relay:*`) e `PayloadFrame` tambem no
namespace `/consumers`, consulte `docs/socket/socket_relay_protocol.md`.

No canal `/consumers` legado (`agents:*`):

- **Outbound** (hub → consumer): respostas e stream usam **`PayloadFrame`** por
  defeito (`SOCKET_AGENTS_COMMAND_COMPAT_MODE`, default `payload_frame`).
- **Inbound** (consumer → hub): `agents:command` / `agents:stream_pull` aceitam
  plain JSON **ou** `PayloadFrame` durante a janela de transicao.
- O enlace hub ↔ `/agents` continua sempre em `PayloadFrame` (`cmp: gzip|none`).

Detalhe de migracao e helpers de decode:
[`socket_client_sdk.md`](../socket/socket_client_sdk.md) ("Migração PayloadFrame no bridge legado")
e `docs/configuration.md`.

> Escopo deste documento: ponte REST (`POST /api/v1/agents/commands`) e canal
> Socket legado (`agents:*`). O modo relay (`relay:*`) e documentado a parte.
> **Compatibilidade com plug_agente:** O agente deve conectar ao namespace `/agents`
> (por exemplo, `io("/agents")`). Conexoes no namespace padrao `/` sao rejeitadas com
> `app:error` (code `NAMESPACE_DEPRECATED`) e desconectadas. O token deve ter `role` em `SOCKET_AGENT_ROLES`
> (default: `agent`). Consumers usam `role` em `SOCKET_CONSUMER_ROLES` (default: `user`, `admin`, `client`).

### Ownership automatica do agente

- `POST /api/v1/auth/agent-login` autentica a sessao do agente, mas nao cria ownership sozinho
- o ownership oficial do `Agent` nasce quando o agente conclui `agent:register`
- o sync de cadastro via `agent.getProfile` segue o estado de prontidao do protocolo
- `lastLoginUserId` e apenas atributo operacional e nao substitui `AgentIdentity`

### Falhas de `agent:register` ate o ownership ser criado

Toda rejeicao do `agent:register` no hub sai pelo evento dedicado
`agent:register_error` em **JSON puro** (NAO `PayloadFrame`), com o shape
`{ code, reason, message, details? }`. O campo opcional `details` e um objeto
livre (ex. `{ code: "same_agent_session_active" }` quando `reason = session_active`).
O agente usa `reason` para decidir entre
**reagendar** o registo (`transient_failure`, `rate_limited`) ou **forcar
reconexao** (demais valores).

| `reason`                | Codigo   | Causa tipica                                                                                                                                      |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_payload`       | `-32009` | `PayloadFrame` nao decodifica (encoding, signature, tamanho)                                                                                      |
| `invalid_request`       | `-32600` | Schema zod do `agent:register` falhou (capabilities incompleto, etc.)                                                                             |
| `authentication_failed` | `-32001` | Token sem `agent_id` ou divergente do `agentId` enviado                                                                                           |
| `unauthorized`          | `-32002` | `agentId` ja pertence a outro `User` (`AGENT_ALREADY_LINKED`) ou outro bloqueio de ownership                                                      |
| `session_active`        | `-32014` | Ja existe outra sessao `agent:register` canonica para o mesmo `agentId` no processo (politica `reject_active`); ver `SOCKET_AGENT_SESSION_POLICY` |
| `rate_limited`          | `-32013` | Rajada de `agent:register` por `(userId, agentId)` quando `SOCKET_AGENT_REGISTER_RATE_LIMIT_*` > 0                                                |
| `transient_failure`     | `-32603` | Falha temporaria do hub que justifica retry                                                                                                       |
| `internal_error`        | `-32603` | Erro inesperado nao categorizado                                                                                                                  |

Hub → agente quando outra conexao assume o mesmo agente (`SOCKET_AGENT_SESSION_POLICY=takeover_disconnect_previous`): antes de desligar o socket antigo, o hub pode emitir **`agent:session.superseded`** (JSON puro: `reason`, `message`, `policy`) e depois `disconnect` no socket substituido.

Implementacao: `src/presentation/socket/hub/handshake/agent_register_error.ts`. Cada
emissao e logada como `agent_register_error_emitted` com `socketId`, `code`,
`reason`, `message`, `details` (quando presente) e contexto (sem PII).

As regras completas de ownership, `ClientAgentAccess`, aprovacao por owner,
revogacao e autorizacao entre REST e Socket vivem em
`docs/api/client_agent_business_rules.md`.

### Periodo de compatibilidade: SOCKET_AGENT_ROLES=agent,user

Durante a migracao do plug_agente para o modelo de namespaces, o servidor pode
aceitar tanto tokens com `role: agent` quanto `role: user` no namespace `/agents`.

**Configuracao temporaria:** Em staging e producao, configure
`SOCKET_AGENT_ROLES=agent,user` ate que o plug_agente migre para:

1. Conectar ao namespace `/agents` (nao ao padrao `/`)
2. Obter token via `POST /api/v1/auth/agent-login` ou `POST /auth/agent-login`
   com `{ email, password, agentId }`, que emite JWT com `role: agent` e `agent_id`

**Ordem de rollout recomendada:**

1. Deploy plug_server com `SOCKET_AGENT_ROLES=agent,user` (permite agentes atuais)
2. Deploy plug_agente com conexao em `/agents` e auth via agent-login
3. Validar fluxo de comandos em staging
4. Remover `user` de `SOCKET_AGENT_ROLES` para reforcar isolamento

**Apos a migracao:** Remova `user` de `SOCKET_AGENT_ROLES` e mantenha apenas `agent`.

Para o passo a passo completo da migracao no plug_agente (conexao, login, refresh e
`agent:register`), consulte `docs/plug_agente/migracao_plug_agente_namespaces.md`.

## Fluxo resumido

```
Consumer (HTTP) -> plug_server (REST) -> plug_server (Socket bridge) -> plug_agente (/agents)
                                                                     <-
Consumer (HTTP) <- plug_server (REST) <- plug_server (Socket bridge) <-
```

1. Consumer envia `POST /api/v1/agents/commands` com Bearer token.
2. Middleware `requireAuth` valida JWT do consumer.
3. Middleware `validateRequest` valida o body com `agentCommandBodySchema`.
4. Controller aplica paginacao em `command.params.options` quando presente.
5. O agente ja deve ter concluido `agent:register`, que tambem e o ponto em que o
   ownership oficial do agente e confirmado no servidor.
6. Bridge localiza o agente no registry, gera ou reutiliza `requestId`,
   empacota o comando em `PayloadFrame` e emite `rpc:request`.
   Antes do primeiro dispatch, o hub aplica uma curta janela de estabilizacao
   apos `agent:register` (`SOCKET_AGENT_PROTOCOL_READY_GRACE_MS`) e pode liberar
   mais cedo ao receber `agent:heartbeat`; agentes que anunciam
   `extensions.protocolReadyAck` podem liberar o dispatch de forma explicita com
   `agent:ready`, reduzindo corrida com `protocol_not_ready` no `plug_agente`.
7. Bridge aguarda `rpc:response` (timeout efetivo: veja `timeoutMs` abaixo).
8. Se for `sql.execute` **unico** pelo REST e a resposta trouxer `stream_id`, o hub concede
   creditos de entrega como no relay: um `rpc:stream.pull` inicial com
   `window_size` baseado em `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`, sempre
   limitado por `SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE` e tambem **clampado**
   pelo menor teto anunciado pelo agente (`recommendedStreamPullWindowSize` /
   `maxStreamPullWindowSize`), depois novo pull apenas quando os creditos chegam a
   zero (cada `rpc:chunk` consome um), reduzindo round-trips sem violar
   backpressure do agente. Acumula `rpc:chunk` ate `rpc:complete` e devolve **uma**
   resposta JSON-RPC com todas as `rows`. Se o `rpc:complete` vier com
   `terminal_status` (`aborted` ou `error`), ou se `rpc:chunk` / `rpc:complete`
   chegarem com `PayloadFrame` invalido mas `requestId` identificavel, o bridge
   **falha** a request REST com `503` em vez de materializar stream parcial como
   sucesso ou esperar apenas por timeout.
   Orçamento operacional: `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_ROWS` (por defeito
   **1_000_000**; `0` desativa o teto de linhas) e opcionalmente
   `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS` (`0` = sem limite de frames `rpc:chunk`).
   Se o agregado exceder o limite, o hub responde **`503`** de imediato, incrementa métricas
   `plug_rest_sql_stream_materialize_*_limit_exceeded_total` e recomenda o canal **Socket** para streams grandes.
9. Serializer normaliza a resposta JSON-RPC para formato HTTP.
10. Controller retorna `200` com a resposta normalizada.

## Autenticacao

| Header          | Obrigatorio | Descricao                                  |
| --------------- | ----------- | ------------------------------------------ |
| `Authorization` | sim         | `Bearer <access_token>` emitido pelo login |

O token e validado por `requireAuth` antes de qualquer processamento.

### OpenAPI (Swagger)

Os schemas em `src/presentation/docs/swagger.ts` (componentes em `src/presentation/docs/swagger/`: `error_schemas.ts`, `socket_event_schemas.ts`, `auth_schemas.ts`, `bridge_schemas.ts`, `agent_catalog_schemas.ts`) usam os **mesmos tetos** que o validador Zod (`agent_command.ts`): `options.timeout_ms` e `sql.executeBatch` `options.timeout_ms` ate **300000** ms; `options.max_rows` ate **1000000**; `options.page_size` e `pagination.pageSize` ate **50000**; `sql.bulkInsert` ate `AGENT_SQL_BULK_INSERT_MAX_ROWS` linhas e `AGENT_SQL_BULK_INSERT_MAX_JSON_BYTES` bytes UTF-8 serializados em `params`. A rota `POST /api/v1/agents/commands` inclui exemplos para paginacao no body, `execution_mode: preserve`, `prefer_db_streaming`, `sql.bulkInsert`, `agent.getProfile`, `client_token.getPolicy`, `sql.cancel` e `rpc.discover`.

## Request body

### Campos de primeiro nivel

| Campo                     | Tipo                                  | Obrigatorio | Restricoes        | Descricao                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------- | ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`                 | string                                | sim         | nao vazio         | UUID do agente conectado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `command`                 | object \| array                       | sim         | JSON-RPC 2.0      | Comando unico ou batch JSON-RPC (max 32)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `timeoutMs`               | number                                | nao         | 1..360000         | Espera do bridge (`computeBridgeWaitTimeoutMs`): `max` entre o valor do body (ou default **15000** ms) e, para `sql.execute` / `sql.executeBatch`, o maior `options.timeout_ms` do comando + **5000** ms; teto **360000** ms (`AGENT_TIMEOUT_MS_LIMIT` + **60000** ms; ver `command_transformers.ts`)                                                                                                                                                                                                                                                                                                                                                             |
| `pagination`              | object                                | nao         | regras combinadas | Paginacao injetada em `command.params.options`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `payloadFrameCompression` | `"default"` \| `"none"` \| `"always"` | nao         | —                 | Politica de gzip do **PayloadFrame** que o hub emite no `rpc:request` para o agente (alinhado a `socket_communication_standard.md` / `socketio_client_binary_transport.md` do plug_agente). `default`: limiar 4096 bytes, modo **automatico** — gzip so se o bloco comprimido for **menor** que o JSON UTF-8 bruto e nao exceder a razao maxima de inflacao negociada; caso contrario `cmp: none`. `none`: nunca gzip. `always`: modo **sempre GZIP** — prefere gzip sempre que o payload couber no limite de entrada, mesmo se nao reduzir tamanho, mas cai para `cmp: none` quando o frame violaria a razao maxima de inflacao. Nao altera respostas do agente. |
| `requestServerTimings`    | boolean                               | nao         | —                 | Opt-in para fases de latencia por request. Quando `true`, o hub anexa `serverTimings: { schemaVersion, phasesMs }` no envelope de resposta — ver "Server-side phase diagnostics" abaixo. Aplicavel a **REST** (`POST /api/v1/agents/commands`) e ao **Socket `agents:command`**. Forca a sessao de trace mesmo com `BRIDGE_LATENCY_TRACE_ENABLED=false`; persistencia em DB continua amostrada.                                                                                                                                                                                                                                                                       |

### `command` (discriminated union por `method`)

O campo `command` segue o contrato JSON-RPC 2.0. O `method` determina o schema
de `params`.

#### Campos comuns a todos os metodos

| Campo     | Tipo                     | Obrigatorio | Default | Descricao                       |
| --------- | ------------------------ | ----------- | ------- | ------------------------------- |
| `jsonrpc` | `"2.0"`                  | nao         | `"2.0"` | Versao do protocolo             |
| `method`  | string                   | sim         | -       | Metodo RPC (ver metodos abaixo) |
| `id`      | string \| number \| null | nao         | -       | Identificador do request        |
| `meta`    | object                   | nao         | -       | Metadados de rastreabilidade    |

Comportamento do `id` nesta API:

- **`id` omitido:** o servidor gera um **UUID** antes de encaminhar ao agente e **aguarda**
  `rpc:response` (HTTP `200` com resultado normalizado). O valor gerado e o `id` JSON-RPC
  no fio com o agente (o `requestId` do envelope HTTP costuma coincidir com esse `id` em
  comando unico).
- **`id: null`:** trata-se de **notification** JSON-RPC: encaminha ao agente, **nao** registra
  pending e **nao** aguarda `rpc:response`. Comando unico com `id: null`, ou batch em que **cada**
  item tem `id: null`, faz a rota retornar HTTP `202 Accepted` (sem corpo de resultado JSON-RPC).
- **`id` string ou number:** correlacao normal; o valor e repassado ao agente (com metadados
  de bridge em `meta`).

### Hub (REST / `agents:command`) vs agente direto (Socket no /agents)

No **padrao JSON-RPC 2.0 puro**, request **sem** `id` costuma ser tratado como **notification**
(no fio direto com o `plug_agente`, conforme documentacao do agente).

Neste **hub** (`POST /api/v1/agents/commands` e evento Socket `agents:command` no namespace
`/consumers`), a semantica e **estendida** para UX do integrador:

| Onde                                        | `id` omitido                                                                            | `id: null`                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Hub plug_server**                         | servidor gera UUID e aguarda resposta (`200` / `agents:command_response` com resultado) | notification (`202` ou resposta tipo notification no Socket) |
| **Agente direto** (contrato do plug_agente) | notification (sem resposta JSON-RPC)                                                    | notification                                                 |

Para comandos unitarios com `id` string/number, o hub mantem um guard process-local de
2 minutos por `agentId + tipo_do_id + valor_do_id`. Repetir o mesmo `command.id`
nessa janela nao gera novo `rpc:request` para o agente: o REST continua retornando
HTTP `200` com envelope bridge normal e `response.item.error.code = -32014`
(`error.data.reason = "replay_detected"`); no Socket, o mesmo erro aparece em
`agents:command_response.response.item.error`.

O **relay** (`relay:rpc.request`) continua com modelo proprio: o frame usa `id` interno gerado
pelo servidor; o `id` do cliente vira `meta.client_request_id` para idempotencia (ver
`docs/socket/socket_relay_protocol.md` / `socket_client_sdk.md`).

O `meta` enviado pelo cliente (ex.: `traceparent`, `tracestate`) e preservado
via merge; o bridge adiciona `request_id`, `agent_id`, `timestamp` e `trace_id`.

---

## Metodos suportados

### `sql.execute`

Executa um comando SQL no agente.

#### `command.params`

| Campo          | Tipo   | Obrigatorio | Descricao                                                 |
| -------------- | ------ | ----------- | --------------------------------------------------------- |
| `sql`          | string | sim         | Comando SQL (SELECT, INSERT, UPDATE, DELETE, MERGE, WITH) |
| `params`       | object | nao         | Parametros nomeados para o SQL (ex: `{ "id": 1 }`)        |
| `client_token` | string | condicional | Token opaco ou JWT para autorizacao no agente             |
| `clientToken`  | string | condicional | Alias de `client_token`                                   |
| `auth`         | string | condicional | Alias de `client_token`                                   |
| `options`      | object | nao         | Opcoes de execucao (ver tabela abaixo)                    |

Token de autorizacao: pelo menos um entre `client_token`, `clientToken` ou
`auth` e obrigatorio quando `enableClientTokenAuthorization` estiver ativo no agente.

#### Limites de tamanho (JSON logico, UTF-8)

Validacao no hub antes do `PayloadFrame` (constantes em `agent_command.ts`):

| Campo                                                                                           | Teto             |
| ----------------------------------------------------------------------------------------------- | ---------------- |
| `sql` (`sql.execute` e cada item de `sql.executeBatch`)                                         | **1 MiB** UTF-8  |
| `params` nomeado (objeto serializado em JSON)                                                   | **2 MiB** UTF-8  |
| `agent.getHealth` / `agent.getProfile` / `client_token.getPolicy` `params` (objeto serializado) | **64 KiB** UTF-8 |
| `rpc.discover` `params` (objeto serializado)                                                    | **64 KiB** UTF-8 |

O limite HTTP total continua a ser `REQUEST_BODY_LIMIT`; estes tetos evitam cargas JSON enormes mesmo com body permitido maior.

#### `command.params.options`

| Campo                 | Tipo    | Obrigatorio | Restricoes                         | Descricao                                                                                                                                                                                                               |
| --------------------- | ------- | ----------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout_ms`          | integer | nao         | 1..300000 (5 min)                  | Timeout de execucao SQL no agente (ms)                                                                                                                                                                                  |
| `max_rows`            | integer | nao         | 1..1000000                         | Maximo de linhas retornadas; o limite efetivo pode ser reduzido pelo acordo hub/agente nas capabilities                                                                                                                 |
| `page`                | integer | nao         | >= 1, requer `page_size`           | Numero da pagina (1-based)                                                                                                                                                                                              |
| `page_size`           | integer | nao         | 1..50000, requer `page`            | Linhas por pagina                                                                                                                                                                                                       |
| `cursor`              | string  | nao         | exclusivo com `page`/`page_size`   | Token opaco de continuacao (keyset)                                                                                                                                                                                     |
| `execution_mode`      | string  | nao         | `managed` \| `preserve`            | Modo de tratamento da SQL. `managed` (default) permite reescrita gerenciada para paginacao. `preserve` executa a SQL exatamente como enviada, sem reescrita. Nao pode ser combinado com `page`, `page_size` ou `cursor` |
| `preserve_sql`        | boolean | nao         | exclusivo com paginacao            | Alias legado para `execution_mode: "preserve"`. Nao pode ser combinado com `page`, `page_size` ou `cursor`                                                                                                              |
| `multi_result`        | boolean | nao         | exclusivo com paginacao e `params` | Habilita retorno de multiplos result sets                                                                                                                                                                               |
| `prefer_db_streaming` | boolean | nao         | preferencia apenas                 | Preferencia para streaming direto do banco em `SELECT` elegivel; o hub valida e repassa, e a decisao final fica no runtime do agente                                                                                    |

Regras de combinacao:

- `page` e `page_size` devem ser enviados juntos.
- `cursor` nao pode ser combinado com `page`/`page_size`.
- `execution_mode: "preserve"` e `preserve_sql: true` nao podem ser combinados com `page`, `page_size` ou `cursor`.
- `multi_result: true` nao pode ser combinado com paginacao nem `params`.
- **Paginacao e `ORDER BY` (contrato plug_agente v2.4+):** com `page`+`page_size` ou com `cursor`, a SQL deve declarar **`ORDER BY` explicito**. Sem ordenacao estavel, paginacao offset/keyset pode ser inconsistente ou o agente pode rejeitar/validar a consulta. Para `cursor` keyset, use ordenacao deterministica (ex.: chave unica ou desempate por coluna unica).

#### Campos opcionais validados e encaminhados ao agente

| Campo             | Tipo   | Obrigatorio | Descricao                                                  |
| ----------------- | ------ | ----------- | ---------------------------------------------------------- |
| `idempotency_key` | string | nao         | Chave de deduplicacao (TTL 5min quando feature flag ativo) |
| `database`        | string | nao         | Override de database/DSN alvo                              |

Esses campos sao validados no bridge REST e encaminhados ao agente.

---

### `sql.executeBatch`

Executa multiplos comandos SQL em sequencia.

#### `command.params`

| Campo          | Tipo   | Obrigatorio | Descricao                                            |
| -------------- | ------ | ----------- | ---------------------------------------------------- |
| `commands`     | array  | sim         | Array de comandos SQL (min 1 item)                   |
| `client_token` | string | condicional | Token opaco ou JWT (ou alias `clientToken` / `auth`) |
| `clientToken`  | string | condicional | Alias de `client_token`                              |
| `auth`         | string | condicional | Alias de `client_token`                              |
| `options`      | object | nao         | Opcoes de execucao (ver abaixo)                      |

#### `command.params.commands[]`

| Campo             | Tipo    | Obrigatorio | Descricao                                                                                                              |
| ----------------- | ------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `sql`             | string  | sim         | Comando SQL                                                                                                            |
| `params`          | object  | nao         | Parametros nomeados para o comando SQL                                                                                 |
| `execution_order` | integer | nao         | Ordem explicita de execucao (>= 0). Itens com `execution_order` executam antes dos itens sem ordem, em ordem crescente |

#### `command.params.options`

| Campo                                | Tipo    | Obrigatorio | Descricao                                                                                      |
| ------------------------------------ | ------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `timeout_ms`                         | integer | nao         | Timeout de execucao total do batch (ms)                                                        |
| `max_rows`                           | integer | nao         | Maximo de linhas por comando                                                                   |
| `transaction`                        | boolean | nao         | Envolve os comandos em uma transacao unica                                                     |
| `max_parallel_read_only_batch_items` | integer | nao         | Opt-in de paralelismo para SELECTs read-only; o agente aplica safety cap conforme pool interno |

#### Campos opcionais validados e encaminhados ao agente

| Campo             | Tipo   | Obrigatorio | Descricao                     |
| ----------------- | ------ | ----------- | ----------------------------- |
| `idempotency_key` | string | nao         | Chave de deduplicacao         |
| `database`        | string | nao         | Override de database/DSN alvo |

---

### `sql.cancel`

Cancela uma execucao em streaming ativa.

#### `command.params`

| Campo          | Tipo   | Obrigatorio | Descricao                                          |
| -------------- | ------ | ----------- | -------------------------------------------------- |
| `execution_id` | string | condicional | ID da execucao a cancelar (pelo menos um dos dois) |
| `request_id`   | string | condicional | ID do request a cancelar (pelo menos um dos dois)  |

Nao requer token de autorizacao.

---

### `client_token.getPolicy`

Introspecao da **politica de autorizacao** ja resolvida para o token apresentado
(mesmo pipeline que `sql.execute` no agente), **sem executar SQL**. O resultado
inclui identificadores, flags (`all_tables`, `all_views`,
`global_permissions`, `all_permissions` legado derivado), regras por recurso,
estado de revogacao e `payload` com metadados (valores sensiveis podem ser
redigidos no agente).

Requer plug*agente com o metodo implementado (introduzido no perfil **2.7**). Com auth desativada no agente ou introspecao desativada
(`enableClientTokenPolicyIntrospection`), o agente pode responder com erro
`-32602` e `reason` especifico; rate limit do agente pode devolver `-32013`
(`client_token_get_policy_rate_limited`) com `error.data.retry_after_ms` e
`reset_at` — o hub propaga automaticamente esses hints para o header HTTP
`Retry-After` (ver secao *`Retry-After` derivado de erros RPC\_ acima). Ver
`plug_agente/docs/communication/socket_communication_standard.md` e os JSON
Schemas `rpc.params.client-token-get-policy.schema.json` /
`rpc.result.client-token-get-policy.schema.json`.

#### `command.params`

| Campo          | Tipo   | Obrigatorio | Descricao                                            |
| -------------- | ------ | ----------- | ---------------------------------------------------- |
| `client_token` | string | condicional | Token opaco ou JWT (ou alias `clientToken` / `auth`) |

Obrigatorio quando `enableClientTokenAuthorization` estiver ativo no agente (mesma regra que `sql.execute`).

---

### `rpc.discover`

Retorna o documento OpenRPC do agente com o catalogo de metodos suportados.

#### `command.params`

| Campo | Tipo   | Obrigatorio | Descricao                    |
| ----- | ------ | ----------- | ---------------------------- |
| (any) | object | nao         | Parametros livres (opcional) |

Nao requer token de autorizacao.

---

## Batch JSON-RPC nativo (array em `command`)

Alem do metodo `sql.executeBatch` (batch semantico do agente), a rota tambem
aceita **batch JSON-RPC nativo** no campo `command` (array de requests).

Regras:

- min 1 item, max 32 itens.
- IDs devem ser unicos entre itens que ja tem `id` definido (string/number); itens com `id: null`
  sao notifications e ficam de fora dessa checagem.
- Itens **sem** a propriedade `id` recebem UUID gerado pelo servidor (como comando unico) e passam
  a aguardar resposta para esse `id`.
- Itens com **`id: null`** sao notifications e nao entram na lista de correlacao; a resposta
  normalizada do batch so inclui itens para os quais houve `rpc:response` com `id` nao-nulo.
- Batch com pelo menos um item que nao e notification (omitido `id` ou `id` nao-nulo) retorna HTTP 200
  com `response.type = "batch"` quando todas as respostas esperadas chegam.
- Batch somente com notifications (`id: null` em todos os itens) retorna HTTP 202.

**Canal Socket (`agents:command` no `/consumers`):** as mesmas regras de correlacao e de notifications aplicam-se ao comando validado; em vez de HTTP 202, o hub responde com `agents:command_response` em que `response.type === "notification"`, `accepted: true` e `acceptedCommands` igual ao numero de comandos aceites (fire-and-forget). Batch misto (`id: null` + itens com `id`) continua a aguardar `rpc:response` so para os ids correlacionados; o corpo normalizado `response.type === "batch"` pode ter **menos** itens do que o pedido (so entram respostas com `id` nao-nulo no payload do agente).

### Limite de um `agentId` por envelope (REST e Socket)

Tanto a rota REST quanto o evento Socket `agents:command` aceitam **exatamente
um** `agentId` por envelope. Quando `command` e um array (batch JSON-RPC
nativo), **todos os itens sao despachados para o mesmo agente** declarado no
`agentId` do envelope.

Consequencias praticas para fan-out cross-agent:

- Um `mergeAll` que precisa consultar N agentes diferentes **deve emitir N
  envelopes** (REST: N POSTs; Socket: N `agents:command` events), um para
  cada `agentId`.
- Empacotar requests de varios agentes num unico `agents:command` com array
  de comandos resulta em **todos** os comandos sendo enviados ao mesmo
  agente declarado no envelope. Comandos cujo `id` o agente alvo nao
  reconhece nao retornarao `rpc:response`, e o cliente vera o request
  "preso" ate o timeout (15s por padrao). **Isto e um erro de uso, nao um
  defeito do hub.**
- O batch nativo so faz sentido quando todos os itens compartilham o mesmo
  agente alvo (ex.: rodar 32 selects no mesmo agente numa unica viagem).
- Clientes que coordenam batches via componente como
  `AgentCommandBatchCoordinator` devem **agrupar por `agentId` antes** de
  empacotar — nunca colocar comandos de agentes diferentes no mesmo
  envelope.

Para fan-out cross-agent eficiente, recomenda-se o canal **relay**
(`relay:rpc.request`) que ja associa conversa ao `agentId` no
`relay:conversation.start` e mantem correlacao por `conversationId`. Batch no
relay: `relay:rpc.request.batch` — **shipped**, gated por
`SOCKET_RELAY_BATCH_ENABLED` (default `false`). Ver
[ADR 0008](../adrs/0008-relay-batch-protocol.md) e
[`socket_relay_protocol.md`](../socket/socket_relay_protocol.md).

### Exemplo de batch JSON-RPC misto

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": [
    {
      "jsonrpc": "2.0",
      "method": "sql.execute",
      "id": "q1",
      "params": {
        "sql": "SELECT 1",
        "client_token": "a1b2c3d4e5f6"
      }
    },
    {
      "jsonrpc": "2.0",
      "method": "sql.execute",
      "id": null,
      "params": {
        "sql": "INSERT INTO logs (msg) VALUES ('ok')",
        "client_token": "a1b2c3d4e5f6"
      }
    },
    {
      "jsonrpc": "2.0",
      "method": "sql.execute",
      "id": "q2",
      "params": {
        "sql": "SELECT 2",
        "client_token": "a1b2c3d4e5f6"
      }
    }
  ]
}
```

---

## Server-side phase diagnostics (`requestServerTimings`)

Aplicavel a **REST** (`POST /api/v1/agents/commands`) e ao **Socket
`agents:command` no `/consumers`**. Quando o cliente envia
`requestServerTimings: true`, o hub anexa um snapshot de fases ao envelope de
resposta (`agents:command_response` no Socket; campo top-level `serverTimings`
no REST):

```json
{
  "success": true,
  "requestId": "...",
  "response": {
    /* corpo JSON-RPC normalizado */
  },
  "serverTimings": {
    "schemaVersion": 1,
    "phasesMs": {
      "transform_ms": 0.42,
      "queue_wait_ms": 0.01,
      "dispatch_preflight_ms": 0.18,
      "encode_ms": 0.86,
      "emit_to_socket_ms": 0.06,
      "agent_to_hub_ms": 142.2,
      "inbound_decode_ms": 0.41,
      "pending_resolve_ms": 0.18,
      "normalize_ms": 0.05,
      "response_write_ms": 0.04
    }
  }
}
```

Em erro, `serverTimings` aparece como **sibling** do campo `error` na mesma
posicao do envelope (`{ success: false, requestId?, error, serverTimings? }`).

Regras do contrato:

- Todos os valores em **milissegundos**, arredondados a 3 casas decimais.
- `schemaVersion` espelha `BRIDGE_LATENCY_PHASES_SCHEMA_VERSION` no hub
  (atualmente `1`). Consumers **devem** tolerar chaves desconhecidas em
  `phasesMs` — novas fases podem ser adicionadas em versoes minor.
- Custo por resposta: ~120 bytes. O opt-in evita inflar fan-out de alto
  throughput que nao consome timings.
- Forca a criacao da sessao de trace mesmo com
  `BRIDGE_LATENCY_TRACE_ENABLED=false`. A persistencia em DB continua
  respeitando a amostragem global (`BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT`).
- **Seguranca:** apenas valores de tempo sao expostos. `trace_id`,
  `agentSocketId`, identificadores de fila e qualquer outro campo de
  topologia operacional nao aparecem no envelope.
- REST e Socket `agents:command` usam a mesma forma de envelope
  (campo top-level `serverTimings`).

Para o canal **relay** (`relay:rpc.request` no `/consumers`), o opt-in
equivalente vive no envelope do request e injeta `meta.serverTimings` no
JSON-RPC da resposta. Ver
[`docs/socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md) ("Server-side
phase diagnostics").

---

## `pagination` (nivel do body, nao do command)

Quando informado, o servidor injeta os valores em `command.params.options`
antes de enviar ao agente. Isso simplifica o uso pelo cliente HTTP.

**Precedencia:** Quando `body.pagination` e `command.params.options` definem
paginacao (page/page_size ou cursor), os valores de `body.pagination` tem
precedencia e sobrescrevem os de `command.params.options`.

| Campo      | Tipo    | Obrigatorio | Restricoes                      | Descricao                   |
| ---------- | ------- | ----------- | ------------------------------- | --------------------------- |
| `page`     | integer | condicional | >= 1, requer `pageSize`         | Numero da pagina (1-based)  |
| `pageSize` | integer | condicional | 1..50000, requer `page`         | Linhas por pagina           |
| `cursor`   | string  | condicional | exclusivo com `page`/`pageSize` | Token de continuacao keyset |

Conversao automatica: `pageSize` (camelCase HTTP) -> `page_size` (snake_case
agente).

Regras:

- `page` e `pageSize` devem ser enviados juntos.
- `cursor` nao pode ser combinado com `page`/`pageSize`.
- Quando `pagination` e informado, pelo menos uma das opcoes e obrigatoria.
- A SQL do `sql.execute` deve incluir **`ORDER BY` explicito** quando houver paginacao (mesma regra que `command.params.options`; ver secao acima).

---

## Exemplos de request

### sql.execute simples

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-001",
    "params": {
      "sql": "SELECT * FROM users WHERE id = :id",
      "params": { "id": 1 },
      "client_token": "a1b2c3d4e5f6"
    }
  }
}
```

### sql.execute com `payloadFrameCompression` (frame hub → agente)

O campo opcional afeta apenas o `PayloadFrame` que o hub emite em `rpc:request` no `/agents` (nao o corpo HTTP em si). Mesmos valores que no relay: `default` (auto + limiar 4096 + guarda de inflacao), `none`, `always` (preferencia por gzip, ainda limitada pela guarda de inflacao).

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "payloadFrameCompression": "always",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-compress-001",
    "params": {
      "sql": "SELECT 1",
      "client_token": "a1b2c3d4e5f6"
    }
  }
}
```

### sql.execute com `api_version` e `meta`

Opcionalmente, `meta.outbound_compression` (`none`, `gzip` ou `auto`) segue o contrato do
plug_agente: pedido ao agente para a politica de compressao do `PayloadFrame` em respostas
(`rpc:response` e eventos de stream com o mesmo `id`). Continua a valer negociacao no handshake
e limiares; notificacoes sem `id` utilizavel ignoram o hint.

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-meta-001",
    "api_version": "2.5",
    "meta": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
      "tracestate": "vendor=value",
      "outbound_compression": "auto"
    },
    "params": {
      "sql": "SELECT 1",
      "client_token": "a1b2c3d4e5f6"
    }
  }
}
```

### sql.execute com execution_mode preserve (passthrough)

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-preserve-001",
    "params": {
      "sql": "SELECT * FROM users LIMIT 10",
      "client_token": "a1b2c3d4e5f6",
      "options": {
        "execution_mode": "preserve"
      }
    }
  }
}
```

### sql.execute com paginacao via body.pagination

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "timeoutMs": 20000,
  "pagination": {
    "page": 1,
    "pageSize": 100
  },
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-002",
    "params": {
      "sql": "SELECT * FROM users ORDER BY id",
      "client_token": "a1b2c3d4e5f6"
    }
  }
}
```

### sql.execute com cursor

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "pagination": {
    "cursor": "eyJ2IjoyLCJwYWdlIjoyfQ"
  },
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-003",
    "params": {
      "sql": "SELECT * FROM users ORDER BY id",
      "client_token": "a1b2c3d4e5f6"
    }
  }
}
```

### sql.execute com multi_result

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-004",
    "params": {
      "sql": "SELECT * FROM users; SELECT COUNT(*) FROM orders",
      "client_token": "a1b2c3d4e5f6",
      "options": {
        "multi_result": true
      }
    }
  }
}
```

### sql.execute com idempotency_key

`idempotency_key` nao substitui `command.id`: o `command.id` continua sendo a
correlacao JSON-RPC e tambem participa do guard de replay do bridge. Use
`idempotency_key` para deduplicacao de negocio/execucao no agente quando a mesma
operacao puder ser reentregue com um novo `command.id`.

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-005",
    "params": {
      "sql": "INSERT INTO logs (msg) VALUES ('test')",
      "client_token": "a1b2c3d4e5f6",
      "idempotency_key": "idem-abc-123"
    }
  }
}
```

### sql.execute com UPDATE

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-006",
    "params": {
      "sql": "UPDATE users SET status = :status, updated_at = CURRENT_TIMESTAMP WHERE id = :id",
      "params": {
        "id": 42,
        "status": "inactive"
      },
      "client_token": "a1b2c3d4e5f6"
    }
  }
}
```

### sql.execute com DELETE

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-007",
    "params": {
      "sql": "DELETE FROM sessions WHERE expires_at < :cutoff",
      "params": {
        "cutoff": "2026-03-01T00:00:00Z"
      },
      "client_token": "a1b2c3d4e5f6"
    }
  }
}
```

### sql.executeBatch

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.executeBatch",
    "id": "batch-001",
    "params": {
      "commands": [
        { "sql": "SELECT * FROM users", "execution_order": 0 },
        { "sql": "SELECT COUNT(*) AS total FROM orders" }
      ],
      "client_token": "a1b2c3d4e5f6",
      "options": {
        "transaction": true,
        "timeout_ms": 30000
      }
    }
  }
}
```

### sql.executeBatch com SELECT, INSERT, UPDATE e DELETE

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.executeBatch",
    "id": "batch-002",
    "params": {
      "commands": [
        {
          "sql": "SELECT id, status FROM users WHERE id = :id",
          "params": { "id": 42 },
          "execution_order": 0
        },
        {
          "sql": "INSERT INTO audit_logs (entity, entity_id, action) VALUES ('user', :id, 'status_change')",
          "params": { "id": 42 },
          "execution_order": 1
        },
        {
          "sql": "UPDATE users SET status = :status WHERE id = :id",
          "params": { "id": 42, "status": "inactive" },
          "execution_order": 2
        },
        {
          "sql": "DELETE FROM user_sessions WHERE user_id = :id",
          "params": { "id": 42 },
          "execution_order": 3
        }
      ],
      "client_token": "a1b2c3d4e5f6",
      "options": {
        "transaction": true,
        "timeout_ms": 30000
      }
    }
  }
}
```

### sql.cancel

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.cancel",
    "id": "cancel-001",
    "params": {
      "execution_id": "exec-456"
    }
  }
}
```

### rpc.discover

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "command": {
    "jsonrpc": "2.0",
    "method": "rpc.discover",
    "id": "discover-001"
  }
}
```

---

## Response HTTP

### Sucesso (200)

```json
{
  "mode": "bridge",
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "requestId": "req-001",
  "response": {
    "type": "single",
    "success": true,
    "item": {
      "id": "req-001",
      "success": true,
      "result": {
        "execution_id": "exec-789",
        "started_at": "2026-03-17T10:00:00Z",
        "finished_at": "2026-03-17T10:00:01Z",
        "rows": [{ "id": 1, "name": "Alice" }],
        "row_count": 1,
        "affected_rows": 0,
        "column_metadata": [
          { "name": "id", "type": "INTEGER" },
          { "name": "name", "type": "TEXT" }
        ]
      }
    }
  }
}
```

### Notification aceita (202)

Quando o payload e **somente notification** JSON-RPC: comando unico com `id: null`,
ou batch em que **cada** item tem `id: null`. (`id` omitido **nao** e notification
nesta API: o servidor gera UUID e aguarda resposta.) O bridge nao aguarda
`rpc:response` e retorna:

```json
{
  "mode": "bridge",
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "requestId": "95dd8edc-ceec-4541-b98d-fec17d61f32e",
  "notification": true,
  "acceptedCommands": 1
}
```

### Sucesso com paginacao

O agente retorna `result.pagination` quando a request inclui
`options.page` + `options.page_size` ou `options.cursor`:

```json
{
  "mode": "bridge",
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "requestId": "req-002",
  "response": {
    "type": "single",
    "success": true,
    "item": {
      "id": "req-002",
      "success": true,
      "result": {
        "execution_id": "exec-790",
        "started_at": "2026-03-17T10:00:00Z",
        "finished_at": "2026-03-17T10:00:01Z",
        "rows": [],
        "row_count": 0,
        "pagination": {
          "page": 1,
          "page_size": 100,
          "returned_rows": 0,
          "has_next_page": false,
          "has_previous_page": false,
          "current_cursor": "eyJ2IjoyLCJwYWdlIjoxfQ",
          "next_cursor": "eyJ2IjoyLCJwYWdlIjoyfQ"
        }
      }
    }
  }
}
```

### Sucesso com multi_result

```json
{
  "mode": "bridge",
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "requestId": "req-004",
  "response": {
    "type": "single",
    "success": true,
    "item": {
      "id": "req-004",
      "success": true,
      "result": {
        "execution_id": "exec-791",
        "started_at": "2026-03-17T10:00:00Z",
        "finished_at": "2026-03-17T10:00:01Z",
        "rows": [],
        "row_count": 0,
        "multi_result": true,
        "result_set_count": 2,
        "item_count": 2,
        "result_sets": [
          {
            "index": 0,
            "rows": [{ "id": 1, "name": "Alice" }],
            "row_count": 1,
            "column_metadata": [{ "name": "id" }, { "name": "name" }]
          },
          {
            "index": 1,
            "rows": [{ "orders_count": 5 }],
            "row_count": 1,
            "column_metadata": [{ "name": "orders_count" }]
          }
        ],
        "items": [
          {
            "type": "result_set",
            "index": 0,
            "result_set_index": 0,
            "rows": [{ "id": 1, "name": "Alice" }],
            "row_count": 1
          },
          {
            "type": "result_set",
            "index": 1,
            "result_set_index": 1,
            "rows": [{ "orders_count": 5 }],
            "row_count": 1
          }
        ]
      }
    }
  }
}
```

### Erro RPC do agente (200, erro no payload)

O HTTP retorna 200 porque o proxy funcionou. O erro e indicado dentro de
`response`:

```json
{
  "mode": "bridge",
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "requestId": "req-001",
  "response": {
    "type": "single",
    "success": false,
    "item": {
      "id": "req-001",
      "success": false,
      "error": {
        "code": -32102,
        "message": "SQL execution failed",
        "data": {
          "reason": "sql_execution_failed",
          "category": "sql",
          "retryable": false,
          "user_message": "Nao foi possivel executar a consulta.",
          "technical_message": "Database driver returned an execution error.",
          "correlation_id": "corr-req-001",
          "timestamp": "2026-03-17T10:00:01Z"
        }
      }
    }
  }
}
```

### Erros HTTP (proxy)

| Status | Causa                                                                                         | Descricao                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Body invalido / validacao Zod                                                                 | `validateRequest` com `agentCommandBodySchema`; detalhe do schema na resposta                                                                                                                                                                                                                                                                                                                                  |
| 401    | Token ausente ou invalido                                                                     | `requireAuth` rejeitou a autenticacao                                                                                                                                                                                                                                                                                                                                                                          |
| 404    | Agente nunca registrado                                                                       | `agentId` desconhecido                                                                                                                                                                                                                                                                                                                                                                                         |
| 200    | Corpo `response` com erro JSON-RPC normalizado                                                | Inclui `error.code: -32000` / `agent_offline` quando o `agentId` e **conhecido pelo hub em memoria** (tipicamente apos pelo menos um `agent:register` neste processo) mas **nao** ha socket ativo em `/agents`, e o pedido tem pelo menos um JSON-RPC `id` correlacionavel (REST alinhado ao Socket `agents:command`). `agentId` apenas no catalogo PostgreSQL sem registo previo no processo continua **404** |
| 503    | Timeout / overload / hub ou agente indisponivel (nao catalogado como offline correlacionavel) | Inclui pedidos **notification-only** (`id: null` em todos os itens) contra agente catalogado offline; tambem desconexao no meio de request pendente, fila saturada, etc.                                                                                                                                                                                                                                       |

Quando o `503` for causado por overload (fila cheia ou espera em fila expirada),
o servidor inclui:

- Header `Retry-After` (segundos)
- `details.retry_after_ms` no body (ambiente nao-producao)

### `Retry-After` derivado de erros RPC do agente (`-32013`)

Mesmo em respostas HTTP `200` (proxy bem-sucedido + erro JSON-RPC no payload),
o hub adiciona o header HTTP padrao `Retry-After` quando a resposta do agente
inclui `error.code: -32013` (`rate_limited`) com:

- `error.data.retry_after_ms` (milissegundos ate poder retentar), **ou**
- `error.data.reset_at` (ISO-8601 do fim da janela)

O valor e arredondado **para cima** em segundos (minimo `1`). Em batch
JSON-RPC com varios `-32013`, o hub usa o **maior** valor para nao sugerir
retry mais cedo do que o limite mais restrito.

Esse caminho e especialmente util para o metodo `client_token.getPolicy`
(introduzido no perfil 2.7 do `plug_agente`), que tem rate limit dedicado por `agent_id` + hash do
credential. O cliente HTTP pode usar diretamente `Retry-After` para backoff
sem precisar parsear o envelope JSON-RPC. Implementacao:
`src/presentation/http/serializers/agent_rpc_retry_after.ts`.

### Controles de overload REST por agente

| Variavel                                        | Default     | Descricao                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_REST_MAX_PENDING_REQUESTS`              | `10000`     | Limite global de requests REST correlacionadas pendentes                                                                                                                                                                                                                                                                                                 |
| `SOCKET_REST_AGENT_MAX_INFLIGHT`                | `32`        | Quantas requests simultaneas por `agentId` podem ficar em voo                                                                                                                                                                                                                                                                                            |
| `SOCKET_REST_AGENT_MAX_QUEUE`                   | `64`        | Quantas requests adicionais por `agentId` podem esperar fila                                                                                                                                                                                                                                                                                             |
| `SOCKET_REST_AGENT_QUEUE_WAIT_MS`               | `200`       | Tempo maximo de espera na fila por agente antes de rejeitar                                                                                                                                                                                                                                                                                              |
| `SOCKET_AGENT_PROTOCOL_READY_GRACE_MS`          | `100`       | Fallback de estabilizacao apos `agent:register`; durante esse periodo o hub rejeita dispatch com `503`/`Retry-After`. `agent:heartbeat` libera antes e agentes com `extensions.protocolReadyAck` podem liberar explicitamente com `agent:ready`                                                                                                          |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`           | `256`       | Janela base por pull no REST materializado; o hub pode reduzir/clamp pelo que o agente anunciar como recomendado/maximo em capabilities                                                                                                                                                                                                                  |
| `SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE`       | `256`       | Teto anunciado pelo hub em `agent:capabilities.extensions.maxStreamPullWindowSize` e aplicado como limite final de `rpc:stream.pull`; separa recomendacao e limite quando necessario                                                                                                                                                                     |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_ROWS`   | `1000000`   | Teto de linhas agregadas (resposta inicial + chunks) na materialização REST; `0` desativa (não recomendado em produção)                                                                                                                                                                                                                                  |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS` | `100000`    | Teto de frames `rpc:chunk` na materialização; `0` = ilimitado                                                                                                                                                                                                                                                                                            |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_BYTES`  | `268435456` | Teto agregado de bytes UTF-8 materializados (resposta inicial + chunks); protege contra linhas muito largas / JSONB grandes                                                                                                                                                                                                                              |
| `PAYLOAD_SIGN_OUTBOUND`                         | `false`     | Quando `true` e `PAYLOAD_SIGNING_KEY` definida, assina frames **emitidos** pelo hub (HMAC-SHA256).                                                                                                                                                                                                                                                       |
| `PAYLOAD_SIGNING_KEY_ID`                        | _(vazio)_   | Identificador da chave ativa usada para assinar/verificar `PayloadFrame.signature.key_id`. Quando definida, frames recebidos assinados **devem** trazer `signature.key_id` conhecido. Sem essa env e sem keyring anterior, o hub aceita assinaturas single-key sem `key_id`. Frames inbound **sem assinatura** continuam aceitos por defeito nesta fase. |
| `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON`            | `{}`        | Keyring JSON `{ "old-key-id": "secret" }`, aceito apenas para verificação inbound durante rotação.                                                                                                                                                                                                                                                       |
| `SOCKET_AGENT_INBOUND_CONTRACT_VALIDATION`      | `strict`    | Validação lógica pós-`PayloadFrame`: `strict` rejeita payload fora do contrato, `warn` registra métrica/log e continua, `off` desliga.                                                                                                                                                                                                                   |
| `SOCKET_AGENT_ACK_RETRY_ENABLED`                | `true`      | Reenvia o mesmo `rpc:request` quando falta ACK somente para requests elegíveis e idempotentes/seguras.                                                                                                                                                                                                                                                   |
| `SOCKET_AGENT_ACK_TIMEOUT_MS`                   | `1000`      | Janela para aguardar `rpc:request_ack` / `rpc:batch_ack` antes do retry.                                                                                                                                                                                                                                                                                 |
| `SOCKET_AGENT_ACK_MAX_RETRIES`                  | `1`         | Número máximo de reenvios por falta de ACK.                                                                                                                                                                                                                                                                                                              |
| `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES`            | `524288`    | JSON UTF-8 maior que este valor nao passa por tentativa de gzip no hub (`cmp: none`); ate **10 MiB** no frame.                                                                                                                                                                                                                                           |

### Headers de rate limit

As rotas REST que usam `express-rate-limit` publicam `standardHeaders: true`,
ou seja, além do status `429` devolvem headers no formato padrão:

- `RateLimit-Limit`
- `RateLimit-Remaining`
- `RateLimit-Reset`

Para erros de overload do bridge por agente (`503` por fila cheia / queue wait
timeout), o servidor também pode devolver:

- `Retry-After` (segundos)
- `details.retry_after_ms` no body (ambiente não-produção)

> **Nota multi-réplica.** Os limitadores usam o store default em memória; em
> multi-pod o teto efetivo se multiplica pelo número de réplicas. Veja
> `docs/studies/scaling_and_roadmap.md` (seção “Rate limits HTTP em memoria”) para a
> recomendação de `Redis Store` quando justificar.

> Atualizacao Redis: quando `REST_RATE_LIMIT_REDIS_URL` esta configurado, o estado
> dos limitadores HTTP e compartilhado entre replicas e opera em
> fail-open/circuit-breaker se o Redis ficar indisponivel.

### Per-(client, agent) client_token storage

Cada par `(client, agent)` em `client_agent_accesses` agora tem uma coluna
opcional `client_token VARCHAR(512)` que guarda o **bearer token do cliente
final** usado pelo agente para autorizar SQL (`sql.execute params.client_token`
e aliases `clientToken` / `auth`). O cliente gerencia esse token via dois
endpoints REST dedicados:

- `GET  /api/v1/client/me/agents/{agentId}/client-token` — retorna
  `{ agentId, clientToken: string | null }`. `null` quando não há token
  armazenado. Requer acesso aprovado ao agente; senão `403 AGENT_ACCESS_DENIED`.
- `PUT  /api/v1/client/me/agents/{agentId}/client-token` — body
  `{ clientToken: string | null }`. String vazia é normalizada para `null`.
  Tamanho máximo do token: **512 chars** (mesmo cap da coluna). Não cria a
  linha de acesso — o cliente precisa primeiro ter o agente aprovado.

Os endpoints de listagem/detalhe (`GET /client/me/agents` e
`GET /client/me/agents/{agentId}`) **não** retornam o valor do token; em vez
disso expõem `hasClientToken: boolean` por agente. Isso evita que o token
vaze por listagens paginadas. O token é apagado automaticamente quando a linha
de acesso é removida (cascata por `client_id`/`agent_id`).

**Auditoria.** Toda escrita do token (set ou clear) gera uma linha em
`audit_events` com:

- `event_type` — `client_token.set` ou `client_token.cleared`
- `actor_user_id` — `clients.id` do cliente autenticado
- `actor_role` — `"client"`
- `direction` — `"control"`
- `agent_id` — agente alvo
- `payload_json` — `{ "len": <int>, "replacedExisting": <bool> }`

O **valor** do token nunca é persistido em `audit_events` (só `len` e
`replacedExisting`). Isso permite responder perguntas tipo "quem trocou o
token às 14h32?" sem expor a credencial em logs/auditoria.

O bridge REST continua aceitando `params.client_token` no body do comando
(`POST /api/v1/agents/commands`); o storage adicionado aqui é apenas para o
cliente persistir o valor entre sessões — o consumer pode ler com `GET` e
incluir manualmente em cada `sql.execute`, ou um SDK pode automatizar.

### Endurecimento HTTP do hub

Mudanças aplicadas no `app.ts` / middlewares para produção:

- **CORS multi-origem**: `CORS_ORIGIN` aceita lista por vírgula
  (`https://app.example.com,https://admin.example.com`); a origem é validada
  via callback e o `Access-Control-Allow-Credentials` só é habilitado quando
  há lista específica (não com `*`).
- **`/metrics`** (root e `/api/v1/metrics`) exige role `admin` (anteriormente
  qualquer usuário autenticado conseguia raspar).
- **`x-request-id`** ecoado apenas se casar `^[A-Za-z0-9._-]{1,128}$`; caso
  contrário, substituído por `crypto.randomUUID()` para mitigar log injection
  e header splitting.
- **`/health/ready`** faz probe `SELECT 1` no Postgres com timeout 1500 ms e
  retorna `503` + `status:"degraded"` em falha. `/health/live` continua sempre
  `200`. Em `NODE_ENV=test` o probe é omitido (in-memory repos).
- **`/uploads`** servido com `etag`, `maxAge: 7d`, `immutable`, `dotfiles:
deny`, `fallthrough: false`, `index: false`.
- **Cookies de refresh** (`refresh_token` user, `client_refresh_token` client)
  agora têm `Max-Age` derivado de `JWT_REFRESH_EXPIRES_IN`. Logout, mudança de
  senha (user + client) sempre limpam o cookie, mesmo quando a revogação no
  servidor falha — evita cookie órfão no navegador.
- **`credentialAuthRateLimit`** (25 req / 15 min) aplicado **apenas** nos
  endpoints de credencial. Endpoints autenticados como `/auth/me`,
  `/auth/password`, `/client-auth/me`, `/client-auth/password` deixaram de ser
  blanket-rate-limited. Auto-bypass em test runner para não bloquear
  integration tests.
- **Upload de thumbnail** valida magic bytes via `sharp().metadata()` (não
  confia no `Content-Type` do cliente). `MulterError` (size limit, etc.) vira
  `400 BAD_REQUEST` em vez de `500`.
- **`requireAuthAndActiveAccountSnapshot`** (lightweight) usado em rotas GET
  read-only (`/agents`, `/agents/catalog`, `/agents/catalog/:agentId`,
  `/me/agents`, `/users/:userId/agents`) — evita carregar `password_hash` e
  outros campos pesados do `User` em paths que só precisam de
  status/credentials_version. Mutações continuam usando o middleware completo.
- **`GET /api/v1/agents`** retorna apenas `{ agentId, userId, capabilities,
connectedAt, lastSeenAt }` por agente; o `socketId` interno do Engine.IO
  deixou de ser exposto.

---

## Resposta do agente - formato JSON-RPC v2

### sql.execute result

| Campo                | Tipo    | Sempre presente | Descricao                                                                                                                                                          |
| -------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execution_id`       | string  | sim             | ID unico da execucao                                                                                                                                               |
| `started_at`         | string  | sim             | Inicio da execucao (ISO-8601)                                                                                                                                      |
| `finished_at`        | string  | sim             | Fim da execucao (ISO-8601)                                                                                                                                         |
| `rows`               | array   | sim             | Linhas retornadas                                                                                                                                                  |
| `row_count`          | integer | sim             | Total de linhas retornadas                                                                                                                                         |
| `returned_rows`      | integer | nao             | Linhas efetivamente retornadas (paginacao)                                                                                                                         |
| `affected_rows`      | integer | nao             | Linhas afetadas (INSERT/UPDATE/DELETE)                                                                                                                             |
| `truncated`          | boolean | nao             | True se resultado foi truncado por limite                                                                                                                          |
| `column_metadata`    | array   | nao             | Metadados das colunas retornadas                                                                                                                                   |
| `multi_result`       | boolean | nao             | True quando multi-result ativo                                                                                                                                     |
| `result_set_count`   | integer | nao             | Quantidade de result sets (multi-result)                                                                                                                           |
| `item_count`         | integer | nao             | Quantidade de items (multi-result)                                                                                                                                 |
| `result_sets`        | array   | nao             | Array de result sets (multi-result)                                                                                                                                |
| `items`              | array   | nao             | Array unificado de result sets e row counts                                                                                                                        |
| `pagination`         | object  | nao             | Presente apenas em requests paginadas                                                                                                                              |
| `stream_id`          | string  | nao             | Presente quando streaming ativo                                                                                                                                    |
| `sql_handling_mode`  | string  | nao             | Modo efetivo usado: `managed` ou `preserve` (v2.5+)                                                                                                                |
| `max_rows_handling`  | string  | nao             | Politica ativa para `max_rows` (ex.: `response_truncation`) (v2.5+)                                                                                                |
| `effective_max_rows` | integer | nao             | Limite efetivo de linhas apos negociacao (min entre solicitado e limite do transporte); util para debug e suporte (schema `rpc.result.sql-execute` no plug_agente) |

### sql.execute pagination

Objeto presente quando a requisicao inclui `page`+`page_size` ou `cursor`. A requisicao paginada deve usar SQL com **`ORDER BY` explicito** (ver regras em `command.params.options`).

| Campo               | Tipo    | Descricao                                        |
| ------------------- | ------- | ------------------------------------------------ |
| `page`              | integer | Pagina atual                                     |
| `page_size`         | integer | Tamanho da pagina                                |
| `returned_rows`     | integer | Linhas retornadas nesta pagina                   |
| `has_next_page`     | boolean | Se existe proxima pagina                         |
| `has_previous_page` | boolean | Se existe pagina anterior                        |
| `current_cursor`    | string  | Cursor da pagina atual (opcional)                |
| `next_cursor`       | string  | Cursor para proxima pagina (quando cursor ativo) |

### sql.executeBatch result

| Campo                 | Tipo    | Sempre presente | Descricao                    |
| --------------------- | ------- | --------------- | ---------------------------- |
| `execution_id`        | string  | sim             | ID unico do batch            |
| `started_at`          | string  | sim             | Inicio (ISO-8601)            |
| `finished_at`         | string  | sim             | Fim (ISO-8601)               |
| `items`               | array   | sim             | Resultado de cada comando    |
| `total_commands`      | integer | sim             | Total de comandos no batch   |
| `successful_commands` | integer | sim             | Comandos que tiveram sucesso |
| `failed_commands`     | integer | sim             | Comandos que falharam        |

### sql.executeBatch items[]

| Campo             | Tipo    | Descricao                              |
| ----------------- | ------- | -------------------------------------- |
| `index`           | integer | Indice do comando no array original    |
| `ok`              | boolean | Se o comando foi executado com sucesso |
| `rows`            | array   | Linhas retornadas                      |
| `row_count`       | integer | Total de linhas                        |
| `affected_rows`   | integer | Linhas afetadas                        |
| `error`           | string  | Mensagem de erro quando `ok: false`    |
| `column_metadata` | array   | Metadados das colunas                  |

### sql.cancel result

| Campo          | Tipo    | Descricao                    |
| -------------- | ------- | ---------------------------- |
| `cancelled`    | boolean | Se o cancelamento foi aceito |
| `execution_id` | string  | ID da execucao cancelada     |
| `request_id`   | string  | ID do request cancelado      |

### Formato de erro RPC

Quando o agente retorna erro, `response.item.error` segue:

| Campo                    | Tipo    | Obrigatorio | Descricao                       |
| ------------------------ | ------- | ----------- | ------------------------------- |
| `code`                   | integer | sim         | Codigo de erro JSON-RPC         |
| `message`                | string  | sim         | Mensagem do erro                |
| `data.reason`            | string  | sim         | Identificador estavel do motivo |
| `data.category`          | string  | sim         | Classe do erro para roteamento  |
| `data.retryable`         | boolean | sim         | Se retry automatico faz sentido |
| `data.user_message`      | string  | sim         | Mensagem amigavel para UI       |
| `data.technical_message` | string  | sim         | Detalhe tecnico para logs       |
| `data.correlation_id`    | string  | sim         | ID para correlacao de logs      |
| `data.timestamp`         | string  | sim         | Instante UTC (ISO-8601)         |

---

## Catalogo de erros RPC

### JSON-RPC padrao

| Codigo   | Descricao        | `reason`           |
| -------- | ---------------- | ------------------ |
| `-32700` | Parse error      | `json_parse_error` |
| `-32600` | Invalid request  | `invalid_request`  |
| `-32601` | Method not found | `method_not_found` |
| `-32602` | Invalid params   | `invalid_params`   |
| `-32603` | Internal error   | `internal_error`   |

### Transporte

| Codigo   | Descricao          | `reason`                                         | `retryable` |
| -------- | ------------------ | ------------------------------------------------ | ----------- |
| `-32001` | Authentication     | `authentication_failed` / `missing_client_token` | false       |
| `-32002` | Unauthorized       | `unauthorized` / `token_revoked`                 | false       |
| `-32008` | Timeout            | `timeout`                                        | true        |
| `-32009` | Invalid payload    | `invalid_payload`                                | false       |
| `-32010` | Decoding failed    | `decoding_failed`                                | false       |
| `-32011` | Compression failed | `compression_failed`                             | false       |
| `-32012` | Network error      | `network_error`                                  | true        |
| `-32013` | Rate limit         | `rate_limited`                                   | false       |
| `-32014` | Replay detected    | `replay_detected`                                | false       |

### Dominio SQL

| Codigo   | Descricao                  | `reason`                     | `retryable` |
| -------- | -------------------------- | ---------------------------- | ----------- |
| `-32101` | SQL validation failed      | `sql_validation_failed`      | false       |
| `-32102` | SQL execution failed       | `sql_execution_failed`       | false       |
| `-32103` | Transaction failed         | `transaction_failed`         | false       |
| `-32104` | Connection pool exhausted  | `connection_pool_exhausted`  | true        |
| `-32105` | Result too large           | `result_too_large`           | false       |
| `-32106` | Database connection failed | `database_connection_failed` | true        |
| `-32107` | Query timeout              | `query_timeout`              | true        |
| `-32108` | Invalid database config    | `invalid_database_config`    | false       |
| `-32109` | Execution not found        | `execution_not_found`        | false       |
| `-32110` | Execution cancelled        | `execution_cancelled`        | false       |

### Orientacao para clientes HTTP

- Exibir `error.data.user_message` ao usuario final.
- Oferecer "Tentar novamente" quando `error.data.retryable` for `true`.
- Registrar `error.data.correlation_id` nos logs para suporte.
- Nunca exibir `technical_message` ou stack traces ao usuario.

---

## Analise de gaps: REST vs Socket

Esta secao resume as diferencas relevantes entre o bridge REST e os canais
Socket do consumer. Os contratos detalhados continuam nas secoes anteriores
deste arquivo e em `docs/socket/socket_relay_protocol.md`.

### Recursos disponiveis no agente vs cobertura REST

| Recurso do agente                                                      | Socket status              | REST status       | Gap                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sql.execute`                                                          | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| `sql.executeBatch`                                                     | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| `sql.bulkInsert`                                                       | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| `sql.cancel`                                                           | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| `rpc.discover`                                                         | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| `client_token.getPolicy`                                               | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| PayloadFrame encode/decode                                             | implementado               | transparente      | -                                                                                                                                                                                                                                                                                                                       |
| Compressao GZIP (modo **auto** por defeito; `payloadFrameCompression`) | implementado               | transparente      | cliente escolhe `default` / `none` / `always` no body REST ou envelope relay                                                                                                                                                                                                                                            |
| Assinatura de payload (HMAC-SHA256)                                    | implementado               | opcional saida    | verificacao de frames **do** agente quando assinados; assinatura **de saida** do hub com `PAYLOAD_SIGN_OUTBOUND=true` e `PAYLOAD_SIGNING_KEY`. `PAYLOAD_SIGNING_KEY_ID` define a chave ativa; `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON` aceita chaves antigas apenas inbound. Com keyring, `signature.key_id` e obrigatorio. |
| Token carrier (client_token/clientToken/auth)                          | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| Paginacao (page/page_size)                                             | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| Paginacao (cursor keyset)                                              | implementado               | exposto           | -                                                                                                                                                                                                                                                                                                                       |
| `multi_result` (multiplos result sets)                                 | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| `idempotency_key`                                                      | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| `database` (override DSN)                                              | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| `options.timeout_ms` / `options.max_rows`                              | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| `options.execution_mode` (managed/preserve)                            | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| `options.preserve_sql` (alias legado)                                  | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| `options.prefer_db_streaming` (`sql.execute`)                          | implementado               | validado          | pass-through; elegibilidade, feature flag e roteamento final sao do agente                                                                                                                                                                                                                                              |
| `options.transaction` (batch)                                          | implementado               | validado          | -                                                                                                                                                                                                                                                                                                                       |
| `options.max_parallel_read_only_batch_items` (batch)                   | implementado               | validado          | pass-through; o agente aplica safety cap conforme pool/limites internos                                                                                                                                                                                                                                                 |
| `api_version` no request                                               | implementado               | exposto           | hub **preserva** `api_version` enviado pelo cliente; se ausente, usa `"2.11.2"` como fallback, alinhado ao profile anunciado em `agent:capabilities` (`plug-jsonrpc-profile/2.11.2`)                                                                                                                                    |
| `meta` no request (trace_id, traceparent)                              | implementado               | exposto           | hub preserva apenas os campos publicados pelo schema do `plug_agente` (`trace_id`, `traceparent`, `tracestate`, `request_id`, `agent_id`, `timestamp`); campos extras aceitos na entrada sao **stripados** antes do envio ao agente; o hub injeta/reescreve `request_id`, `agent_id`, `timestamp`, `trace_id`           |
| `meta.outbound_compression` (`none` / `gzip` / `auto`)                 | **no-op** no runtime atual | aceito + OpenAPI  | aceito por compatibilidade na entrada, mas **nao e encaminhado** ao agente; o `socket_communication_standard.md` (v2.8, _Nota operacional_) declara explicitamente que o agente **nao** suporta override de compressao por request                                                                                      |
| `api_version` na response                                              | implementado               | exposto           | serializer preserva `api_version` e `meta` do agente                                                                                                                                                                                                                                                                    |
| `meta` na response (agent_id, timestamp)                               | implementado               | exposto           | serializer preserva `meta` do agente                                                                                                                                                                                                                                                                                    |
| Batch max 32 itens                                                     | implementado               | validado          | servidor rejeita batches > 32 com 400                                                                                                                                                                                                                                                                                   |
| Capacidade de pendencias REST                                          | implementado               | validado          | limite global (`SOCKET_REST_MAX_PENDING_REQUESTS`) + limite/fila por agente (`SOCKET_REST_AGENT_MAX_INFLIGHT`, `SOCKET_REST_AGENT_MAX_QUEUE`, `SOCKET_REST_AGENT_QUEUE_WAIT_MS`) com `Retry-After` em overload                                                                                                          |
| Streaming chunked (`rpc:chunk`/`rpc:complete`)                         | implementado               | **materializado** | REST (`sql.execute` unico): hub faz pull interno, agrega linhas e devolve **uma** resposta HTTP (sem streaming progressivo). Socket /consumers continua com eventos em tempo real                                                                                                                                       |
| Backpressure (`rpc:stream.pull`)                                       | implementado               | **interno**       | REST nao expoe pull ao cliente; o hub emite `rpc:stream.pull` com janela base em `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`, sempre limitada por `SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE` e pelo menor teto anunciado pelo agente. Controle fino permanece no Socket (`agents:stream_pull` / relay)                         |
| Delivery guarantee (`rpc:request_ack`)                                 | implementado               | exposto           | hub registra ack e marca `acked`; se o ACK nao chega, reemite o mesmo frame apenas para requests elegiveis e idempotentes/seguras, limitado por `SOCKET_AGENT_ACK_*`                                                                                                                                                    |
| Batch ack (`rpc:batch_ack`)                                            | implementado               | exposto           | hub registra acks para cada `request_id`; retry automatico de batch so ocorre quando todos os itens sao elegiveis, tem `id` e usam leitura segura ou `params.idempotency_key`                                                                                                                                           |
| Notification JSON-RPC (`id: null`)                                     | implementado               | exposto           | `id` omitido recebe UUID automatico (200); somente `id: null` em todos os itens retorna 202                                                                                                                                                                                                                             |
| Falha rapida em disconnect do agente                                   | implementado               | exposto           | pending requests REST do socket desconectado sao encerradas com 503 sem aguardar timeout; **novo** pedido REST com `id` correlacionavel contra agente catalogado sem socket devolve **200** + envelope normalizado `agent_offline` (`-32000`)                                                                           |
| Heartbeat (`agent:heartbeat`)                                          | implementado               | transparente      | -                                                                                                                                                                                                                                                                                                                       |
| Capabilities negotiation                                               | implementado               | transparente      | -                                                                                                                                                                                                                                                                                                                       |

### Limitacoes intencionais do canal REST

- nao ha streaming progressivo por HTTP; `sql.execute` com `stream_id` e
  materializado no hub e devolvido como resposta final unica
- o cliente HTTP nao controla `rpc:stream.pull`; esse fluxo e interno ao hub
- `rpc:request_ack` / `rpc:batch_ack` continuam observados para telemetria e troubleshooting;
  retry automatico existe apenas para comandos seguros/idempotentes, nao para notificacoes
- o estado de correlacao continua em memoria por processo; multi-instancia sem
  afinidade/shared state nao e o alvo atual

Quando precisares de `rpc:chunk`, `rpc:complete`, `stream_pull` explicito,
isolamento por conversa ou menor latencia por stream, usa `/consumers` com
`agents:*` ou `relay:*`.

### Comportamentos importantes mantidos pelo bridge

- `api_version` e `meta` do request sao preservados/mesclados antes do dispatch
- `api_version` e `meta` da response sao preservados pelo serializer
- batch JSON-RPC continua limitado a 32 itens
- `id: null` continua sendo notification; `id` omitido recebe UUID e aguarda resposta
- overload por agente responde com `503` e `Retry-After`
- agente catalogado offline (sem `/agents`) com pedido correlacionavel: `200` + `response.item.error` / batch items com `code: -32000`, `message: agent_offline`, `data.reason: agent_disconnected_at_dispatch`
- abort do cliente HTTP limpa a pending request sem deixar correlacao pendurada
- frame invalido do agente falha a request correlacionada imediatamente, sem esperar timeout

---

## Configuracao e tuning

Defaults e fonte de verdade das variaveis: `docs/configuration.md`.
Guia agregado de tuning e operacao: `docs/performance/performance_hub_agent.md`.
Metricas, traces e alertas: `docs/observability/observability.md`.

### Traces de latencia do bridge (`BRIDGE_LATENCY_TRACE_*`)

Para persistir tempos por fase do bridge, ative
`BRIDGE_LATENCY_TRACE_ENABLED=true`. Regras de amostragem, esquema da tabela,
metricas `plug_bridge_latency_trace_*` e exemplos de consulta ficam em
`docs/observability/observability.md`.

### REQUEST_BODY_LIMIT e tamanho de payload

O Express limita o body das requisicoes via `REQUEST_BODY_LIMIT` (default: `1mb`).
O PayloadFrame interno suporta ate 10MB (compressao e decodificacao).

Para comandos com `params.params` grandes (ex.: muitos parametros ou valores longos),
aumente o limite:

```bash
REQUEST_BODY_LIMIT=2mb   # ou 5mb conforme necessidade
```

O valor deve ser menor ou igual ao limite do PayloadFrame (10MB).

### Pub/sub customizado (REST ou Socket)

`POST /api/v1/client/me/socket-events` e um contrato separado do bridge RPC.
Ele nao envia comandos JSON-RPC ao agente e nao substitui
`POST /api/v1/agents/commands`. A rota permite que um `Client` autenticado
publique eventos de aplicacao `client:custom.*` para sockets `/consumers`
inscritos via `socket:event.subscribe`. A alternativa equivalente no Socket e
`socket:event.publish` (ver `docs/socket/socket_relay_protocol.md`).

O corpo JSON usa `{ eventName, payload, payloadFrameCompression? }`; multipart
usa o campo `event` com esse JSON e campos `files` repetidos para anexos inline
pequenos. O hub entrega um `PayloadFrame` no proprio `eventName`, com
`{ eventId, eventName, emittedAt, publisher, payload, attachments }`.
O campo `payload` e obrigatorio mesmo quando for `null`. Para retries HTTP,
envie `Idempotency-Key`: a mesma chave com o mesmo corpo reaproveita a resposta
`202` sem publicar de novo; a mesma chave com outro corpo retorna `409`.
A **mesma** chave e fingerprint partilham-se com `idempotencyKey` em `socket:event.publish` (mesmo `Client` JWT `sub`); ver `docs/socket/socket_relay_protocol.md`.
Campos de arquivo diferentes de `files` sao rejeitados.

Sem adapter distribuido do Socket.IO, a publicacao e local a replica que recebeu
o pedido (REST ou Socket). A resposta `202` ou o ack `socket:event.published` confirmam emissao local e incluem `recipients`; nao
confirma processamento pelo listener do cliente. O fan-out local pode ser
limitado por `REST_SOCKET_EVENT_MAX_RECIPIENTS`; nesse `503`, `details.retry_after_ms` segue `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (por defeito `2000`). Outro `503` raro: `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` > 0 e demasiadas chaves de idempotencia **distintas** em voo no mesmo processo — o mesmo `retry_after_ms` e usado como sugestao de backoff (e o hub pode enviar `Retry-After` no REST). Falha ao codificar o `PayloadFrame` no fan-out local tambem devolve `503` / `SERVICE_UNAVAILABLE` com o mesmo `retry_after_ms`. O limitador HTTP desta rota usa `express-rate-limit` com `skipFailedRequests`: respostas com `statusCode >= 500` ao `finish` **nao** contam para a janela (decremento pos-resposta); `4xx` contam (paridade com o refund do publish via Socket so em falhas nao-4xx).

### Rate limit do endpoint commands

O endpoint `POST /api/v1/agents/commands` possui rate limit proprio, alem do global:

| Variavel                                    | Default         | Descricao                                                                                                                                                                  |
| ------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` | 60000           | Janela em ms (1 min)                                                                                                                                                       |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX`       | 100             | Max requests por janela por **utilizador** (JWT `sub`)                                                                                                                     |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX`    | `0` (desligado) | Opcional: max por **IP** na mesma janela. `> 0` ativa um segundo limitador (ex.: `300` em NAT). Atras de proxy, configurar `trust proxy` no Express para `req.ip` correto. |

Ajuste conforme capacidade dos agentes e padrao de uso.

**Nota (Socket):** o evento `agents:command` no `/consumers` usa o **mesmo** body e validacao e um
rate limit **por Socket** com os **mesmos** `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` e
`REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` por JWT `sub` (contador separado do Express). Relay: `SOCKET_RELAY_RATE_LIMIT_*`.
Ver `docs/socket/socket_client_sdk.md`.

### Log de `id` JSON-RPC auto-atribuido

Quando o hub gera UUID para `id` omitido (`ensureJsonRpcIdsForBridge`), pode registrar um evento
estruturado para suporte:

| Variavel                     | Default | Descricao                                                                                                         |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `BRIDGE_LOG_JSONRPC_AUTO_ID` | `false` | Se `true`, emite **INFO** `bridge_jsonrpc_id_assigned` com `method`, `assigned_id` e opcionalmente `batch_index`. |

Em `NODE_ENV=development`, o mesmo evento e emitido em nivel **DEBUG** (via `console.debug`) sem
precisar da variavel — util para depuracao local sem poluir producao.

### Relay e auditoria

Os knobs de relay, fila outbound, idempotencia e auditoria Socket continuam
documentados em `docs/performance/performance_hub_agent.md`, `docs/observability/observability.md` e
`docs/configuration.md`, porque sao compartilhados entre REST, `agents:*` e
`relay:*` e nao pertencem apenas a este endpoint.

---

## Roadmap tecnico

Refatoracao incremental de **`rpc_bridge.ts`**: `rest_sql_stream_materialize.ts` (stream SQL REST),
`rest_agent_dispatch_queue.ts` (fila/inflight por agente), `rest_pending_requests.ts` (pending JSON-RPC
REST por correlation id), `relay_idempotency_store.ts` (idempotencia relay por conversa),
`relay_stream_flow_state.ts` (buffer/creditos de stream relay), `relay_request_registry.ts` (rotas
relay pendentes e indices), `bridge_relay_health_metrics.ts` (circuit, latencia, contadores, snapshot
`/metrics`), `active_stream_registry.ts` (streams ativos agente↔cliente), `rpc_bridge_command_helpers.ts`
(helpers puros `BridgeCommand`/JSON-RPC), `rpc_bridge_relay_stream.ts` (handlers de stream relay + timeout),
`rpc_bridge_agent_inbound.ts` (respostas/chunks/complete/acks vindos do agente),
`rpc_bridge_stream_pull.ts` / `rpc_bridge_dispatch_relay.ts` / `rpc_bridge_dispatch_command.ts` (stream pull, dispatch relay, dispatch REST/Socket).
O que resta em `rpc_bridge.ts` e sobretudo **wiring** (namespaces, `emitToConsumer`, factories) e **`resetSocketBridgeState`** (delega stores a `rpc_bridge_lifecycle.ts`); pode
seguir o mesmo padrao. Acompanhamento:
[CHANGELOG.md](../CHANGELOG.md)
(secao _Roadmap tecnico_).

## Mapa de arquivos relevantes

| Arquivo                                                                  | Papel                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `src/presentation/http/routes/agents.routes.ts`                          | Definicao da rota e Swagger                                                                                                |
| `src/presentation/http/validators/agents.validator.ts`                   | Reexporta schemas de `shared/validators/agent_command`                                                                     |
| `src/presentation/http/controllers/agents.controller.ts`                 | Controller: chama executeAgentCommand                                                                                      |
| `src/presentation/http/serializers/agent_rpc_response.serializer.ts`     | Normalizacao da resposta do agente                                                                                         |
| `src/presentation/socket/hub/relay/rpc_bridge.ts`                        | Bridge: emit rpc:request no namespace /agents                                                                              |
| `src/presentation/socket/hub/relay/rest_sql_stream_materialize.ts`       | Creditos + estado do stream REST materializado (`sql.execute`)                                                             |
| `src/presentation/socket/hub/relay/rest_agent_dispatch_queue.ts`         | Fila + inflight por `agentId` no bridge REST (`SOCKET_REST_AGENT_*`)                                                       |
| `src/presentation/socket/hub/registries/rest_pending_requests.ts`        | Mapa correlation id -> `PendingRequest`, capacidade `SOCKET_REST_MAX_PENDING_REQUESTS`                                     |
| `src/presentation/socket/hub/registries/relay_idempotency_store.ts`      | Idempotencia relay (`client_request_id` por conversa), TTL e timer de limpeza                                              |
| `src/presentation/socket/hub/relay/relay_stream_flow_state.ts`           | Estado de backpressure do stream relay (creditos, fila de chunks, complete pendente)                                       |
| `src/presentation/socket/hub/registries/relay_request_registry.ts`       | Registo de `RelayRequestRoute`, limites `SOCKET_RELAY_MAX_PENDING_*`, cleanup por conversa/socket                          |
| `src/presentation/socket/hub/relay/bridge_relay_health_metrics.ts`       | Circuit por agente, latencia, `relayMetrics`, snapshot Prometheus (via `rpc_bridge.getRelayMetricsSnapshot`)               |
| `src/presentation/socket/hub/registries/active_stream_registry.ts`       | Rotas `ActiveStreamRoute` (legacy + relay), limite `SOCKET_RELAY_MAX_ACTIVE_STREAMS` (gauge)                               |
| `src/presentation/socket/hub/relay/rpc_bridge_command_helpers.ts`        | Helpers puros: ids de resposta/correlation, `withBridgeMeta`, `api_version`, `stream_id` em resultados                     |
| `src/presentation/socket/hub/relay/rpc_bridge_relay_stream.ts`           | Stream relay: `createRelayStreamHandlers`, `emitRelayTimeoutResponse` (backpressure + idempotencia no timeout)             |
| `src/presentation/socket/hub/relay/rpc_bridge_agent_inbound.ts`          | Handlers de entrada do agente: `createRpcBridgeAgentInboundHandlers` → `handleAgentRpc*` (reexportados em `rpc_bridge.ts`) |
| `src/presentation/socket/hub/relay/rpc_bridge_stream_pull.ts`            | `createRequestAgentStreamPull` — pull de stream (legacy + creditos relay apos emit ao agente)                              |
| `src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay.ts`         | `createRpcBridgeRelayDispatch` — `dispatchRelayRpcToAgent`, `requestRelayStreamPull`                                       |
| `src/presentation/socket/hub/relay/rpc_bridge_dispatch_command.ts`       | `createDispatchRpcCommandToAgent` — `dispatchRpcCommandToAgent` (HTTP + `agents:command`)                                  |
| `src/presentation/socket/hub/relay/rpc_bridge_lifecycle.ts`              | Cleanup por socket/conversa, `resetRpcBridgeMutableStores` (reexport cleanup via `rpc_bridge.ts`)                          |
| `src/application/agent_commands/merge_sql_stream_rpc_response.ts`        | Junta `rpc:response` inicial + chunks + `rpc:complete` em uma resposta JSON-RPC                                            |
| `src/presentation/socket/hub/registries/agent_registry.ts`               | Registry de agentes conectados                                                                                             |
| `src/presentation/socket/consumers/agents_command.handler.ts`            | Handler Socket para agents:command no /consumers                                                                           |
| `src/presentation/socket/consumers/agents_stream_pull.handler.ts`        | Handler Socket para agents:stream_pull no /consumers                                                                       |
| `src/presentation/socket/consumers/relay_conversation_start.handler.ts`  | Handler Socket relay:conversation.start                                                                                    |
| `src/presentation/socket/consumers/relay_conversation_end.handler.ts`    | Handler Socket relay:conversation.end                                                                                      |
| `src/presentation/socket/consumers/relay_rpc_request.handler.ts`         | Handler Socket relay:rpc.request                                                                                           |
| `src/presentation/socket/consumers/relay_rpc_stream_pull.handler.ts`     | Handler Socket relay:rpc.stream.pull                                                                                       |
| `src/presentation/socket/hub/registries/conversation_registry.ts`        | Registry de conversas relay por socket/agent                                                                               |
| `src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter.ts` | Rate-limit por consumer para relay                                                                                         |
| `src/application/agent_commands/execute_agent_command.ts`                | Caso de uso compartilhado HTTP + Socket                                                                                    |
| `src/application/agent_commands/command_transformers.ts`                 | Paginacao, `preserve_sql`, `ensureJsonRpcIdsForBridge`                                                                     |
| `src/application/services/socket_audit.service.ts`                       | Auditoria Socket (INSERT simples ou em lote), retencao, flush no shutdown                                                  |
| `src/presentation/http/controllers/metrics.controller.ts`                | Endpoint `/metrics` (Prometheus text); cache + delegacao para `metrics_renderer.ts`                                        |
| `src/presentation/http/controllers/metrics_renderer.ts`                  | `buildMetricsLines(snapshots)` — render puro de todas as metricas Prometheus                                               |
| `src/shared/validators/agent_command.ts`                                 | Schemas transport-agnosticos                                                                                               |
| `src/shared/utils/payload_frame.ts`                                      | Encode/decode PayloadFrame; preencode para batch ack                                                                       |
| `src/shared/utils/percentile.ts`                                         | Percentil quickselect (metricas)                                                                                           |
| `src/shared/utils/latency_ring_buffer.ts`                                | Buffer circular de amostras de latencia                                                                                    |
| `src/shared/utils/rpc_types.ts`                                          | isRecord, toRequestId, toJsonRpcId                                                                                         |
| `src/shared/constants/socket_events.ts`                                  | Nomes dos eventos e namespaces                                                                                             |
| `src/socket.ts`                                                          | Factory `createSocketServer`: namespaces /agents e /consumers, sinks e timers                                              |
| `src/socket_state.ts`                                                    | Tipos e estado por servidor; `agentsNamespace`/`consumersNamespace` live bindings                                          |
| `src/socket_room_ops.ts`                                                 | Helpers de sala: contagem, desconexao, cleanup de conversas expiradas                                                      |
| `src/socket_lifecycle.ts`                                                | `closeSocketServer`: drains, unregister bridge, reset de estado global                                                     |
| `src/socket_metrics_snapshot.ts`                                         | `getSocketMetricsSnapshot()` para o controller `/metrics`                                                                  |
