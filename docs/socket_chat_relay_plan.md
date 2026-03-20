# Plano de Implementacao - Socket Chat Relay N:1

Data: 2026-03-17

> Status: implementacao base concluida em 2026-03-17. Este documento registra
> o plano original; para o contrato vigente e estado atual, consultar
> `docs/socket_relay_protocol.md`.

## Objetivo

Implementar um modo de comunicacao Socket mais proximo de "chat" entre consumer e agente, sem alterar o canal REST:

- manter REST como esta hoje
- permitir varias conversas simultaneas para o mesmo agente (N consumers : 1 agente)
- deixar o consumer falar no mesmo padrao de transporte do agente (PayloadFrame binario + compressao)
- manter o servidor como intermediador de autenticacao, autorizacao, roteamento e isolamento de sessao

Fluxo alvo:

`Cliente A -> Servidor -> Agente`

## Escopo e nao-escopo

Escopo:

- canal Socket `/consumers`
- roteamento no hub para `/agents`
- controle de conversa/sessao por `conversationId`
- contrato de eventos para relay em tempo real

Nao-escopo:

- nao mudar endpoints REST
- nao quebrar fluxo existente `agents:command` (compatibilidade durante migracao)

## Estado atual (codigo implementado)

Resumo tecnico observado:

- autenticacao por namespace ja existe (`/agents` e `/consumers`) com regras de role
- `/consumers` hoje opera em payload logico JSON (`agents:command`, `agents:stream_pull`)
- enlace com agente ja usa `PayloadFrame` (`encode/decode`, `gzip|none`, limites e assinatura opcional)
- o bridge atual faz correlacao por `requestId` e `stream_id`, com ownership por `consumerSocketId` no `stream_pull`
- no momento do levantamento inicial ainda nao existia entidade formal de conversa (`conversationId`)

Consequencias para o novo modo:

- sem `conversationId`, o isolamento e feito indiretamente por `requestId/stream_id`
- `requestId` hoje e controlado globalmente no bridge; pode haver conflito entre clientes se ids iguais forem enviados ao mesmo tempo
- o consumer nao fala no mesmo protocolo fisico do agente (frame binario) no canal atual

## Requisitos do modo Chat Relay

1. Suportar varias conversas simultaneas para o mesmo agente.
2. Isolar mensagens por conversa (nenhum vazamento entre clientes).
3. Exigir autenticacao e role valida no handshake atual.
4. Encaminhar frames entre consumer e agente com o minimo de transformacao.
5. Permitir streaming (`chunk/complete`) e backpressure (`stream.pull`) por conversa.
6. Manter rastreabilidade (`conversationId`, `requestId`, `traceId`).
7. Preservar compatibilidade com fluxo legado em paralelo.

## Contrato Socket proposto (novo modo relay)

Namespace do consumer continua `/consumers`.

Eventos de controle de conversa:

- `relay:conversation.start` (consumer -> server)
- `relay:conversation.started` (server -> consumer)
- `relay:conversation.end` (consumer -> server)
- `relay:conversation.ended` (server -> consumer)

Eventos de dados (padrao do agente):

- `relay:rpc.request` (consumer -> server -> agente `rpc:request`)
- `relay:rpc.stream.pull` (consumer -> server -> agente `rpc:stream.pull`)
- `relay:rpc.response` (agente `rpc:response` -> server -> consumer)
- `relay:rpc.chunk` (agente `rpc:chunk` -> server -> consumer)
- `relay:rpc.complete` (agente `rpc:complete` -> server -> consumer)
- `relay:rpc.request_ack` (agente `rpc:request_ack` -> server -> consumer)
- `relay:rpc.batch_ack` (agente `rpc:batch_ack` -> server -> consumer)

Formato de payload no modo relay:

- todos os eventos de dados usam `PayloadFrame`
- o JSON-RPC interno deve conter `meta.conversation_id`
- servidor valida que `meta.conversation_id` pertence ao socket autenticado antes de encaminhar

## Arquitetura alvo

### 1) Conversation Registry (novo componente)

Criar um registro em memoria para conversas ativas:

- chave principal: `conversationId`
- indice por `consumerSocketId`
- indice por `agentSocketId`
- campos: `conversationId`, `consumerSocketId`, `agentSocketId`, `agentId`, `status`, `createdAt`, `lastSeenAt`

Responsabilidades:

- abrir conversa (`start`)
- validar ownership da conversa
- fechar conversa (`end`, disconnect do consumer ou agente)
- limpar rotas e streams associados

