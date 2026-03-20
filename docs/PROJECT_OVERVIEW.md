# Plug Server - Visao Geral do Projeto

## Objetivo

O `plug_server` e o servidor central online responsavel por orquestrar a comunicacao
entre os `plug_agente` e os `consumers`.

O principal objetivo do projeto e permitir que agentes locais possam atender
clientes externos sem exigir abertura de porta no modem, redirecionamento de
porta ou exposicao direta do ambiente local na internet.

Em vez de o cliente se conectar diretamente ao agente, ambos se conectam ao
`plug_server`. O servidor passa a funcionar como um hub de confianca para:

- autenticacao
- autorizacao
- roteamento de comandos
- correlacao de requests e responses
- gerenciamento de conexoes em tempo real

## Problema que o projeto resolve

Sem um hub central, cada `plug_agente` precisaria ser exposto diretamente para
consumo remoto. Isso aumenta complexidade operacional e risco de seguranca.

O Socket.IO usa dois namespaces isolados (`/agents` e `/consumers`) para evitar
acoplamento entre papeis e tratamento acidental de eventos entre agentes e consumers.

Com o `plug_server`:

- o `plug_agente` inicia a conexao de saida para o servidor central
- o `consumer` tambem se conecta ao servidor central
- o servidor controla quem pode se conectar e o que pode ser executado
- o comando sai do `consumer`, passa pelo hub e chega ao agente correto
- a resposta volta pelo mesmo caminho, com rastreabilidade

## Papeis do ecossistema

### Plug Server

O `plug_server` e o ponto central de coordenacao do sistema.

Responsabilidades:

- receber conexoes HTTP e Socket.IO
- autenticar usuarios, clientes e agentes
- emitir e validar tokens
- manter o mapa de agentes conectados
- conhecer as capacidades anunciadas pelos agentes
- receber comandos dos consumers
- encaminhar comandos ao agente correto
- receber respostas do agente
- devolver respostas ao consumer solicitante
- aplicar controles de seguranca, validacao e observabilidade

### Plug Agente

O `plug_agente` e o executador remoto das operacoes de negocio.

No modelo arquitetural deste ecossistema, o agente:

- conecta-se ao `plug_server` via Socket.IO no namespace `/agents` (o `plug_agente` deve usar `io("/agents")` ao conectar)
- autentica-se no handshake
- registra sua identidade e capacidades
- mantem uma conexao persistente com heartbeat e reconexao
- recebe comandos roteados pelo hub
- executa a operacao localmente
- devolve response, erro ou stream de resultado

O agente nao deve ser exposto diretamente para a internet. Ele atua por meio do
hub central.

### Consumer

O `consumer` e qualquer cliente que deseja utilizar um `plug_agente`. Conecta-se
ao namespace `/consumers` via Socket.IO ou usa a API REST para enviar comandos.

Exemplos:

- aplicacoes web
- paineis administrativos
- sistemas internos
- outros servicos que desejam consumir agentes

O consumer nao fala diretamente com o agente. Ele fala com o `plug_server`, que
valida a requisicao, decide o roteamento e encaminha a mensagem.

## Modelo de comunicacao

O ecossistema usa dois estilos de comunicacao complementares:

- HTTP/REST para autenticacao, health checks e operacoes administrativas
- Socket.IO com namespaces separados:
  - `/agents` - agentes conectam aqui; ciclo de vida (register, heartbeat, rpc response/ack/chunk/complete)
  - `/consumers` - consumers conectam aqui em dois modos:
    - legado (`agents:*`) para bridge JSON
    - relay (`relay:*`) para conversa isolada com `PayloadFrame`

### Dois canais para comandos ao agente (REST vs Socket)

O **consumer** pode enviar o mesmo tipo de comando JSON-RPC ao agente por **dois caminhos**, consoante a arquitetura da aplicacao cliente:

| Canal | Entrada | Streaming para o cliente |
| ----- | ------- | ------------------------- |
| **REST** | `POST /api/v1/agents/commands` (Bearer) | **Nao progressivo**: o hub fala com o agente por Socket (incluindo `rpc:chunk` / `rpc:stream.pull` por dentro quando ha `stream_id`), mas **agrega** o resultado e devolve **uma** resposta HTTP JSON. Nao ha SSE nem chunked JSON no contrato atual. |
| **Socket** | Namespace `/consumers`: `agents:command` (legado), `relay:rpc.request` (relay), etc. | **Tempo real**: chunks (`agents:command_stream_*` ou `relay:rpc.chunk` / `complete`) e **pull** explicito para backpressure. |

- **Escolha do cliente**: e valido usar **so REST** (sem Socket no consumer), **so Socket**, ou **combinar** (ex.: autenticacao e listagem de agentes por HTTP, comandos por Socket — ou o inverso para comandos REST apos login HTTP). O **agente** continua sempre ligado ao hub via `/agents`.
- **Limitacao arquitetural do REST**: por desenho do endpoint HTTP, o streaming do agente e **materializado no servidor** antes da resposta; para volumes muito grandes ou latencia por chunk, preferir o canal Socket. Ver `docs/api_rest_bridge.md` (gaps / materializacao) e `docs/performance_hub_agent.md`.

