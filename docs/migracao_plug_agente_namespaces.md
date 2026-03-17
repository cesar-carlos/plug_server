# Guia de Migração: plug_agente para Namespaces

Este documento descreve as alterações necessárias para que o **plug_agente** (ou qualquer cliente agente) se integre corretamente ao `plug_server` após a migração para o modelo de namespaces `/agents` e `/consumers`.

**Público-alvo:** Desenvolvedores do projeto plug_agente ou de outros clientes que conectam como agentes ao hub central.

---

## 1. Contexto

O `plug_server` passou a usar namespaces Socket.IO separados:

| Namespace   | Papel     | Roles aceitos (JWT)        |
| ----------- | --------- | -------------------------- |
| `/agents`   | Agentes   | `agent` (e `user` durante migração) |
| `/consumers`| Consumers | `user`, `admin`            |

**Importante:** Conexões no namespace padrão `/` **não recebem** eventos de registro nem comandos RPC. O agente **deve** conectar ao namespace `/agents`.

---

## 2. Resumo das alterações necessárias

| # | Alteração | Obrigatório |
|---|-----------|-------------|
| 1 | Conectar ao namespace `/agents` em vez de `/` | Sim |
| 2 | Obter token via `POST /auth/agent-login` com `agentId` | Recomendado |
| 3 | Enviar token no handshake (auth ou header) | Sim |
| 4 | Enviar `agentId` no payload de `agent:register` igual ao do token | Se token tiver `agent_id` |

---

## 3. Conexão Socket.IO

### 3.1 URL e namespace

A URL de conexão deve incluir o path do namespace `/agents`:

```
wss://hub.example.com/agents
```

**Exemplo (Socket.IO client):**

```javascript
// Correto: namespace /agents
const socket = io("https://hub.example.com/agents", {
  path: "/socket.io",  // se o servidor usar path customizado
  transports: ["websocket"],
  auth: {
    token: accessToken,
  },
});

// Alternativa: usar path na URL base
const socket = io("https://hub.example.com", {
  path: "/socket.io",
  transports: ["websocket"],
  auth: {
    token: accessToken,
  },
});
```

**Nota:** Com Socket.IO, o namespace é o path após o host. Se a URL base for `https://hub.example.com`, use `io("/agents", { ... })` ou inclua `/agents` na URL conforme a documentação do cliente.

### 3.2 Envio do token no handshake

O servidor aceita o token em:

1. **`auth.token`** (objeto de handshake)
2. **Header `Authorization: Bearer <token>`**

Exemplo:

```javascript
const socket = io(serverUrl + "/agents", {
  auth: {
    token: accessToken,
  },
  transports: ["websocket"],
});
```

---

## 4. Autenticação: endpoint agent-login