### 2) Correlacao de request e stream por conversa

No bridge, trocar correlacao global por escopo de conversa:

- chave recomendada de pending: `agentSocketId + conversationId + requestId`
- rotas de stream tambem com `conversationId`
- manter map para `stream_id -> conversationId`

Objetivo:

- eliminar conflito entre clientes com mesmo `requestId`
- garantir isolamento por conversa mesmo com N clientes no mesmo agente

### 3) Relay Handler no /consumers

Adicionar handlers especificos do modo relay:

- start/end de conversa
- entrada de `PayloadFrame` para `relay:rpc.request` e `relay:rpc.stream.pull`
- validacao minima de contrato e ownership
- repasse para agente com encode/decode consistente

### 4) Forwarding de eventos do agente

No recebimento de eventos do agente (`rpc:*`):

- resolver conversa pela chave composta/request map/stream map
- encaminhar para o consumer correto em `relay:rpc.*`
- remover estado ao completar stream ou encerrar conversa

## Plano incremental de implementacao

Fase 1 - infraestrutura de conversa:

- criar `conversation_registry.ts`
- criar eventos `relay:conversation.*`
- vincular conversa a `consumerSocketId` e `agentSocketId`

Fase 2 - relay de request/response:

- criar eventos `relay:rpc.request` e `relay:rpc.response`
- inserir correlacao por conversa no bridge
- manter `agents:command` funcionando em paralelo

Fase 3 - relay de streaming/backpressure:

- `relay:rpc.chunk`, `relay:rpc.complete`, `relay:rpc.stream.pull`
- ownership estrito por conversa no pull
- limpeza de estado em complete/end/disconnect

Fase 4 - hardening:

- limites por conversa (rate, payload, timeout)
- auditoria com `conversationId` em logs
- metricas por agente e por consumer

Fase 5 - rollout:

- ativacao por feature flag (ex.: `SOCKET_CONSUMER_RELAY_ENABLED`)
- homologacao com cliente piloto
- migracao gradual do fluxo legado para relay

## Arquivos previstos para mudanca

- `src/shared/constants/socket_events.ts`
- `src/socket.ts`
- `src/presentation/socket/hub/rpc_bridge.ts`
- `src/presentation/socket/hub/conversation_registry.ts` (novo)
- `src/presentation/socket/consumers/relay_conversation_start.handler.ts` (novo)
- `src/presentation/socket/consumers/relay_conversation_end.handler.ts` (novo)
- `src/presentation/socket/consumers/relay_rpc_request.handler.ts` (novo)
- `src/presentation/socket/consumers/relay_rpc_stream_pull.handler.ts` (novo)
- `tests/integration/socket.integration.test.ts` (novos cenarios)
- `docs/PROJECT_OVERVIEW.md` (resumo da arquitetura)

## Criterios de aceite

1. Dois consumers em conversas diferentes com o mesmo agente nao recebem mensagens cruzadas.
2. `relay:rpc.stream.pull` de um consumer nao controla stream de outra conversa.
3. Disconnect do consumer encerra somente suas conversas.
4. Disconnect do agente encerra conversas ligadas a ele e notifica consumers afetados.
5. Fluxo legado `agents:command` continua funcional.
6. Relay aceita e encaminha `PayloadFrame` com `cmp: none` e `cmp: gzip`.
7. Logs permitem rastrear `conversationId`, `requestId` e `traceId` ponta a ponta.

## Riscos e mitigacoes

Risco: colisao de `requestId` entre conversas.
Mitigacao: chave composta por conversa e socket do agente.

Risco: crescimento de estado em memoria.
Mitigacao: TTL de conversa inativa + cleanup em disconnect/complete/end.

Risco: cliente usar relay para metodos fora de politica.
Mitigacao: **implementado** — o mesmo `bridgeCommandSchema` do REST valida o payload apos decode do `PayloadFrame` (`dispatchRelayRpcToAgent`); apenas `sql.execute`, `sql.executeBatch`, `sql.cancel` e `rpc.discover`. Uma allowlist **por role/conversa** (mais fina) continua como evolucao opcional.

## Decisoes pendentes antes da codificacao

1. Evento final para payload de dados: `relay:rpc.*` (recomendado) ou reutilizar `rpc:*` em `/consumers`.
2. ~~Nivel de validacao de metodo no relay~~ — resolvido: validacao estrita via `bridgeCommandSchema` (sem batch JSON-RPC no relay).
3. Timeouts padrao por conversa e limite maximo de conversas por consumer.