No projeto atual, a base HTTP inclui:
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/agent-login` - login para agentes (emite JWT com `role: agent` e `agent_id`); ver `docs/migracao_plug_agente_namespaces.md`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/ping`
- `GET /api/v1/health`
- `GET /api/v1/health/live`
- `GET /api/v1/health/ready`
- `GET /metrics` - metricas operacionais no formato Prometheus
- `GET /api/v1/metrics` - mesmo payload de metricas sob prefixo da API
  - inclui contadores de relay, REST bridge (latencia), materializacao de stream SQL REST (`plug_rest_sql_stream_materialize_pulls_total`), auditoria Socket, etc.
- `GET /api/v1/agents` - lista agentes registrados no namespace `/agents` (requer Bearer token); em dev inclui `_diagnostic.socketConnectionsInAgentsNamespace` para debug
- `POST /api/v1/agents/commands` - proxy de comandos JSON-RPC ao agente (ver `docs/api_rest_bridge.md`)

Canal Socket para consumers (namespace `/consumers`):

Modo legado:

- `agents:command` - envia comando ao agente (payload equivalente ao body da REST)
- `agents:command_response` - resposta inicial normalizada ou erro
- `agents:command_stream_chunk` - chunk de streaming encaminhado pelo hub
- `agents:command_stream_complete` - fim do streaming encaminhado pelo hub
- `agents:stream_pull` - solicita mais chunks para um stream ativo
- `agents:stream_pull_response` - confirmacao/erro do pull

Modo relay:

- `relay:conversation.start` / `relay:conversation.started`
- `relay:conversation.end` / `relay:conversation.ended`
- `relay:rpc.request` / `relay:rpc.accepted`
- `relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`
- `relay:rpc.request_ack`, `relay:rpc.batch_ack`
- `relay:rpc.stream.pull` / `relay:rpc.stream.pull_response`

No modo legado em `/consumers`, o payload permanece logico (JSON) e o
`PayloadFrame` e tratado apenas no enlace com `/agents`. No modo relay, o
consumer envia/recebe `PayloadFrame` no proprio `/consumers`.
Excecao no relay: eventos de controle (`relay:conversation.*`, `relay:rpc.accepted`
e `relay:rpc.stream.pull_response`) permanecem em JSON logico.

## Fluxo macro do sistema
### 1. Conexao do agente

1. O `plug_agente` abre uma conexao Socket.IO com o `plug_server` no namespace `/agents`.
2. O agente envia credenciais de autenticacao no handshake.
3. O servidor valida o token recebido.
4. Apos autenticacao, o agente registra sua identidade e suas capacidades.
5. O servidor marca o agente como disponivel para roteamento.

### 2. Conexao do consumer

1. O `consumer` autentica-se via API HTTP.
2. O servidor emite tokens de acesso e refresh.
3. O consumer passa a operar autenticado.
4. Para fluxos em tempo real, o consumer conecta ao namespace `/consumers` com JWT no handshake.

### 3. Envio de comando

1. O `consumer` solicita uma operacao via REST, Socket legado (`agents:command`)
   ou Socket relay (`relay:rpc.request` dentro de uma `conversationId`).
2. O `plug_server` valida autenticacao, autorizacao e formato do payload.
3. O servidor identifica qual agente deve processar aquele comando.
4. O comando e encaminhado ao `plug_agente` no namespace `/agents`.
5. O agente executa a operacao localmente.
6. O agente devolve uma resposta ao servidor.
7. O servidor correlaciona a resposta com a requisicao original.
8. O resultado e entregue ao `consumer`.

## Funcionamento esperado do Plug Agente

O agente opera exclusivamente no namespace `/agents`. Pela arquitetura e pela
documentacao analisada no `plug_agente`, o comportamento esperado e:

- usar `Socket.IO` como transporte principal
- preferir transporte `websocket`
- autenticar no handshake com token
- anunciar capacidades ao conectar
- negociar detalhes do protocolo com o hub
- receber eventos de request e responder com envelopes padronizados
- suportar heartbeat para detectar conexoes stale
- suportar reconexao automatica
- suportar respostas de erro estruturadas
- suportar streaming em cenarios de carga maior

O protocolo documentado no agente utiliza eventos como:

- `agent:register`
- `agent:capabilities`
- `agent:heartbeat`
- `hub:heartbeat_ack`
- `rpc:request`
- `rpc:response`
- `rpc:request_ack`
- `rpc:batch_ack`
- `rpc:chunk`
- `rpc:complete`
- `rpc:stream.pull`

## Protocolo e decisao tecnica

O `plug_agente` ja trabalha com `Socket.IO`, nao com WebSocket cru como contrato
principal de aplicacao. Por isso, a direcao tecnica correta para este projeto e
evoluir o `plug_server` para ser compativel com esse protocolo.

Isso significa que o `plug_server` deve atuar como hub para:

- handshake autenticado
- registro de agentes
- negociacao de capacidades
- roteamento de eventos RPC
- controle de correlacao entre request e response
- suporte futuro a streaming e backpressure