### 4.1 Endpoints disponíveis

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/v1/auth/agent-login` | Login para agentes (API versionada) |
| POST | `/auth/agent-login` | Login para agentes (compatível com plug_agente) |

### 4.2 Request body

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `email` | string | Sim* | Email do usuário (formato válido) |
| `username` | string | Sim* | Alternativa a `email` — um dos dois é obrigatório |
| `password` | string | Sim | Senha do usuário |
| `agentId` | string | Sim | UUID do agente (deve ser válido) |

\* Pelo menos um entre `email` ou `username` é obrigatório.

### 4.3 Exemplo de request

```json
{
  "email": "agent@example.com",
  "password": "SecurePass123",
  "agentId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Ou com `username` (tratado como email):

```json
{
  "username": "agent@example.com",
  "password": "SecurePass123",
  "agentId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 4.4 Response (200 OK)

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "user-uuid",
    "email": "agent@example.com",
    "role": "agent",
    "agentId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### 4.5 JWT emitido (access token)

O access token contém:

| Claim | Valor | Descrição |
|-------|-------|-----------|
| `sub` | string | ID do usuário |
| `email` | string | Email do usuário |
| `role` | `"agent"` | Role para namespace `/agents` |
| `agent_id` | string | UUID do agente (obrigatório para validação em `agent:register`) |
| `tokenType` | `"access"` | Tipo do token |

### 4.6 Refresh token

O refresh token inclui `agent_id` no payload. Ao chamar `POST /auth/refresh`, o servidor emite novos tokens com `role: agent` e `agent_id` preservados.

---

## 5. Evento agent:register

### 5.1 Formato do payload

O payload deve ser enviado em um **PayloadFrame** (envelope binário com compressão opcional). O `data` interno deve ser um objeto com:

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `agentId` | string | Sim | UUID do agente (não vazio) |
| `capabilities` | object | Sim | Objeto com capacidades anunciadas |

### 5.2 Validação de agent_id

Se o token JWT contiver o claim `agent_id`, o servidor **exige** que o `agentId` enviado em `agent:register` seja **idêntico** ao `agent_id` do token. Caso contrário, o servidor emite erro:

```
agent:register agentId does not match token claim
```

**Recomendação:** Use sempre o endpoint `agent-login` com o `agentId` correto e envie o mesmo `agentId` no `agent:register`.

### 5.3 PayloadFrame (resumo)

O plug_server usa um envelope binário para eventos no namespace `/agents`. Consulte `docs/api_rest_bridge.md` e o código em `src/shared/utils/payload_frame.ts` para detalhes de encode/decode.

Estrutura simplificada:

- `schemaVersion`, `enc`, `cmp`, `contentType`, `originalSize`, `compressedSize`, `payload`
- `payload`: JSON stringificado (e opcionalmente comprimido com GZIP) do objeto `{ agentId, capabilities }`

---

## 6. Fluxo completo recomendado

```
1. Obter credenciais (email, password) e agentId (UUID do agente)
2. POST /auth/agent-login { email, password, agentId }
3. Receber accessToken e refreshToken
4. Conectar Socket.IO ao namespace /agents com auth.token = accessToken
5. Após conexão, emitir agent:register com PayloadFrame { agentId, capabilities }
6. Aguardar agent:capabilities do servidor
7. Manter heartbeat (agent:heartbeat) e responder a rpc:request
8. Quando accessToken expirar, usar refreshToken em POST /auth/refresh
9. Reconectar com o novo accessToken
```

---

## 7. Variáveis de ambiente (plug_server)

Durante a migração, o plug_server pode estar configurado com:

```
SOCKET_AGENT_ROLES=agent,user
```

Isso permite que tokens com `role: user` (obtidos via `/auth/login` antigo) ainda funcionem no namespace `/agents`. **Após a migração completa**, o valor será apenas `agent`:

```
SOCKET_AGENT_ROLES=agent
```

**Recomendação:** Migrar para `agent-login` e `role: agent` o quanto antes.

---

## 8. Checklist de implementação (plug_agente)

- [ ] Alterar URL de conexão para incluir namespace `/agents`
- [ ] Implementar chamada a `POST /auth/agent-login` com `{ email, password, agentId }`
- [ ] Armazenar `accessToken` e `refreshToken` da resposta
- [ ] Enviar `accessToken` no handshake (`auth.token` ou header `Authorization`)
- [ ] Garantir que `agentId` em `agent:register` seja igual ao `agent_id` do token (quando presente)
- [ ] Implementar refresh de token antes da expiração (ou ao reconectar com 401)
- [ ] Testar fluxo completo em ambiente de staging

---

## 9. Erros comuns

| Erro | Causa | Solução |
|------|-------|---------|
| `Role 'user' is not allowed to connect to /agents` | Token com role `user` e `SOCKET_AGENT_ROLES=agent` | Usar `agent-login` para obter token com `role: agent` |
| `agent:register agentId does not match token claim` | `agentId` no payload ≠ `agent_id` no token | Usar o mesmo `agentId` no login e no register |
| `agent:register payload is missing required fields` | Payload sem `agentId` ou `capabilities` | Incluir ambos no PayloadFrame |
| Conexão estabelecida mas sem eventos | Conectando em `/` em vez de `/agents` | Conectar ao namespace `/agents` |

---

## 10. Referências

- `docs/project_overview.md` — Visão geral do ecossistema
- `docs/api_rest_bridge.md` — REST bridge, PayloadFrame e período de compatibilidade
- `src/shared/constants/socket_events.ts` — Nomes dos eventos Socket.IO
- `src/shared/utils/payload_frame.ts` — Encode/decode de PayloadFrame
- `.env.example` — Variáveis `SOCKET_AGENT_ROLES` e `SOCKET_CONSUMER_ROLES`
