# Migracao do `plug_agente` para namespaces

## Objetivo

Padronizar o `plug_agente` para usar o namespace `/agents` e autenticar-se com
token de agente, em vez de reutilizar o namespace padrao `/`.

## Estado esperado

O fluxo alvo no hub e:

1. obter token via `POST /api/v1/auth/agent-login`
2. conectar com `io("/agents")`
3. autenticar no handshake com esse token
4. emitir `agent:register`
5. aguardar `agent:capabilities`
6. emitir `agent:ready` quando anunciar `extensions.protocolReadyAck`

## Endpoints relevantes

- `POST /api/v1/auth/agent-login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`

Payload minimo de login:

```json
{
  "email": "agent@example.com",
  "password": "secret",
  "agentId": "00000000-0000-0000-0000-000000000000"
}
```

## Compatibilidade temporaria

Durante migracoes graduais, o hub pode aceitar:

- namespace `/agents`
- `SOCKET_AGENT_ROLES=agent,user`

Isto deve ser tratado como fase temporaria. O estado final recomendado e:

- apenas `/agents`
- apenas `role: agent` em `SOCKET_AGENT_ROLES`

## Ordem de rollout recomendada

1. Deploy do `plug_server` com compatibilidade temporaria, se necessario.
2. Atualizar o `plug_agente` para conectar a `/agents`.
3. Migrar autenticacao do agente para `POST /api/v1/auth/agent-login`.
4. Validar `agent:register`, `agent:capabilities` e `agent:ready`.
5. Remover `user` de `SOCKET_AGENT_ROLES`.

## Falhas comuns e respostas do hub

Toda rejeicao do `agent:register` chega no agente pelo evento dedicado
**`agent:register_error`** em **JSON puro** (sem `PayloadFrame`) com a forma
`{ code, reason, message }`. O agente usa `reason` para decidir reagendar ou
forcar reconexao.

| Falha | `reason` | Codigo | Estrategia recomendada no agente |
| ----- | -------- | ------ | -------------------------------- |
| Conectar em `/` em vez de `/agents` | (handshake) | (`app:error` legado) | reconectar usando `/agents` |
| Token sem `agent_id` ou role nao permitida | `authentication_failed` | `-32001` | renovar credencial/agent-login e reconectar |
| `agentId` do token != `agentId` em `agent:register` | `authentication_failed` | `-32001` | reconectar com agent-login correto |
| `agentId` ja pertence a outro `User` (`AGENT_ALREADY_LINKED`) | `unauthorized` | `-32002` | reconectar com credencial do owner correto, nao retentar |
| Payload nao decodifica (`PayloadFrame` invalido) | `invalid_payload` | `-32009` | corrigir encoder/signature e reconectar |
| Schema zod do `agent:register` falhou (capabilities mal formados, etc.) | `invalid_request` | `-32600` | corrigir payload e reconectar |
| Falha temporaria do hub | `transient_failure` | `-32603` | **reagendar** novo `agent:register` apos backoff |
| Rejeicao por taxa | `rate_limited` | `-32013` | **reagendar** apos `Retry-After`/backoff |
| Erro nao categorizado | `internal_error` | `-32603` | reagendar com backoff conservador |

Enviar RPC antes do protocolo ficar pronto continua a ser rejeitado pelo hub
com `-32600` (`protocol_not_ready`); o agente deve esperar
`agent:capabilities` e (quando anuncia `extensions.protocolReadyAck`)
emitir `agent:ready` antes do primeiro `rpc:request`.

## Leituras relacionadas

- `docs/PROJECT_OVERVIEW.md`
- `docs/api_rest_bridge.md` (secao *Falhas de `agent:register` ate o ownership ser criado*)
- `docs/socket_relay_protocol.md`
- `docs/configuration.md` (secao *Validacao de `agent:register`*)
