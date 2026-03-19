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
6. Bridge aguarda `rpc:response` (com timeout).
7. Serializer normaliza a resposta JSON-RPC para formato HTTP.
8. Controller retorna `200` com a resposta normalizada.

## Autenticacao

| Header          | Obrigatorio | Descricao                                  |
| --------------- | ----------- | ------------------------------------------ |
| `Authorization` | sim         | `Bearer <access_token>` emitido pelo login |

O token e validado por `requireAuth` antes de qualquer processamento.

## Request body

### Campos de primeiro nivel

| Campo        | Tipo   | Obrigatorio | Restricoes         | Descricao                                      |
| ------------ | ------ | ----------- | ------------------ | ---------------------------------------------- |
| `agentId`    | string | sim         | nao vazio          | UUID do agente conectado                        |
| `command`    | object \| array | sim | JSON-RPC 2.0       | Comando unico ou batch JSON-RPC (max 32)         |
| `timeoutMs`  | number | nao         | 1..60000           | Timeout em ms para aguardar resposta do agente  |
| `pagination` | object | nao         | regras combinadas  | Paginacao injetada em `command.params.options`   |

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

Sem `id` (ou com `id: null`), o item e tratado como **notification**:
o servidor encaminha ao agente, mas nao aguarda `rpc:response`. Quando todos os
itens do payload sao notifications, a rota retorna HTTP `202 Accepted`.

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
- IDs devem ser unicos (desconsiderando notifications).
- Itens sem `id` (ou `id: null`) sao notifications e nao geram item na response.
- Batch com pelo menos um item com `id` retorna HTTP 200 com `response.type = "batch"`.
- Batch somente com notifications retorna HTTP 202.

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

### sql.execute com `api_version` e `meta`

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
      "tracestate": "vendor=value"
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

Quando o payload contem apenas notifications (todos os itens sem `id` ou com
`id: null`), o bridge nao aguarda `rpc:response` e retorna:

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
| 400    | Body invalido / validacao falhou          | `validateRequest` rejeitou o payload       |
| 401    | Token ausente ou invalido                 | `requireAuth` rejeitou a autenticacao      |
| 404    | Agente nunca registrado                   | `agentId` desconhecido                     |
| 400    | Erro de validacao Zod                     | Schema mismatch detalhado                  |
| 503    | Agente desconectado / timeout / overload  | Agente offline, nao respondeu a tempo ou fila do agente saturada |

Quando o `503` for causado por overload (fila cheia ou espera em fila expirada),
o servidor inclui:

- Header `Retry-After` (segundos)
- `details.retry_after_ms` no body (ambiente nao-producao)

### Controles de overload REST por agente

| Variavel                              | Default | Descricao |
| ------------------------------------- | ------- | --------- |
| `SOCKET_REST_MAX_PENDING_REQUESTS`    | `10000` | Limite global de requests REST correlacionadas pendentes |
| `SOCKET_REST_AGENT_MAX_INFLIGHT`      | `8`     | Quantas requests simultaneas por `agentId` podem ficar em voo |
| `SOCKET_REST_AGENT_MAX_QUEUE`         | `16`    | Quantas requests adicionais por `agentId` podem esperar fila |
| `SOCKET_REST_AGENT_QUEUE_WAIT_MS`     | `150`   | Tempo maximo de espera na fila por agente antes de rejeitar |

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
| Compressao GZIP + fallback none            | implementado  | transparente    | -                                        |
| Assinatura de payload (HMAC-SHA256)        | implementado  | transparente    | -                                        |
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
| `api_version` no request                   | implementado  | exposto         | hub injeta `api_version: "2.5"` e faz merge de `meta` |
| `meta` no request (trace_id, traceparent)  | implementado  | exposto         | hub faz merge preservando traceparent/tracestate; injeta request_id, agent_id, timestamp, trace_id |
| `api_version` na response                  | implementado  | exposto         | serializer preserva `api_version` e `meta` do agente |
| `meta` na response (agent_id, timestamp)   | implementado  | exposto         | serializer preserva `meta` do agente     |
| Batch max 32 itens                         | implementado  | validado        | servidor rejeita batches > 32 com 400    |
| Capacidade de pendencias REST              | implementado  | validado        | limite global (`SOCKET_REST_MAX_PENDING_REQUESTS`) + limite/fila por agente (`SOCKET_REST_AGENT_MAX_INFLIGHT`, `SOCKET_REST_AGENT_MAX_QUEUE`, `SOCKET_REST_AGENT_QUEUE_WAIT_MS`) com `Retry-After` em overload |
| Streaming chunked (`rpc:chunk`/`rpc:complete`) | implementado | **nao suportado** | na rota REST nao ha repasse de chunks; no Socket /consumers ha repasse via legado (`agents:command_stream_chunk`) e relay (`relay:rpc.chunk`) |
| Backpressure (`rpc:stream.pull`)           | implementado  | **nao suportado** | na rota REST nao existe pull; no Socket /consumers existe legado (`agents:stream_pull`) e relay (`relay:rpc.stream.pull`) |
| Delivery guarantee (`rpc:request_ack`)     | implementado  | exposto         | hub registra ack e marca `acked` no pending request |
| Batch ack (`rpc:batch_ack`)                | implementado  | exposto         | hub registra acks para cada request_id do batch |
| Notification JSON-RPC (request sem `id`)   | implementado  | exposto         | payload somente notification retorna 202 e nao aguarda response |
| Falha rapida em disconnect do agente       | implementado  | exposto         | pending requests REST do socket desconectado sao encerradas com 503 sem aguardar timeout |
| Heartbeat (`agent:heartbeat`)              | implementado  | transparente    | -                                        |
| Capabilities negotiation                   | implementado  | transparente    | -                                        |

