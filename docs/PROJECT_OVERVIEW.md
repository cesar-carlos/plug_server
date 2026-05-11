# Plug Server - Visao Geral do Projeto

Este e o ponto de entrada da documentacao. Para navegar por escopo, ver
`docs/README.md`.

Para rotas HTTP, use `/api/v1` como prefixo canonico. O servico mantem aliases de
compatibilidade para `/auth/*` (tambem sob `/api/v1/auth/*`). O `GET /metrics`
(Prometheus) responde em `/metrics` na raiz e em `/api/v1/metrics`; em ambos exige
JWT com `role=admin`. A navegacao e os exemplos abaixo priorizam caminhos sob o
prefixo da API. Para schemas detalhados de request/response, consulte o OpenAPI em
`GET /docs` e `GET /docs.json`.

## Objetivo

O `plug_server` e o hub central do ecossistema Plug. Ele conecta `consumers` e
`plug_agente` sem expor o agente diretamente na internet, concentrando:

- autenticacao e autorizacao
- roteamento de comandos
- correlacao entre request e response
- observabilidade, limites e controles operacionais

## Arquitetura em uma frase

O agente liga-se ao namespace `/agents`, o consumer usa REST ou `/consumers`, e
o hub traduz, valida e encaminha o mesmo contrato JSON-RPC entre os dois lados.

## Papeis

### `plug_server`

- expor API HTTP e namespaces Socket.IO
- autenticar usuarios e agentes
- manter o registry de agentes conectados
- negociar capabilities com o agente
- encaminhar comandos e devolver respostas
- aplicar limites, timeouts, auditoria e metricas

### `plug_agente`

- conectar-se ao hub via `/agents`
- autenticar-se no handshake
- anunciar `agent:register`, capabilities e readiness
- executar operacoes locais
- devolver `rpc:response`, `rpc:chunk` e `rpc:complete`
- quando autentica com um `User` e conclui `agent:register`, formaliza automaticamente o ownership desse `Agent` no servidor

### `consumer`

- autenticar-se via HTTP
- enviar comandos por REST ou Socket
- consumir resposta unica ou streaming, conforme o canal escolhido

### `client`

- autenticar-se com principal proprio (`principal_type: "client"`)
- solicitar acesso a agentes por `agentId`, sujeito a aprovacao do `User` owner
- consultar agentes ja aprovados e os respetivos pedidos de acesso

### Governanca do `User` sobre `Client`s

- o `User` lista e consulta seus `Client`s por `/api/v1/me/clients`
- o `User` bloqueia/reativa `Client`s por `/api/v1/me/clients/{clientId}/status`
- o `User` decide pedidos em inbox autenticada (`/api/v1/me/client-access-requests`)
- o `User` lista/revoga acessos por agente em `/api/v1/me/agents/{agentId}/clients`

## Canais de comunicacao

### REST

Entrada principal: `POST /api/v1/agents/commands`.

- bom para integracao simples e sem Socket no consumer
- usa o mesmo fluxo interno de dispatch para o agente
- **nao** expoe streaming progressivo ao cliente HTTP
- quando o agente devolve `stream_id`, o hub materializa o stream e responde com
  um unico JSON

Quando a carga for alta ou o payload for grande/streaming, preferir Socket
(`relay:*`) em vez de escalar apenas limites do canal REST.

Detalhes normativos: `docs/api_rest_bridge.md`.

### Socket em `/consumers`

Existem dois modos:

- `agents:*`: bridge legado em JSON logico
- `relay:*`: modo isolado por conversa, com `PayloadFrame` tambem no consumer

Para **novas integracoes**, prefere `relay:*` quando precisares de streaming em tempo real, carga continua elevada ou idempotencia por conversa (`client_request_id`); o canal `agents:*` continua suportado como legado sem data de remocao anunciada neste documento.

Quando precisas de chunks em tempo real e `stream_pull`, prefere Socket.

Detalhes normativos:

- `docs/socket_relay_protocol.md`
- `docs/socket_client_sdk.md`
- regra de negocio canonica `User`/`Agent`/`Client`: `docs/client_agent_business_rules.md`

### Socket em `/agents`

O agente usa o protocolo do `plug_agente` (perfil `plug-jsonrpc-profile/2.9`) no
namespace `/agents`, incluindo:

| Evento | Direcao | Notas |
| ------ | ------- | ----- |
| `agent:register` | agente -> hub | `PayloadFrame` com `agentId`, `timestamp`, `capabilities` (e `profile` opcional) |
| `agent:register_error` | hub -> agente | **JSON puro** (NAO `PayloadFrame`) com `{ code, reason, message, details? }`. `reason` `transient_failure`/`rate_limited` orienta o agente a reagendar `agent:register`; outros valores indicam reconexao. Ver `docs/migracao_plug_agente_namespaces.md` |
| `agent:session.superseded` | hub -> agente (socket substituido) | **JSON puro** quando `SOCKET_AGENT_SESSION_POLICY=takeover_disconnect_previous`; antecede `disconnect` da sessao antiga |
| `agent:capabilities` | hub -> agente | Inclui `extensions.recommendedStreamPullWindowSize` / `maxStreamPullWindowSize` para calibrar pulls |
| `agent:ready` | agente -> hub | Opcional, quando o agente anuncia `extensions.protocolReadyAck` |
| `agent:heartbeat` | agente -> hub | Periodico; `hub:heartbeat_ack` confirma |
| `rpc:request` / `rpc:response` | bidirecional | Comando JSON-RPC 2.0 em `PayloadFrame` |
| `rpc:request_ack` / `rpc:batch_ack` | agente -> hub | Confirmacao de recebimento; o hub observa/propaga esses acks, mas ainda nao reenvia `rpc:request` automaticamente quando faltam |
| `rpc:chunk` / `rpc:complete` | agente -> hub | Streaming de resultado (`terminal_status: aborted`/`error` em encerramento anormal) |
| `rpc:stream.pull` | hub -> agente | Backpressure (window_size baseado em hints de capabilities) |

