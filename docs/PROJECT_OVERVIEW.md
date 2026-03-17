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

- conecta-se ao `plug_server` via Socket.IO
- autentica-se no handshake
- registra sua identidade e capacidades
- mantem uma conexao persistente com heartbeat e reconexao
- recebe comandos roteados pelo hub
- executa a operacao localmente
- devolve response, erro ou stream de resultado

O agente nao deve ser exposto diretamente para a internet. Ele atua por meio do
hub central.

### Consumer

O `consumer` e qualquer cliente que deseja utilizar um `plug_agente`.

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
- Socket.IO para comunicacao em tempo real entre hub e agentes, e futuramente
  para fluxos interativos com consumers

No projeto atual, a base HTTP inclui:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/ping`
- `GET /api/v1/health`
- `GET /api/v1/health/live`
- `GET /api/v1/health/ready`
- `GET /api/v1/agents` — lista agentes conectados
- `POST /api/v1/agents/commands` — proxy de comandos JSON-RPC ao agente (ver `docs/api_rest_bridge.md`)

## Fluxo macro do sistema

### 1. Conexao do agente

1. O `plug_agente` abre uma conexao Socket.IO com o `plug_server`.
2. O agente envia credenciais de autenticacao no handshake.
3. O servidor valida o token recebido.
4. Apos autenticacao, o agente registra sua identidade e suas capacidades.
5. O servidor marca o agente como disponivel para roteamento.

### 2. Conexao do consumer

1. O `consumer` autentica-se via API HTTP.
2. O servidor emite tokens de acesso e refresh.
3. O consumer passa a operar autenticado.
4. Em fluxos em tempo real, o consumer tambem podera abrir um socket autenticado.

### 3. Envio de comando

1. O `consumer` solicita uma operacao.
2. O `plug_server` valida autenticacao, autorizacao e formato do payload.
3. O servidor identifica qual agente deve processar aquele comando.
4. O comando e encaminhado ao `plug_agente`.
5. O agente executa a operacao localmente.
6. O agente devolve uma resposta ao servidor.
7. O servidor correlaciona a resposta com a requisicao original.
8. O resultado e entregue ao `consumer`.

## Funcionamento esperado do Plug Agente

Pela arquitetura e pela documentacao analisada no `plug_agente`, o comportamento
esperado do agente dentro deste ecossistema e:

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

No futuro, o projeto pode evoluir para persistencia em banco de dados sem mudar
o papel central do `plug_server` na arquitetura.

## Seguranca

O projeto exige autenticacao tanto para o `plug_agente` quanto para o `consumer`.

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
- bootstrap de Socket.IO
- registro de agentes em tempo real (`agent:register`, `agent:capabilities`)
- negociacao de capacidades com o agente
- roteamento RPC via REST (`POST /api/v1/agents/commands`) — bridge HTTP para Socket.IO
- mapa de correlacao entre request e response (pending requests no bridge)
- handlers para `rpc:request_ack` e `rpc:batch_ack` (delivery guarantee)
- PayloadFrame binario com compressao GZIP e assinatura opcional

Evolucoes futuras:

- distinguir conexoes de agente e consumer no socket (namespace ou identificacao)
- suportar streaming via REST (acumular chunks ou SSE)
- suportar notification JSON-RPC (fire-and-forget) via REST

## Resumo

O `plug_server` nao e apenas uma API REST tradicional. Ele e o nucleo de
orquestracao do ecossistema Plug.

Seu papel e servir como um hub central confiavel entre agentes e consumers,
concentrando autenticacao, seguranca, comunicacao em tempo real e roteamento de
comandos, enquanto o `plug_agente` permanece como executador especializado das
operacoes remotas.