## Funcionalidades principais do projeto

As funcionalidades-alvo do `plug_server` sao:

- autenticacao de agentes
- autenticacao de consumers
- emissao e rotacao de JWT access/refresh token
- conexoes Socket.IO autenticadas
- registro de agentes online
- descoberta de capacidades dos agentes
- roteamento de comandos por agente
- tratamento padronizado de erros
- validacao forte de payloads
- observabilidade com request id e logs
- health checks para operacao e monitoramento
- base inicial em memoria, sem persistencia obrigatoria

## Estado de persistencia

Nesta fase do projeto, a persistencia pode permanecer em memoria.

Isso significa que estruturas como as abaixo podem existir inicialmente apenas
em runtime:

- agentes conectados
- sessoes ativas
- capacidades registradas
- correlacao de requests pendentes
- caches temporarios de autenticacao e roteamento

Excecao atual:

- eventos de auditoria Socket (`audit_events`) sao persistidos em banco com
  politica de retencao configuravel (default 90 dias)

No futuro, o projeto pode evoluir para persistencia em banco de dados sem mudar
o papel central do `plug_server` na arquitetura.

## Seguranca

O projeto exige autenticacao tanto para o `plug_agente` quanto para o `consumer`.

Cada namespace aplica autenticacao no handshake e valida o `role` do JWT:
- `/agents`: apenas roles em `SOCKET_AGENT_ROLES` (default: `agent`)
- `/consumers`: apenas roles em `SOCKET_CONSUMER_ROLES` (default: `user`, `admin`), excluindo roles de agente

Quando o token possui claim `agent_id`, o `agent:register` so e aceito se o `agentId` do payload coincidir.

Nao ha tratamento de eventos entre namespaces; o hub realiza roteamento explicito entre canais.
Conexoes no namespace padrao `/` sao rejeitadas e desconectadas com `app:error` (code `NAMESPACE_DEPRECATED`).

Diretrizes principais:

- nenhum agente deve operar anonimamente
- nenhum consumer deve consumir agentes sem autenticacao
- o servidor deve validar token, contexto e permissao antes de encaminhar comandos
- a exposicao direta do agente deve ser evitada
- mensagens devem ser validadas antes de serem processadas

## Estado atual da implementacao

O projeto ja possui:

- API HTTP com autenticacao
- JWT access e refresh token
- validacao com Zod
- middlewares de seguranca
- health checks
- Socket.IO com namespaces `/agents` e `/consumers`; namespace padrao `/` rejeitado com `app:error` (code `NAMESPACE_DEPRECATED`)
- registro de agentes em tempo real no namespace `/agents` (`agent:register`, `agent:capabilities`)
- negociacao de capacidades com o agente
- roteamento RPC via REST (`POST /api/v1/agents/commands`) - bridge HTTP para namespace `/agents`
- roteamento RPC via Socket (`agents:command` no namespace `/consumers`)
- streaming via Socket para consumers (`agents:command_stream_chunk` e `agents:command_stream_complete`)
- controle de backpressure via Socket (`agents:stream_pull` -> `rpc:stream.pull`)
- modo relay Socket (`relay:*`) com isolamento por `conversationId`
- idempotencia de relay por `client_request_id` (TTL)
- timeout de request relay com resposta de erro JSON-RPC ao consumer
- circuit breaker por agente para requests Socket
- backpressure reforcado no relay com creditos de pull e buffer limitado
- quotas de protecao (conversas, pending requests e streams)
- rate-limit por consumer para `relay:conversation.start` e `relay:rpc.request`
- expiracao automatica de conversa por inatividade
- metricas de relay em memoria com log periodico
- auditoria Socket com retencao configuravel (default 90 dias)
- prune de auditoria em lote (batch delete) para reduzir impacto em volume alto
- shutdown gracioso com aviso aos clientes Socket e drenagem de auditoria pendente
- mapa de correlacao entre request e response (pending requests no bridge)
- handlers para `rpc:request_ack`, `rpc:batch_ack`, `rpc:chunk` e `rpc:complete`
- PayloadFrame binario com compressao GZIP e assinatura opcional
Evolucoes futuras:

- suportar streaming via REST (acumular chunks ou SSE)

## Socket Relay

Documentacao do modo relay/chat-like com isolamento por conversa (N consumers
para 1 agente), sem alterar REST:

- `docs/socket_chat_relay_plan.md`
- `docs/socket_relay_protocol.md`
- `docs/socket_client_sdk.md`

## Desempenho (hub ↔ plug_agente)

- `docs/performance_hub_agent.md` — Socket.IO (buffer, deflate), REST vs streaming, variáveis de env, escala.


## Resumo

O `plug_server` nao e apenas uma API REST tradicional. Ele e o nucleo de
orquestracao do ecossistema Plug.

Seu papel e servir como um hub central confiavel entre agentes e consumers,
concentrando autenticacao, seguranca, comunicacao em tempo real e roteamento de
comandos. O modelo de namespaces (`/agents` e `/consumers`) isola responsabilidades
e evita acoplamento entre papeis. O `plug_agente` permanece como executador
especializado das operacoes remotas.