### Detalhe dos gaps

#### Gaps cobertos (implementados)

**1. `api_version` e `meta` no request** -- O bridge injeta `api_version: "2.5"`
e `meta` com `request_id`, `agent_id`, `timestamp` e `trace_id` antes de emitir
`rpc:request`. O `meta` enviado pelo cliente (ex.: `traceparent`, `tracestate`) e
preservado via merge; campos obrigatorios sao sobrescritos. O `trace_id` e unico
e compartilhado entre o payload logico e o `PayloadFrame` para correlacao.

**2. `api_version` e `meta` na response** -- O serializer preserva `api_version`
e `meta` do agente e propaga para o nivel da response HTTP em respostas single.

**3. Batch max 32** -- O validator rejeita batches com mais de 32 comandos
com mensagem `"Batch cannot exceed 32 commands"` (400).

**4. Delivery guarantee acks** -- O hub registra handlers para `rpc:request_ack`
e `rpc:batch_ack`, marcando `acked: true` no pending request. Logs estruturados
sao emitidos: `rpc_ack_received`, `rpc_batch_ack_received`,
`rpc_response_received_without_ack` e `rpc_timeout_without_ack` para
observabilidade.

**5. Notification JSON-RPC** -- Requests sem `id` (ou com `id: null`) sao
tratados como notifications. O bridge nao cria pending request para payloads
somente notification e retorna HTTP `202 Accepted` com `notification: true`.
Em batch misto, apenas itens com `id` participam da correlacao da response.

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

**1. Streaming via REST** -- Os eventos `rpc:chunk`, `rpc:complete` e
`rpc:stream.pull` nao sao expostos no endpoint HTTP `POST /api/v1/agents/commands`.
A rota REST permanece em modo request/response unico. Resultados grandes enviados
via streaming pelo agente nao sao entregues ao cliente HTTP em tempo real.

No canal Socket `/consumers`, o hub ja encaminha `rpc:chunk` e `rpc:complete`
como `agents:command_stream_chunk` e `agents:command_stream_complete`, e aceita
`agents:stream_pull` para emitir `rpc:stream.pull` ao agente.

No modo relay (`relay:*`), o hub tambem encaminha `rpc:response`, `rpc:chunk`,
`rpc:complete`, `rpc:request_ack`, `rpc:batch_ack` e `rpc:stream.pull` com
isolamento por `conversationId`.

## Checklist final de gaps REST (intencionais)

- [ ] **Streaming em tempo real no endpoint REST** (`rpc:chunk` e `rpc:complete`):
  continua fora do escopo REST; suportado no canal Socket (`/consumers`).
- [ ] **Backpressure/pull no endpoint REST** (`rpc:stream.pull`):
  continua fora do escopo REST; suportado no canal Socket (`/consumers`).
- [ ] **Coordenacao de estado pendente entre replicas HTTP sem afinidade**:
  arquitetura atual usa estado em memoria para correlacao (sem Redis/sticky),
  logo o caminho recomendado segue single-instance ou afinidade de sessao quando
  houver multiplas replicas.

---

## Configuracao e tuning

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
| `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` | 100 | Max requests por janela por IP |

Ajuste conforme capacidade dos agentes e padrao de uso.

### Variaveis de ambiente do relay (tuning)

Para cenarios de alto volume ou muitos consumers, considere:

| Variavel | Default | Cenario | Sugestao |
| -------- | ------- | ------- | -------- |
| `SOCKET_RELAY_MAX_PENDING_REQUESTS` | 10000 | Muitos consumers | Aumentar se houver capacidade |
| `SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONSUMER` | 128 | Consumer com muitas requests | Ajustar por perfil |
| `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS` | 40 | Janela 10s | Aumentar para workloads intensos |
| `SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER` | 3 | Limpeza de estado | Multiplicador sobre `RATE_LIMIT_WINDOW_MS` para considerar estado stale |
| `SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS` | 60000 | Limpeza de idempotencia | Intervalo do timer em background |

---

## Mapa de arquivos relevantes

| Arquivo                                                            | Papel                                  |
| ------------------------------------------------------------------ | -------------------------------------- |
| `src/presentation/http/routes/agents.routes.ts`                   | Definicao da rota e Swagger            |
| `src/presentation/http/validators/agents.validator.ts`            | Reexporta schemas de `shared/validators/agent_command` |
| `src/presentation/http/controllers/agents.controller.ts`          | Controller: chama executeAgentCommand  |
| `src/presentation/http/serializers/agent_rpc_response.serializer.ts` | Normalizacao da resposta do agente  |
| `src/presentation/socket/hub/rpc_bridge.ts`                      | Bridge: emit rpc:request no namespace /agents |
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
| `src/application/agent_commands/command_transformers.ts`         | applyPaginationToCommand               |
| `src/application/services/socket_audit.service.ts`               | Auditoria Socket e retencao automatica |
| `src/presentation/http/controllers/metrics.controller.ts`        | Endpoint `/metrics` (Prometheus text) |
| `src/shared/validators/agent_command.ts`                         | Schemas transport-agnosticos          |
| `src/shared/utils/payload_frame.ts`                               | Encode/decode PayloadFrame             |
| `src/shared/utils/rpc_types.ts`                                   | isRecord, toRequestId, toJsonRpcId      |
| `src/shared/constants/socket_events.ts`                           | Nomes dos eventos e namespaces         |
| `src/socket.ts`                                                    | Bootstrap: namespaces /agents e /consumers |
