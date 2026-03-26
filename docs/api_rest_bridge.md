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

### REST vs Socket no consumer (mesmo comando, canais diferentes)

- **Dois canais** chegam ao mesmo fluxo interno (`executeAgentCommand` → dispatch para o agente): **HTTP** (`POST /api/v1/agents/commands`) ou **Socket** (`agents:command` no `/consumers`, ou relay `relay:rpc.request`).
- O cliente pode usar **apenas REST** (sem abrir Socket de consumer), **apenas Socket**, ou **misturar** (ex.: login e `GET /agents` por HTTP e comandos por Socket).
- **Streaming**: no REST, o hub **nao** envia chunks progressivos ao cliente HTTP; quando o agente devolve `stream_id`, o servidor **materializa** o stream por dentro e responde com **um** JSON final. Para chunks em tempo real e `stream_pull`, usar o canal Socket (legado ou relay). Ver `docs/PROJECT_OVERVIEW.md` e `docs/performance_hub_agent.md`.

Alternativa em tempo real: consumers podem conectar ao namespace `/consumers`
e emitir `agents:command` com o mesmo payload. A resposta inicial chega em
`agents:command_response`. Quando a execucao entra em streaming, os chunks
chegam em `agents:command_stream_chunk` e o encerramento em
`agents:command_stream_complete`. Para controle de fluxo (backpressure), o
consumer envia `agents:stream_pull` e recebe `agents:stream_pull_response`.

Para modo chat-like com conversa isolada (`relay:*`) e `PayloadFrame` tambem no
namespace `/consumers`, consulte `docs/socket_relay_protocol.md`.

No canal `/consumers` legado (`agents:*`), o payload e logico (JSON). O
`plug_server` encapsula e desencapsula `PayloadFrame` binario (com
`cmp: gzip|none`) apenas no enlace com `/agents`.

> Escopo deste documento: ponte REST (`POST /api/v1/agents/commands`) e canal
> Socket legado (`agents:*`). O modo relay (`relay:*`) e documentado a parte.
**Compatibilidade com plug_agente:** O agente deve conectar ao namespace `/agents`
(por exemplo, `io("/agents")`). Conexoes no namespace padrao `/` sao rejeitadas com
`app:error` (code `NAMESPACE_DEPRECATED`) e desconectadas. O token deve ter `role` em `SOCKET_AGENT_ROLES`
(default: `agent`). Consumers usam `role` em `SOCKET_CONSUMER_ROLES` (default: `user`, `admin`).

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
agent:register), consulte `docs/migracao_plug_agente_namespaces.md`.

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
5. Bridge localiza o agente no registry, gera ou reutiliza `requestId`,
   empacota o comando em `PayloadFrame` e emite `rpc:request`.
   Antes do primeiro dispatch, o hub aplica uma curta janela de estabilizacao
   apos `agent:register` (`SOCKET_AGENT_PROTOCOL_READY_GRACE_MS`) e pode liberar
   mais cedo ao receber `agent:heartbeat`; agentes que anunciam
   `extensions.protocolReadyAck` podem liberar o dispatch de forma explicita com
   `agent:ready`, reduzindo corrida com `protocol_not_ready` no `plug_agente`.