## Fluxo resumido

1. O agente autentica-se via `agent-login`, conecta em `/agents` e conclui `agent:register`.
2. O hub negocia capabilities e aguarda readiness.
3. O consumer autentica-se e envia um comando por REST ou `/consumers`.
4. O hub valida o payload, resolve o agente e emite `rpc:request`.
5. O agente responde com resultado unico ou stream.
6. O hub correlaciona a resposta e devolve ao consumer no canal de origem.

### Ownership do agente

- a fonte oficial de ownership continua sendo `AgentIdentity`
- `agent-login` apenas autentica a sessao; o bind oficial nasce em `agent:register`
- o cadastro do agente e sincronizado automaticamente via `agent.getProfile` (com `profile_version` quando o agente expõe; ver regras em `docs/client_agent_business_rules.md`)
- nao existem mais rotas HTTP para vincular ou editar manualmente ownership de agente
- conflitos de ownership continuam a ser rejeitados quando o `agentId` pertence a outro `User`

Regras detalhadas de ownership, aprovacao de `Client`, revogacao e autorizacao
por canal vivem em `docs/client_agent_business_rules.md`. Detalhes de
timing/readiness do fluxo do agente vivem em `docs/api_rest_bridge.md`.

## Seguranca e isolamento

- `/agents` aceita apenas roles configuradas em `SOCKET_AGENT_ROLES`
- `/consumers` aceita roles configuradas em `SOCKET_CONSUMER_ROLES`
- o namespace padrao `/` e rejeitado com `NAMESPACE_DEPRECATED`
- quando o token inclui `agent_id`, o `agent:register` deve corresponder ao
  `agentId` autenticado
- mensagens sao validadas antes do encaminhamento

Migracao de namespaces e login de agente: `docs/migracao_plug_agente_namespaces.md`.

## Estado atual

O projeto ja contem:

- autenticacao HTTP com JWT access e refresh token
- `POST /api/v1/auth/agent-login` para agentes
- ownership automatica de agente no fluxo `agent-login` + `agent:register`
- registry de agentes e negociacao de capabilities
  (`HUB_TRANSPORT_EXTENSIONS.plugProfile = "plug-jsonrpc-profile/2.9"`)
- validacao zod do payload `agent:register` alinhada ao schema do agente, com
  resposta de rejeicao em `agent:register_error` (JSON puro)
- readiness explicito com `agent:ready` e fallback por grace window
- bridge REST `POST /api/v1/agents/commands` com propagacao automatica de
  `Retry-After` quando o agente devolve `-32013` com `retry_after_ms`/`reset_at`
  (ex.: `client_token.getPolicy`, introduzido no perfil 2.7)
- bridge Socket legado `agents:*`
- relay Socket `relay:*` com isolamento por `conversationId`
- streaming, backpressure e `rpc:stream.pull`
  (hints `recommendedStreamPullWindowSize` / `maxStreamPullWindowSize`
  publicados em `agent:capabilities`)
- `PayloadFrame` com gzip e assinatura HMAC-SHA256 opcional, com enforcement de
  `signature.key_id` quando `PAYLOAD_SIGNING_KEY_ID` esta configurado
- auditoria Socket e metricas Prometheus

## Persistencia

O estado operacional do hub continua predominantemente em memoria:

- agentes conectados
- pending requests
- conversas relay e streams ativos
- buffers e quotas temporarias

Persistencia atual relevante:

- eventos de auditoria Socket
- traces de latencia, quando ativados

Implicacoes multi-instancia: `docs/scaling_and_roadmap.md`.

## Leitura recomendada

Mapa rapido da documentacao: `docs/README.md`.

| Tema | Documento |
| ---- | --------- |
| Contrato REST e `agents:*` | `docs/api_rest_bridge.md` |
| Relay Socket e quotas | `docs/socket_relay_protocol.md` |
| Guia minimo para cliente Socket | `docs/socket_client_sdk.md` |
| Defaults e variaveis de ambiente | `docs/configuration.md` |
| Tuning hub ↔ agente | `docs/performance_hub_agent.md` |
| Metricas, tracing e alertas | `docs/observability.md` |
| Estudo de fast-path relay (benchmark-gated) | `docs/relay_fastpath_study.md` |
| E2E, benchmark e carga | `docs/e2e_benchmark_hub_agent.md`, `docs/load_testing.md` |
| Escala horizontal e backlog | `docs/scaling_and_roadmap.md` |
| Alinhamento com o `plug_agente` | `docs/communication_sync_plug_agente.md` |

## Resumo

O `plug_server` nao e apenas uma API REST. Ele e o ponto de orquestracao entre
`consumers` e `plug_agente`, mantendo autenticacao, comunicacao em tempo real,
contratos de transporte e controles operacionais num unico lugar.
