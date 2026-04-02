# Plug Server - Visao Geral do Projeto

Este e o ponto de entrada da documentacao. Para navegar por escopo, ver
`docs/README.md`.

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

Quando precisas de chunks em tempo real e `stream_pull`, prefere Socket.

Detalhes normativos:

- `docs/socket_relay_protocol.md`
- `docs/socket_client_sdk.md`
- regra de negocio canonica `User`/`Agent`/`Client`: `docs/client_agent_business_rules.md`

### Socket em `/agents`

O agente usa o protocolo do `plug_agente` no namespace `/agents`, incluindo:

- `agent:register`
- `agent:capabilities`
- `agent:ready`
- `agent:heartbeat`
- `rpc:request`
- `rpc:response`
- `rpc:request_ack`
- `rpc:batch_ack`
- `rpc:chunk`
- `rpc:complete`
- `rpc:stream.pull`

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
- o cadastro do agente e sincronizado automaticamente via `agent.getProfile`
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
- readiness explicito com `agent:ready` e fallback por grace window
- bridge REST `POST /api/v1/agents/commands`
- bridge Socket legado `agents:*`
- relay Socket `relay:*` com isolamento por `conversationId`
- streaming, backpressure e `rpc:stream.pull`
- `PayloadFrame` com gzip e assinatura opcional
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
