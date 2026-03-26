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

## Falhas comuns

- conectar ao namespace `/` em vez de `/agents`
- usar token de utilizador comum em vez de token de agente
- `agentId` do token diferente do `agentId` enviado em `agent:register`
- enviar RPC antes de o protocolo ficar pronto

## Leituras relacionadas

- `docs/PROJECT_OVERVIEW.md`
- `docs/api_rest_bridge.md`
- `docs/socket_relay_protocol.md`