6. Bridge aguarda `rpc:response` (timeout efetivo: veja `timeoutMs` abaixo).
7. Se for `sql.execute` **unico** pelo REST e a resposta trouxer `stream_id`, o hub concede
   creditos de entrega como no relay: um `rpc:stream.pull` inicial com
   `window_size` baseado em `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` e opcionalmente
   **clampado** por capabilities do agente (`recommendedStreamPullWindowSize` /
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
8. Serializer normaliza a resposta JSON-RPC para formato HTTP.
9. Controller retorna `200` com a resposta normalizada.

## Autenticacao

| Header          | Obrigatorio | Descricao                                  |
| --------------- | ----------- | ------------------------------------------ |
| `Authorization` | sim         | `Bearer <access_token>` emitido pelo login |

O token e validado por `requireAuth` antes de qualquer processamento.

### OpenAPI (Swagger)

Os schemas em `src/presentation/docs/swagger.ts` usam os **mesmos tetos** que o validador Zod (`agent_command.ts`): `options.timeout_ms` e `sql.executeBatch` `options.timeout_ms` ate **300000** ms; `options.max_rows` (execute e batch) ate **1000000**; `options.page_size` e `pagination.pageSize` ate **50000**. A rota `POST /api/v1/agents/commands` inclui exemplos para paginacao no body, `execution_mode: preserve`, `sql.cancel` e `rpc.discover`.

## Request body

### Campos de primeiro nivel

| Campo        | Tipo   | Obrigatorio | Restricoes         | Descricao                                      |
| ------------ | ------ | ----------- | ------------------ | ---------------------------------------------- |
| `agentId`    | string | sim         | nao vazio          | UUID do agente conectado                        |
| `command`    | object \| array | sim | JSON-RPC 2.0       | Comando unico ou batch JSON-RPC (max 32)         |
| `timeoutMs`  | number | nao         | 1..360000          | Espera do bridge (`computeBridgeWaitTimeoutMs`): `max` entre o valor do body (ou default **15000** ms) e, para `sql.execute` / `sql.executeBatch`, o maior `options.timeout_ms` do comando + **5000** ms; teto **360000** ms (`AGENT_TIMEOUT_MS_LIMIT` + **60000** ms; ver `command_transformers.ts`) |
| `pagination` | object | nao         | regras combinadas  | Paginacao injetada em `command.params.options`   |
| `payloadFrameCompression` | `"default"` \| `"none"` \| `"always"` | nao | — | Politica de gzip do **PayloadFrame** que o hub emite no `rpc:request` para o agente (alinhado a `socket_communication_standard.md` / `socketio_client_binary_transport.md` do plug_agente). `default`: limiar 1024 bytes, modo **automatico** — gzip so se o bloco comprimido for **menor** que o JSON UTF-8 bruto; caso contrario `cmp: none`. `none`: nunca gzip. `always`: modo **sempre GZIP** — gzip sempre que o payload couber no limite de entrada (mesmo se o gzip nao reduzir tamanho). Nao altera respostas do agente. |

### `command` (discriminated union por `method`)

O campo `command` segue o contrato JSON-RPC 2.0. O `method` determina o schema
de `params`.

#### Campos comuns a todos os metodos

| Campo     | Tipo                    | Obrigatorio | Default | Descricao                          |
| --------- | ----------------------- | ----------- | ------- | ---------------------------------- |
| `jsonrpc` | `"2.0"`                 | nao         | `"2.0"` | Versao do protocolo                |
| `method`  | string                  | sim         | -       | Metodo RPC (ver metodos abaixo)    |
| `id`      | string \| number \| null | nao        | -       | Identificador do request           |
| `meta`    | object                  | nao         | -       | Metadados de rastreabilidade       |

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

| Onde | `id` omitido | `id: null` |
| ---- | ------------ | ---------- |
| **Hub plug_server** | servidor gera UUID e aguarda resposta (`200` / `agents:command_response` com resultado) | notification (`202` ou resposta tipo notification no Socket) |
| **Agente direto** (contrato do plug_agente) | notification (sem resposta JSON-RPC) | notification |

O **relay** (`relay:rpc.request`) continua com modelo proprio: o frame usa `id` interno gerado
pelo servidor; o `id` do cliente vira `meta.client_request_id` para idempotencia (ver
`docs/socket_relay_protocol.md` / `socket_client_sdk.md`).

O `meta` enviado pelo cliente (ex.: `traceparent`, `tracestate`) e preservado
via merge; o bridge adiciona `request_id`, `agent_id`, `timestamp` e `trace_id`.

---

## Metodos suportados

### `sql.execute`

Executa um comando SQL no agente.

#### `command.params`

| Campo          | Tipo   | Obrigatorio | Descricao                                                               |
| -------------- | ------ | ----------- | ----------------------------------------------------------------------- |
| `sql`          | string | sim         | Comando SQL (SELECT, INSERT, UPDATE, DELETE, MERGE, WITH)               |
| `params`       | object | nao         | Parametros nomeados para o SQL (ex: `{ "id": 1 }`)                     |
| `client_token` | string | condicional | Token opaco ou JWT para autorizacao no agente                           |
| `clientToken`  | string | condicional | Alias de `client_token`                                                 |
| `auth`         | string | condicional | Alias de `client_token`                                                 |
| `options`      | object | nao         | Opcoes de execucao (ver tabela abaixo)                                  |

Token de autorizacao: pelo menos um entre `client_token`, `clientToken` ou
`auth` e obrigatorio quando `enableClientTokenAuthorization` estiver ativo no agente.

#### Limites de tamanho (JSON logico, UTF-8)

Validacao no hub antes do `PayloadFrame` (constantes em `agent_command.ts`):

| Campo | Teto |
| ----- | ---- |
| `sql` (`sql.execute` e cada item de `sql.executeBatch`) | **1 MiB** UTF-8 |
| `params` nomeado (objeto serializado em JSON) | **2 MiB** UTF-8 |
| `rpc.discover` `params` (objeto serializado) | **64 KiB** UTF-8 |

O limite HTTP total continua a ser `REQUEST_BODY_LIMIT`; estes tetos evitam cargas JSON enormes mesmo com body permitido maior.

#### `command.params.options`

| Campo             | Tipo    | Obrigatorio | Restricoes                               | Descricao                                                      |
| ----------------- | ------- | ----------- | ---------------------------------------- | -------------------------------------------------------------- |
| `timeout_ms`      | integer | nao         | 1..300000 (5 min)                        | Timeout de execucao SQL no agente (ms)                         |
| `max_rows`        | integer | nao         | 1..1000000, default 50000                | Maximo de linhas retornadas (limite alinhado ao agente)        |
| `page`            | integer | nao         | >= 1, requer `page_size`                 | Numero da pagina (1-based)                                     |
| `page_size`      | integer | nao         | 1..50000, requer `page`                  | Linhas por pagina                                              |
| `cursor`         | string  | nao         | exclusivo com `page`/`page_size`         | Token opaco de continuacao (keyset)                            |
| `execution_mode` | string  | nao         | `managed` \| `preserve`                  | Modo de tratamento da SQL. `managed` (default) permite reescrita gerenciada para paginacao. `preserve` executa a SQL exatamente como enviada, sem reescrita. Nao pode ser combinado com `page`, `page_size` ou `cursor` |
| `preserve_sql`   | boolean | nao         | exclusivo com paginacao                  | Alias legado para `execution_mode: "preserve"`. Nao pode ser combinado com `page`, `page_size` ou `cursor` |
| `multi_result`   | boolean | nao         | exclusivo com paginacao e `params`       | Habilita retorno de multiplos result sets                      |

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

| Campo          | Tipo   | Obrigatorio | Descricao                                                    |
| -------------- | ------ | ----------- | ------------------------------------------------------------ |
| `commands`     | array  | sim         | Array de comandos SQL (min 1 item)                           |
| `client_token` | string | condicional | Token opaco ou JWT (ou alias `clientToken` / `auth`)         |
| `clientToken`  | string | condicional | Alias de `client_token`                                      |
| `auth`         | string | condicional | Alias de `client_token`                                      |
| `options`      | object | nao         | Opcoes de execucao (ver abaixo)                              |

#### `command.params.commands[]`

| Campo    | Tipo   | Obrigatorio | Descricao                              |
| -------- | ------ | ----------- | -------------------------------------- |
| `sql`    | string | sim         | Comando SQL                            |
| `params` | object | nao         | Parametros nomeados para o comando SQL |
| `execution_order` | integer | nao | Ordem explicita de execucao (>= 0). Itens com `execution_order` executam antes dos itens sem ordem, em ordem crescente |

#### `command.params.options`

| Campo         | Tipo    | Obrigatorio | Descricao                                     |
| ------------- | ------- | ----------- | --------------------------------------------- |
| `timeout_ms`  | integer | nao         | Timeout de execucao total do batch (ms)       |
| `max_rows`    | integer | nao         | Maximo de linhas por comando                  |
| `transaction` | boolean | nao         | Envolve os comandos em uma transacao unica    |

#### Campos opcionais validados e encaminhados ao agente

| Campo             | Tipo   | Obrigatorio | Descricao                        |
| ----------------- | ------ | ----------- | -------------------------------- |
| `idempotency_key` | string | nao         | Chave de deduplicacao            |
| `database`        | string | nao         | Override de database/DSN alvo    |

---

### `sql.cancel`

Cancela uma execucao em streaming ativa.

#### `command.params`

| Campo          | Tipo   | Obrigatorio | Descricao                                           |
| -------------- | ------ | ----------- | --------------------------------------------------- |
| `execution_id` | string | condicional | ID da execucao a cancelar (pelo menos um dos dois)  |
| `request_id`   | string | condicional | ID do request a cancelar (pelo menos um dos dois)   |

Nao requer token de autorizacao.

---

### `rpc.discover`

Retorna o documento OpenRPC do agente com o catalogo de metodos suportados.

#### `command.params`

| Campo | Tipo   | Obrigatorio | Descricao                   |
| ----- | ------ | ----------- | --------------------------- |
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

## `pagination` (nivel do body, nao do command)

Quando informado, o servidor injeta os valores em `command.params.options`
antes de enviar ao agente. Isso simplifica o uso pelo cliente HTTP.

**Precedencia:** Quando `body.pagination` e `command.params.options` definem
paginacao (page/page_size ou cursor), os valores de `body.pagination` tem
precedencia e sobrescrevem os de `command.params.options`.

| Campo      | Tipo    | Obrigatorio | Restricoes                          | Descricao                    |
| ---------- | ------- | ----------- | ----------------------------------- | ---------------------------- |
| `page`     | integer | condicional | >= 1, requer `pageSize`             | Numero da pagina (1-based)   |
| `pageSize` | integer | condicional | 1..50000, requer `page`             | Linhas por pagina            |
| `cursor`   | string  | condicional | exclusivo com `page`/`pageSize`     | Token de continuacao keyset  |

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

O campo opcional afeta apenas o `PayloadFrame` que o hub emite em `rpc:request` no `/agents` (nao o corpo HTTP em si). Mesmos valores que no relay: `default` (auto + limiar 1024), `none`, `always`.

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

| Status | Causa                                     | Descricao                                  |
| ------ | ----------------------------------------- | ------------------------------------------ |
| 400    | Body invalido / validacao Zod             | `validateRequest` com `agentCommandBodySchema`; detalhe do schema na resposta |
| 401    | Token ausente ou invalido                 | `requireAuth` rejeitou a autenticacao      |
| 404    | Agente nunca registrado                   | `agentId` desconhecido                     |
| 503    | Agente desconectado / timeout / overload  | Agente offline, nao respondeu a tempo ou fila do agente saturada |

Quando o `503` for causado por overload (fila cheia ou espera em fila expirada),
o servidor inclui:

- Header `Retry-After` (segundos)
- `details.retry_after_ms` no body (ambiente nao-producao)

### Controles de overload REST por agente

| Variavel                              | Default | Descricao |
| ------------------------------------- | ------- | --------- |
| `SOCKET_REST_MAX_PENDING_REQUESTS`    | `10000` | Limite global de requests REST correlacionadas pendentes |
| `SOCKET_REST_AGENT_MAX_INFLIGHT`      | `32`    | Quantas requests simultaneas por `agentId` podem ficar em voo |
| `SOCKET_REST_AGENT_MAX_QUEUE`         | `64`    | Quantas requests adicionais por `agentId` podem esperar fila |
| `SOCKET_REST_AGENT_QUEUE_WAIT_MS`     | `200`   | Tempo maximo de espera na fila por agente antes de rejeitar |
| `SOCKET_AGENT_PROTOCOL_READY_GRACE_MS` | `100`  | Fallback de estabilizacao apos `agent:register`; durante esse periodo o hub rejeita dispatch com `503`/`Retry-After`. `agent:heartbeat` libera antes e agentes com `extensions.protocolReadyAck` podem liberar explicitamente com `agent:ready` |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` | `256`   | Janela base por pull no REST materializado; o hub pode reduzir/clamp pelo que o agente anunciar como recomendado/maximo em capabilities |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_ROWS` | `1000000` | Teto de linhas agregadas (resposta inicial + chunks) na materialização REST; `0` desativa (não recomendado em produção) |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS` | `0` | Teto de frames `rpc:chunk` na materialização; `0` = ilimitado |
| `PAYLOAD_SIGN_OUTBOUND`               | `false` | Quando `true` e `PAYLOAD_SIGNING_KEY` definida, assina frames **emitidos** pelo hub |
| `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES`  | `524288` | JSON UTF-8 maior que este valor nao passa por tentativa de gzip no hub (`cmp: none`); ate **10 MiB** no frame |

---

## Resposta do agente - formato JSON-RPC v2

### sql.execute result

| Campo             | Tipo    | Sempre presente | Descricao                                     |
| ----------------- | ------- | --------------- | --------------------------------------------- |
| `execution_id`    | string  | sim             | ID unico da execucao                          |
| `started_at`      | string  | sim             | Inicio da execucao (ISO-8601)                 |
| `finished_at`     | string  | sim             | Fim da execucao (ISO-8601)                    |
| `rows`            | array   | sim             | Linhas retornadas                             |
| `row_count`       | integer | sim             | Total de linhas retornadas                    |
| `returned_rows`   | integer | nao             | Linhas efetivamente retornadas (paginacao)    |
| `affected_rows`   | integer | nao             | Linhas afetadas (INSERT/UPDATE/DELETE)        |
| `truncated`       | boolean | nao             | True se resultado foi truncado por limite     |
| `column_metadata` | array   | nao             | Metadados das colunas retornadas              |
| `multi_result`    | boolean | nao             | True quando multi-result ativo                |
| `result_set_count`| integer | nao             | Quantidade de result sets (multi-result)      |
| `item_count`      | integer | nao             | Quantidade de items (multi-result)            |
| `result_sets`     | array   | nao             | Array de result sets (multi-result)           |
| `items`           | array   | nao             | Array unificado de result sets e row counts   |
| `pagination`      | object  | nao             | Presente apenas em requests paginadas         |
| `stream_id`       | string  | nao             | Presente quando streaming ativo               |
| `sql_handling_mode` | string | nao           | Modo efetivo usado: `managed` ou `preserve` (v2.5+) |
| `max_rows_handling` | string | nao           | Politica ativa para `max_rows` (ex.: `response_truncation`) (v2.5+) |
| `effective_max_rows` | integer | nao        | Limite efetivo de linhas apos negociacao (min entre solicitado e limite do transporte); util para debug e suporte (schema `rpc.result.sql-execute` no plug_agente) |

### sql.execute pagination

Objeto presente quando a requisicao inclui `page`+`page_size` ou `cursor`. A requisicao paginada deve usar SQL com **`ORDER BY` explicito** (ver regras em `command.params.options`).

| Campo               | Tipo    | Descricao                           |
| ------------------- | ------- | ----------------------------------- |
| `page`              | integer | Pagina atual                        |
| `page_size`         | integer | Tamanho da pagina                   |
| `returned_rows`     | integer | Linhas retornadas nesta pagina      |
| `has_next_page`     | boolean | Se existe proxima pagina            |
| `has_previous_page` | boolean | Se existe pagina anterior           |
| `current_cursor`    | string  | Cursor da pagina atual (opcional)   |
| `next_cursor`       | string  | Cursor para proxima pagina (quando cursor ativo) |

### sql.executeBatch result

| Campo                 | Tipo    | Sempre presente | Descricao                          |
| --------------------- | ------- | --------------- | ---------------------------------- |
| `execution_id`        | string  | sim             | ID unico do batch                  |
| `started_at`          | string  | sim             | Inicio (ISO-8601)                  |
| `finished_at`         | string  | sim             | Fim (ISO-8601)                     |
| `items`               | array   | sim             | Resultado de cada comando          |
| `total_commands`      | integer | sim             | Total de comandos no batch         |
| `successful_commands` | integer | sim             | Comandos que tiveram sucesso       |
| `failed_commands`     | integer | sim             | Comandos que falharam              |

### sql.executeBatch items[]

| Campo             | Tipo    | Descricao                               |
| ----------------- | ------- | --------------------------------------- |
| `index`           | integer | Indice do comando no array original     |
| `ok`              | boolean | Se o comando foi executado com sucesso  |
| `rows`            | array   | Linhas retornadas                       |
| `row_count`       | integer | Total de linhas                         |
| `affected_rows`   | integer | Linhas afetadas                         |
| `error`           | string  | Mensagem de erro quando `ok: false`     |
| `column_metadata` | array   | Metadados das colunas                   |

### sql.cancel result

| Campo          | Tipo    | Descricao                      |
| -------------- | ------- | ------------------------------ |
| `cancelled`    | boolean | Se o cancelamento foi aceito   |
| `execution_id` | string  | ID da execucao cancelada       |
| `request_id`   | string  | ID do request cancelado        |

### Formato de erro RPC

Quando o agente retorna erro, `response.item.error` segue:

| Campo                 | Tipo    | Obrigatorio | Descricao                                |
| --------------------- | ------- | ----------- | ---------------------------------------- |
| `code`                | integer | sim         | Codigo de erro JSON-RPC                  |
| `message`             | string  | sim         | Mensagem do erro                         |
| `data.reason`         | string  | sim         | Identificador estavel do motivo          |
| `data.category`       | string  | sim         | Classe do erro para roteamento           |
| `data.retryable`      | boolean | sim         | Se retry automatico faz sentido          |
| `data.user_message`   | string  | sim         | Mensagem amigavel para UI                |
| `data.technical_message` | string | sim      | Detalhe tecnico para logs                |
| `data.correlation_id` | string  | sim         | ID para correlacao de logs               |
| `data.timestamp`      | string  | sim         | Instante UTC (ISO-8601)                  |

---

## Catalogo de erros RPC

### JSON-RPC padrao

| Codigo   | Descricao        | `reason`            |
| -------- | ---------------- | ------------------- |
| `-32700` | Parse error      | `json_parse_error`  |
| `-32600` | Invalid request  | `invalid_request`   |
| `-32601` | Method not found | `method_not_found`  |
| `-32602` | Invalid params   | `invalid_params`    |
| `-32603` | Internal error   | `internal_error`    |

### Transporte

| Codigo   | Descricao           | `reason`             | `retryable` |
| -------- | ------------------- | -------------------- | ----------- |
| `-32001` | Authentication      | `authentication_failed` / `missing_client_token` | false |
| `-32002` | Unauthorized        | `unauthorized` / `token_revoked`                 | false |
| `-32008` | Timeout             | `timeout`            | true        |
| `-32009` | Invalid payload     | `invalid_payload`    | false       |
| `-32010` | Decoding failed     | `decoding_failed`    | false       |
| `-32011` | Compression failed  | `compression_failed` | false       |
| `-32012` | Network error       | `network_error`      | true        |
| `-32013` | Rate limit          | `rate_limited`       | false       |
| `-32014` | Replay detected     | `replay_detected`    | false       |

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

A tabela abaixo compara os recursos disponiveis no protocolo Socket.IO do agente
com o que a API REST atualmente expoe ao consumer.

### Recursos disponiveis no agente vs cobertura REST

| Recurso do agente                          | Socket status | REST status     | Gap                                      |
| ------------------------------------------ | ------------- | --------------- | ---------------------------------------- |
| `sql.execute`                              | implementado  | exposto         | -                                        |
| `sql.executeBatch`                         | implementado  | exposto         | -                                        |
| `sql.cancel`                               | implementado  | exposto         | -                                        |
| `rpc.discover`                             | implementado  | exposto         | -                                        |
| PayloadFrame encode/decode                 | implementado  | transparente    | -                                        |
| Compressao GZIP (modo **auto** por defeito; `payloadFrameCompression`) | implementado  | transparente    | cliente escolhe `default` / `none` / `always` no body REST ou envelope relay |
| Assinatura de payload (HMAC-SHA256)        | implementado  | opcional saida  | verificacao de frames **do** agente quando assinados; assinatura **de saida** do hub com `PAYLOAD_SIGN_OUTBOUND=true` e `PAYLOAD_SIGNING_KEY` |
| Token carrier (client_token/clientToken/auth) | implementado | validado     | -                                        |
| Paginacao (page/page_size)                 | implementado  | exposto         | -                                        |
| Paginacao (cursor keyset)                  | implementado  | exposto         | -                                        |
| `multi_result` (multiplos result sets)     | implementado  | validado        | -                                        |
| `idempotency_key`                          | implementado  | validado        | -                                        |
| `database` (override DSN)                  | implementado  | validado        | -                                        |
| `options.timeout_ms` / `options.max_rows`  | implementado  | validado        | -                                        |
| `options.execution_mode` (managed/preserve) | implementado  | validado        | -                                        |
| `options.preserve_sql` (alias legado)       | implementado  | validado        | -                                        |
| `options.transaction` (batch)               | implementado  | validado        | -                                        |
| `api_version` no request                   | implementado  | exposto         | hub **preserva** `api_version` enviado pelo cliente; se ausente, usa `"2.5"`; merge de `meta` |
| `meta` no request (trace_id, traceparent)  | implementado  | exposto         | hub faz merge preservando traceparent/tracestate; injeta request_id, agent_id, timestamp, trace_id |
| `meta.outbound_compression` (`none` / `gzip` / `auto`) | implementado  | validado + OpenAPI | alinhado a `plug_agente` `rpc.request.schema.json`; influencia compressao agente→hub no `PayloadFrame` da resposta (e stream); em batch JSON-RPC todos os itens que definirem o campo devem usar o mesmo valor (regra do agente) |
| `api_version` na response                  | implementado  | exposto         | serializer preserva `api_version` e `meta` do agente |
| `meta` na response (agent_id, timestamp)   | implementado  | exposto         | serializer preserva `meta` do agente     |
| Batch max 32 itens                         | implementado  | validado        | servidor rejeita batches > 32 com 400    |
| Capacidade de pendencias REST              | implementado  | validado        | limite global (`SOCKET_REST_MAX_PENDING_REQUESTS`) + limite/fila por agente (`SOCKET_REST_AGENT_MAX_INFLIGHT`, `SOCKET_REST_AGENT_MAX_QUEUE`, `SOCKET_REST_AGENT_QUEUE_WAIT_MS`) com `Retry-After` em overload |
| Streaming chunked (`rpc:chunk`/`rpc:complete`) | implementado | **materializado** | REST (`sql.execute` unico): hub faz pull interno, agrega linhas e devolve **uma** resposta HTTP (sem streaming progressivo). Socket /consumers continua com eventos em tempo real |
| Backpressure (`rpc:stream.pull`)           | implementado  | **interno**     | REST nao expoe pull ao cliente; o hub emite `rpc:stream.pull` com janela base em `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`, ajustada por capabilities quando o agente anunciar recomendacao/limite. Controle fino permanece no Socket (`agents:stream_pull` / relay) |
| Delivery guarantee (`rpc:request_ack`)     | implementado  | exposto         | hub registra ack e marca `acked` no pending request |
| Batch ack (`rpc:batch_ack`)                | implementado  | exposto         | hub registra acks para cada request_id do batch |
| Notification JSON-RPC (`id: null`)       | implementado  | exposto         | `id` omitido recebe UUID automatico (200); somente `id: null` em todos os itens retorna 202 |
| Falha rapida em disconnect do agente       | implementado  | exposto         | pending requests REST do socket desconectado sao encerradas com 503 sem aguardar timeout |
| Heartbeat (`agent:heartbeat`)              | implementado  | transparente    | -                                        |
| Capabilities negotiation                   | implementado  | transparente    | -                                        |

### Detalhe dos gaps

#### Gaps cobertos (implementados)

**1. `api_version` e `meta` no request** -- O bridge define `api_version` como a
string enviada pelo cliente quando presente; caso contrario usa `"2.5"`. Injeta
`meta` com `request_id`, `agent_id`, `timestamp` e `trace_id` antes de emitir
`rpc:request`. O `meta` enviado pelo cliente (ex.: `traceparent`, `tracestate`) e
preservado via merge; campos obrigatorios sao sobrescritos. O `trace_id` e unico
e compartilhado entre o payload logico e o `PayloadFrame` para correlacao.

**2. `api_version` e `meta` na response** -- O serializer preserva `api_version`
e `meta` do agente e propaga para o nivel da response HTTP em respostas single.

**3. Batch max 32** -- O validator rejeita batches com mais de 32 comandos
com mensagem `"Batch cannot exceed 32 commands"` (400).

**4. Delivery guarantee acks** -- O hub registra handlers para `rpc:request_ack`
e `rpc:batch_ack`, marcando `acked: true` no pending request. No sentido
agente → hub, apos processar cada `rpc:response` (PayloadFrame valido ou falha de
decode), o hub invoca o **Socket.IO acknowledgment** quando o cliente usa
`emitWithAck` / `emitWithAckAsync` nesse evento (compativel com
`enableSocketDeliveryGuarantees` no plug_agente). Logs estruturados sao emitidos:
`rpc_ack_received`, `rpc_batch_ack_received`, `rpc_response_received_without_ack` e
`rpc_timeout_without_ack` para observabilidade.

**5. Notification JSON-RPC** -- `id: null` e notification: o bridge nao cria pending
para esse item. Se **todos** os itens forem notifications (`id: null`), a rota retorna
HTTP `202 Accepted` com `notification: true`. Se `id` for **omitido**, o servidor
atribui UUID antes do envio ao agente e aguarda `rpc:response` (200). Em batch misto,
itens com `id: null` nao entram na correlacao; os demais (id omitido ou string/number)
sim.

**6. Overload por agente + `Retry-After`** -- Alem do limite global de
pendencias REST, o bridge aplica limite de inflight/fila por `agentId`. Quando
a fila esta cheia (ou expira o tempo de espera), o endpoint retorna `503` com
`Retry-After` e `details.retry_after_ms` (em nao-producao).

**7. Cancelamento por abort do cliente HTTP** -- Se o cliente aborta a conexao
antes da resposta do agente, o bridge remove imediatamente a pending request e
encerra o fluxo sem manter correlacao pendurada.

**8. Observabilidade de frames malformados** -- Falhas de decode de
`PayloadFrame` sao contabilizadas em metrica dedicada e logs amostrados
(`rpc_frame_decode_failed`) para reduzir ruido sob flood de payload invalido.

#### Limitacoes documentadas (nao implementadas)

**1. Streaming via REST** -- Nao ha entrega **progressiva** por HTTP (sem SSE nem
chunked JSON). Para `sql.execute` **unico** sem handlers de stream do consumer, o hub
**materializa** o resultado: modelo de **creditos** por janela (como o relay), novo
`rpc:stream.pull` so quando a janela se esgota, acumula `rpc:chunk` e fecha com
`rpc:complete`, devolvendo um unico JSON com todas as `rows` (e `total_rows`).
O tamanho da janela parte de `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`, mas pode ser
clampado por capabilities do agente. Quando o `rpc:complete` chega com
`terminal_status`, ou quando `rpc:chunk` / `rpc:complete` chegam com frame invalido
e `requestId` identificavel, o hub encerra o REST com erro `503` para nao mascarar
stream anomalo como sucesso nem esperar apenas por timeout.
Metrica Prometheus: `plug_rest_sql_stream_materialize_pulls_total`.
Batch, relay e notificacoes nao usam esse caminho.

**2. Frame de resposta invalido do agente** -- Se `rpc:response` chegar com
`PayloadFrame` malformado, JSON invalido ou assinatura invalida, o hub tenta
correlacionar pelo `requestId` do envelope e **falha imediatamente** a request
pendente (REST `503`; relay com erro JSON-RPC framed), em vez de aguardar ate
timeout.

No canal Socket `/consumers`, o hub continua encaminhando `rpc:chunk` e `rpc:complete`
em tempo real (`agents:command_stream_*`) e aceita `agents:stream_pull`.

No modo relay (`relay:*`), o hub tambem encaminha `rpc:response`, `rpc:chunk`,
`rpc:complete`, `rpc:request_ack`, `rpc:batch_ack` e `rpc:stream.pull` com
isolamento por `conversationId`.

## Checklist final de gaps REST (intencionais)

- [ ] **Streaming em tempo real no endpoint REST** (`rpc:chunk` / `rpc:complete` ao vivo):
  fora do escopo; usar Socket `/consumers`. REST agrega resultado final apos pull interno.
- [x] **Pull explicito pelo cliente HTTP** (`rpc:stream.pull`): nao exposto; o servidor puxa
  automaticamente para materializar `sql.execute` unico.
- [ ] **Coordenacao de estado pendente entre replicas HTTP sem afinidade**:
  arquitetura atual usa estado em memoria para correlacao (sem Redis/sticky),
  logo o caminho recomendado segue single-instance ou afinidade de sessao quando
  houver multiplas replicas.

---

## Configuracao e tuning

Guia agregado (Socket.IO, REST vs streaming, escala): `docs/performance_hub_agent.md`.

### Traces de latencia do bridge (`BRIDGE_LATENCY_TRACE_*`)

Para persistir tempos por fase (transformacao, fila, dispatch, escrita HTTP, etc.) em PostgreSQL para `POST /api/v1/agents/commands`, `agents:command` no `/consumers` e `relay:rpc.request`, ative `BRIDGE_LATENCY_TRACE_ENABLED=true`. Amostragem, lote, limiar de comandos lentos, fila em memoria, retenção/prune e spans OpenTelemetry estao em `.env.example` (`BRIDGE_LATENCY_TRACE_*`). Esquema da tabela, chaves de `phases_ms`, regras de amostragem (ex.: erros sempre) e metricas `plug_bridge_latency_trace_*`: `docs/observability.md`.

### REQUEST_BODY_LIMIT e tamanho de payload

O Express limita o body das requisicoes via `REQUEST_BODY_LIMIT` (default: `1mb`).
O PayloadFrame interno suporta ate 10MB (compressao e decodificacao).

Para comandos com `params.params` grandes (ex.: muitos parametros ou valores longos),
aumente o limite:

```bash
REQUEST_BODY_LIMIT=2mb   # ou 5mb conforme necessidade
```

O valor deve ser menor ou igual ao limite do PayloadFrame (10MB).

### Rate limit do endpoint commands

O endpoint `POST /api/v1/agents/commands` possui rate limit proprio, alem do global:

| Variavel | Default | Descricao |
| -------- | ------- | --------- |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` | 60000 | Janela em ms (1 min) |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` | 100 | Max requests por janela por **utilizador** (JWT `sub`) |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX` | `0` (desligado) | Opcional: max por **IP** na mesma janela. `> 0` ativa um segundo limitador (ex.: `300` em NAT). Atras de proxy, configurar `trust proxy` no Express para `req.ip` correto. |

Ajuste conforme capacidade dos agentes e padrao de uso.

**Nota (Socket):** o evento `agents:command` no `/consumers` usa o **mesmo** body e validacao e um
rate limit **por Socket** com os **mesmos** `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` e
`REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` por JWT `sub` (contador separado do Express). Relay: `SOCKET_RELAY_RATE_LIMIT_*`.
Ver `docs/socket_client_sdk.md`.

### Log de `id` JSON-RPC auto-atribuido

Quando o hub gera UUID para `id` omitido (`ensureJsonRpcIdsForBridge`), pode registrar um evento
estruturado para suporte:

| Variavel | Default | Descricao |
| -------- | ------- | --------- |
| `BRIDGE_LOG_JSONRPC_AUTO_ID` | `false` | Se `true`, emite **INFO** `bridge_jsonrpc_id_assigned` com `method`, `assigned_id` e opcionalmente `batch_index`. |

Em `NODE_ENV=development`, o mesmo evento e emitido em nivel **DEBUG** (via `console.debug`) sem
precisar da variavel — util para depuracao local sem poluir producao.

### Variaveis de ambiente do relay (tuning)

Para cenarios de alto volume ou muitos consumers, considere:

| Variavel | Default | Cenario | Sugestao |
| -------- | ------- | ------- | -------- |
| `SOCKET_RELAY_MAX_PENDING_REQUESTS` | 10000 | Muitos consumers | Aumentar se houver capacidade |
| `SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONSUMER` | 128 | Consumer com muitas requests | Ajustar por perfil |
| `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS` | 64 | Janela 10s (fixa) | Aumentar para workloads intensos |
| `SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER` | 3 | Limpeza de estado | Multiplicador sobre `RATE_LIMIT_WINDOW_MS` para considerar estado stale |
| `SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS` | 120000 | Limpeza de idempotencia | Intervalo do timer em background (menos CPU que intervalos muito curtos) |

Acks de alto volume (`rpc:request_ack`, `rpc:batch_ack`, registro de stream) sao logados em nivel
**DEBUG** (visivel em `NODE_ENV=development`); use metricas Prometheus para paineis em producao.

### Auditoria Socket (batch insert)

| Variavel | Default | Descricao |
| -------- | ------- | --------- |
| `SOCKET_AUDIT_BATCH_MAX` | `48` | `1` = um `INSERT` por evento. Default maior agrupa eventos na fila e grava em transacao (flush por tamanho ou tempo). |
| `SOCKET_AUDIT_BATCH_FLUSH_MS` | `200` | Debounce do flush quando a fila nao atingiu `SOCKET_AUDIT_BATCH_MAX`. |

No shutdown HTTP, `flushPendingSocketAuditEvents()` drena a fila antes de `waitForSocketAuditDrain`.
Metrica: `plug_socket_audit_queued_events`.

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
(secao *Roadmap tecnico*).

## Mapa de arquivos relevantes

| Arquivo                                                            | Papel                                  |
| ------------------------------------------------------------------ | -------------------------------------- |
| `src/presentation/http/routes/agents.routes.ts`                   | Definicao da rota e Swagger            |
| `src/presentation/http/validators/agents.validator.ts`            | Reexporta schemas de `shared/validators/agent_command` |
| `src/presentation/http/controllers/agents.controller.ts`          | Controller: chama executeAgentCommand  |
| `src/presentation/http/serializers/agent_rpc_response.serializer.ts` | Normalizacao da resposta do agente  |
| `src/presentation/socket/hub/rpc_bridge.ts`                      | Bridge: emit rpc:request no namespace /agents |
| `src/presentation/socket/hub/rest_sql_stream_materialize.ts`     | Creditos + estado do stream REST materializado (`sql.execute`) |
| `src/presentation/socket/hub/rest_agent_dispatch_queue.ts`       | Fila + inflight por `agentId` no bridge REST (`SOCKET_REST_AGENT_*`) |
| `src/presentation/socket/hub/rest_pending_requests.ts`         | Mapa correlation id -> `PendingRequest`, capacidade `SOCKET_REST_MAX_PENDING_REQUESTS` |
| `src/presentation/socket/hub/relay_idempotency_store.ts`       | Idempotencia relay (`client_request_id` por conversa), TTL e timer de limpeza |
| `src/presentation/socket/hub/relay_stream_flow_state.ts`       | Estado de backpressure do stream relay (creditos, fila de chunks, complete pendente) |
| `src/presentation/socket/hub/relay_request_registry.ts`        | Registo de `RelayRequestRoute`, limites `SOCKET_RELAY_MAX_PENDING_*`, cleanup por conversa/socket |
| `src/presentation/socket/hub/bridge_relay_health_metrics.ts`   | Circuit por agente, latencia, `relayMetrics`, snapshot Prometheus (via `rpc_bridge.getRelayMetricsSnapshot`) |
| `src/presentation/socket/hub/active_stream_registry.ts`        | Rotas `ActiveStreamRoute` (legacy + relay), limite `SOCKET_RELAY_MAX_ACTIVE_STREAMS` (gauge) |
| `src/presentation/socket/hub/rpc_bridge_command_helpers.ts`  | Helpers puros: ids de resposta/correlation, `withBridgeMeta`, `api_version`, `stream_id` em resultados |
| `src/presentation/socket/hub/rpc_bridge_relay_stream.ts`      | Stream relay: `createRelayStreamHandlers`, `emitRelayTimeoutResponse` (backpressure + idempotencia no timeout) |
| `src/presentation/socket/hub/rpc_bridge_agent_inbound.ts`   | Handlers de entrada do agente: `createRpcBridgeAgentInboundHandlers` → `handleAgentRpc*` (reexportados em `rpc_bridge.ts`) |
| `src/presentation/socket/hub/rpc_bridge_stream_pull.ts`    | `createRequestAgentStreamPull` — pull de stream (legacy + creditos relay apos emit ao agente) |
| `src/presentation/socket/hub/rpc_bridge_dispatch_relay.ts` | `createRpcBridgeRelayDispatch` — `dispatchRelayRpcToAgent`, `requestRelayStreamPull` |
| `src/presentation/socket/hub/rpc_bridge_dispatch_command.ts` | `createDispatchRpcCommandToAgent` — `dispatchRpcCommandToAgent` (HTTP + `agents:command`) |
| `src/presentation/socket/hub/rpc_bridge_lifecycle.ts`       | Cleanup por socket/conversa, `resetRpcBridgeMutableStores` (reexport cleanup via `rpc_bridge.ts`) |
| `src/application/agent_commands/merge_sql_stream_rpc_response.ts` | Junta `rpc:response` inicial + chunks + `rpc:complete` em uma resposta JSON-RPC |
| `src/presentation/socket/hub/agent_registry.ts`                  | Registry de agentes conectados         |
| `src/presentation/socket/consumers/agents_command.handler.ts`   | Handler Socket para agents:command no /consumers |
| `src/presentation/socket/consumers/agents_stream_pull.handler.ts` | Handler Socket para agents:stream_pull no /consumers |
| `src/presentation/socket/consumers/relay_conversation_start.handler.ts` | Handler Socket relay:conversation.start |
| `src/presentation/socket/consumers/relay_conversation_end.handler.ts` | Handler Socket relay:conversation.end |
| `src/presentation/socket/consumers/relay_rpc_request.handler.ts` | Handler Socket relay:rpc.request |
| `src/presentation/socket/consumers/relay_rpc_stream_pull.handler.ts` | Handler Socket relay:rpc.stream.pull |
| `src/presentation/socket/hub/conversation_registry.ts`           | Registry de conversas relay por socket/agent |
| `src/presentation/socket/hub/consumer_relay_rate_limiter.ts`    | Rate-limit por consumer para relay |
| `src/application/agent_commands/execute_agent_command.ts`        | Caso de uso compartilhado HTTP + Socket |
| `src/application/agent_commands/command_transformers.ts`         | Paginacao, `preserve_sql`, `ensureJsonRpcIdsForBridge` |
| `src/application/services/socket_audit.service.ts`               | Auditoria Socket (INSERT simples ou em lote), retencao, flush no shutdown |
| `src/presentation/http/controllers/metrics.controller.ts`        | Endpoint `/metrics` (Prometheus text) |
| `src/shared/validators/agent_command.ts`                         | Schemas transport-agnosticos          |
| `src/shared/utils/payload_frame.ts`                               | Encode/decode PayloadFrame; preencode para batch ack |
| `src/shared/utils/percentile.ts`                                  | Percentil quickselect (metricas)        |
| `src/shared/utils/latency_ring_buffer.ts`                         | Buffer circular de amostras de latencia |
| `src/shared/utils/rpc_types.ts`                                   | isRecord, toRequestId, toJsonRpcId      |
| `src/shared/constants/socket_events.ts`                           | Nomes dos eventos e namespaces         |
| `src/socket.ts`                                                    | Bootstrap: namespaces /agents e /consumers |
