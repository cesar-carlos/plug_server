# Regras de Negocio - User, Agent e Client

Data: 2026-04-02

Este documento consolida as regras de negocio do modelo com tres entidades:
`User`, `Agent` e `Client`.

Esta e a fonte canonica para:

- ownership de `Agent` e `Client`
- aprovacao, revogacao e consulta de acessos
- autorizacao por principal em HTTP e Socket
- efeitos de bloqueio e revogacao sobre operacao

Para rotas HTTP, considere `/api/v1` como prefixo canonico. O projeto ainda expõe
aliases de compatibilidade em `/auth/*` e `/metrics`, mas as rotas listadas aqui
devem ser lidas sob o prefixo da API. Para payloads e schemas de request/response,
use o OpenAPI em `GET /docs` e `GET /docs.json`.

Para contratos de transporte e exemplos de payload, ver:

- `docs/api_rest_bridge.md`
- `docs/socket_relay_protocol.md`
- `docs/socket_client_sdk.md`

Mapa geral da documentacao: `docs/README.md`.

## 0) Resumo executivo do modelo

O modelo de negocio do `plug_server` passa a considerar tres entidades principais:
`User`, `Agent` e `Client`.

Regras estruturais:

- um `User` pode gerir varios `Agent`s
- um `User` pode gerir varios `Client`s
- um `Agent` pertence a um unico `User`
- um `Client` pertence a um unico `User`
- um `Client` pode ter acesso a varios `Agent`s, desde que cada acesso seja aprovado

Regra principal de ownership do agente:

- o `Agent` nao e vinculado manualmente por endpoint
- o vinculo nasce automaticamente quando o agente autentica com email e senha do `User` em `agent-login` e conclui `agent:register`
- ao concluir `agent:register`, o servidor cria ou atualiza o cadastro do agente e formaliza o ownership em `AgentIdentity`

Regra principal de acesso do `Client` ao agente:

- o `Client` solicita acesso informando o `agentId`
- o pedido e submetido ao `User` responsavel por aquele `Agent`
- somente apos aprovacao o `Client` pode consultar aquele agente na sua propria lista
- o `Client` pode listar os seus agentes aprovados e consultar diretamente um agente especifico ja aprovado

Governanca do `User`:

- o `User` e responsavel pela governanca dos seus `Agent`s
- o `User` e responsavel pela governanca dos seus `Client`s
- a governanca do `User` sobre `Client`s tambem esta exposta por rotas HTTP autenticadas

## 1) Entidades e responsabilidades

### `User`

- e o gestor principal da conta
- e owner dos seus `Agent`s (ownership exclusivo por agente)
- e owner dos seus `Client`s
- aprova ou rejeita pedidos de acesso de `Client` aos seus `Agent`s

### `Agent`

- representa a instancia plug_agente conectada ao hub
- possui owner unico (um unico `User`) via `AgentIdentity`
- pode ser acessado por varios `Client`s, mas somente apos aprovacao
- seu ownership nasce automaticamente no fluxo de autenticacao e registro do agente

### `Client`

- pertence a um unico `User` (gestor)
- autentica com principal proprio (`principal_type: "client"`)
- nasce em `pending` no cadastro publico e so ativa apos aprovacao do owner (`User`) informado por `ownerEmail`
- se `ownerEmail` nao existir ou nao estiver apto para aprovar, a API publica responde com validacao generica (sem revelar estado da conta)
- pode solicitar acesso a varios `Agent`s
- somente executa comandos nos `Agent`s para os quais recebeu aprovacao

## 2) Ownership e fonte de verdade

### Ownership de `Agent`

- fonte de verdade: `AgentIdentity`
- regra: um `agentId` so pode estar vinculado a um `userId` owner
- `Agent.lastLoginUserId` e atributo operacional (ultimo login), nao substitui ownership
- o ownership nao e criado manualmente por endpoint
- o ownership oficial so e confirmado quando o agente conclui `agent:register`

### Ownership de `Client`

- cada `Client` e vinculado a um `userId` owner
- esse owner e usado para governanca de cadastro e bloqueio do `Client`

## 2.1 Fluxo de ownership automatica do Agent

Regras oficiais:

- o `User` nao vincula mais `Agent`s manualmente por endpoint
- o agente autentica com as credenciais do `User` via `agent-login`
- o `agent-login` apenas autentica e cria a sessao do agente
- o ownership oficial do `Agent` nasce somente no primeiro `agent:register` valido
- ao concluir `agent:register`, o servidor solicita `agent.getProfile`
- se o `agentId` ainda nao existir no catalogo, o servidor cria o cadastro automaticamente
- se o `agentId` ja existir no catalogo, o servidor atualiza os dados automaticamente
- nao existem mais endpoints HTTP para criar ou editar manualmente o catalogo do agente
- o catalogo passa a ser mantido pelo proprio fluxo do agente; excecao: `admin` ainda pode desativar um agente

Semantica esperada:

- se o `agentId` ainda nao possui owner, o servidor cria o bind em `AgentIdentity`
- se o `agentId` ja pertence ao mesmo `User`, o fluxo e idempotente
- se o `agentId` ja pertence a outro `User`, o registro deve ser rejeitado
- apos um `agent:register` valido, o agente passa a constar automaticamente na lista de agentes geridos por aquele `User`

Importante:

- `agent-login` isolado nao cria ownership
- `lastLoginUserId` nao define owner
- `AgentIdentity` continua sendo a unica fonte de verdade de ownership
- `GET /api/v1/agents/catalog` e `GET /api/v1/agents/catalog/{agentId}` sao leitura
- `DELETE /api/v1/agents/catalog/{agentId}` e apenas desativacao administrativa, nao criacao/edicao de cadastro

### Perfil no catalogo: versao, pull sync e tempo real

- O RPC `agent.getProfile` deve preferencialmente devolver `profile_version` (inteiro monotonico alinhado ao servidor). Agentes legados podem omitir o campo; o hub aplica regras de *fallback* ao sincronizar.
- O *pull sync* no registo compara a versao remota com a do catalogo: versao remota **menor** que a do servidor é ignorada (servidor mais novo); versao **igual** com **conteudo** de perfil diferente falha o sync (divergencia operacional a resolver antes de novo registo/sync).
- O proprio agente (JWT de `agent-login`) pode atualizar o perfil por HTTP em `PATCH /api/v1/agents/{agentId}/profile` com patch parcial; o OpenAPI em `/docs` descreve `expectedProfileVersion` (CAS), `Idempotency-Key` / `idempotencyKey` e respostas `409` quando aplicavel.
- Quando ligado ao namespace `/agents`, o proprio agente tambem pode enviar `agent:profile.update` em `PayloadFrame`; o payload usa `snake_case` (`trade_name`, `postal_code`, `profile_version`, `expected_profile_version`, `idempotency_key`) e o hub responde em `agent:profile.updated` com `success=true|false`, `agent_id`, `profileVersion`, `profileUpdatedAt` e o snapshot atualizado quando a escrita e aceite.
- Respostas HTTP e listagens de catalogo expoem `profileVersion` (e `profileUpdatedAt` quando existir) para clientes e administracao acompanharem revisoes.
- `Client` com acesso aprovado ao agente, ligado ao namespace `/consumers`, pode receber push `client:agent.profile.updated` (envelope `PayloadFrame`) quando o catalogo desse agente é atualizado, para refrescar UI sem novo `GET`. O payload logico inclui tipicamente `agent_id`, `profile_version`, `profileUpdatedAt`, `changed_fields` e `source`.

### Manutencao operacional dos dados satelite

- `agents`, `agent_identities` e `client_agent_accesses` sao dados vivos e nao usam TTL automatica.
- `agent_profile_revisions` e `agent_profile_write_idempotencies` sao podados por job periodico de manutencao; a retencao e controlada por `AGENT_PROFILE_*` no ambiente.
- pedidos `Client -> Agent` com token de aprovacao expirado deixam de depender apenas de leitura tardia: o servidor varre `client_agent_access_approval_tokens` vencidos e marca `client_agent_access_requests` pendentes como `expired`.

## 3) Fluxo de acesso Client -> Agent

### 3.1 Solicitar acesso

Endpoint principal:

- `POST /api/v1/client/me/agents`

Regras:

- o `Client` envia uma lista de `agentIds`
- cada `agentId` deve existir no catalogo
- para cada `agentId`, o servidor resolve o owner via `AgentIdentity`
- se acesso ja existe em `ClientAgentAccess`, marca como `alreadyApproved` (nao envia email)
- se nao existe linha em `ClientAgentAccess`, cria ou reabre pedido `ClientAgentAccessRequest` com status `pending` (inclui `approved` sem linha de acesso, `rejected`, `expired`, `revoked`, etc.)
- gera token de aprovacao e notifica o owner do agente quando o fluxo entra em `pending`; em producao, quando o outbox de email esta habilitado, as notificacoes sao enfileiradas para evitar bloquear o request HTTP com N envios SMTP
- resposta JSON inclui `requested`, `alreadyApproved`, `newRequests`, `reopened`, `debounced` (este ultimo quando um segundo `POST` chega ainda `pending` dentro da janela `CLIENT_AGENT_ACCESS_REQUEST_EMAIL_DEBOUNCE_MS` — sem novo email)
- listagens de pedidos usam paginação/filtros no repositório para evitar carregar todo o histórico em memória antes de paginar
- rate limit por cliente em `POST /api/v1/client/me/agents` (`REST_CLIENT_ME_AGENTS_POST_RATE_LIMIT_*`)
- depois de aprovado, o `Client` pode consultar os dados gerais e de perfil desses agentes pela propria area `/client/me/agents`
- introspecao da politica de autorizacao do `client_token` no plug_agente (sem executar SQL): RPC `client_token.getPolicy` via `POST /api/v1/agents/commands` ou Socket, quando o agente expuser o metodo; contrato e limites em `docs/api_rest_bridge.md`

### 3.2 Aprovar/Rejeitar

Endpoints:

- `POST /api/v1/client-access/approve`
- `POST /api/v1/client-access/reject`
- `GET /api/v1/client-access/status`
- `GET /api/v1/client-access/review` (pagina HTML de revisao)
- `POST /api/v1/client/me/agent-access-requests/{requestId}/retry` (cliente autenticado)

Regras:

- token de aprovacao deve existir e estar valido
- pedido deve estar `pending` para decisao
- `Client` deve continuar `active` no momento da aprovacao
- `Agent` deve continuar `active` no momento da aprovacao
- aprovacao cria (ou mantem) vinculo em `ClientAgentAccess`
- rejeicao nao cria vinculo
- ao aprovar/rejeitar, pedido sai de `pending` para status final
- ao aprovar ou rejeitar, `Client` recebe notificacao por email
- se o owner decidir por rota autenticada (`/api/v1/me/client-access-requests/{requestId}/approve|reject`), qualquer token publico pendente daquele pedido e invalidado
- se a rejeicao tiver sido feita por engano, o proprio `Client` pode chamar a rota de retry autenticada; o pedido volta a `pending`, recebe novo token e o owner do agente recebe novo email
- rotas publicas baseadas em token devem ser limitadas por rate limit; a pagina HTML de revisao e sempre read-only em `GET`, com mutacao somente pelos formularios `POST`
- quando a transacao de aprovacao/rejeicao falha em infra/persistencia, as rotas publicas retornam HTML amigavel `503` com `requestId` visivel e logs estruturados (`client_agent_access_txn_failed` / `client_agent_access_txn_prisma_error`)
- observabilidade do fluxo publico inclui metricas Prometheus para `started`, `outcomes` e `latency` por decisao (`approve` / `reject`) via `GET /metrics`

### 3.2.1 Retentativas de aprovacoes por email

Endpoints:

- `POST /api/v1/auth/registration/retry`
- `POST /api/v1/client-auth/registration/retry`
- `POST /api/v1/client/me/agent-access-requests/{requestId}/retry`

Regras:

- retry reabre apenas pedidos com status `rejected`, `expired` ou `revoked`; `pending` permanece idempotente/debounced e `approved` so retorna `alreadyApproved` enquanto o acesso real existir
- cadastros publicos (`User` e `Client`) respondem genericamente com `202` para contas inexistentes, senha incorreta ou status nao elegivel
- retry de `Client` exige `ownerEmail`, email/senha do client e owner ativo; apenas registros `rejected` sao elegiveis para reabrir `pending`
- retry de acesso `Client -> Agent` exige JWT de `Client` ativo e ownership do pedido pelo client autenticado
- pedidos ja `pending` devem permanecer idempotentes/debounced para evitar spam de emails

### 3.3 Revogar acesso

Endpoint:

- `DELETE /api/v1/client/me/agents` (corpo JSON `agentIds`)
- `DELETE /api/v1/client/me/agents/{agentId}` (alternativa sem corpo)

Regras:

- remove vinculos existentes em `ClientAgentAccess` para os `agentIds` informados
- se existir `ClientAgentAccessRequest` com status `approved` para o mesmo par cliente+agente, o pedido passa a `revoked` com motivo `client_revoked_access` (alinhado com o estado real de acesso)
- para voltar a ter o agente na lista, o cliente usa `POST /api/v1/client/me/agents` de novo, o que reabre `pending` e reenvia email ao owner ate nova aprovacao
- nao altera ownership do agente
- operacao idempotente para itens ja removidos
- quando a revogacao acontece e o `Client` tem socket ativo em `/consumers`, o hub encerra a sessao com `app:error.code = "AGENT_ACCESS_REVOKED"`; isto reduz a janela em que uma sessao antiga continuaria viva apenas confiando no guard por evento

### 3.4 Consultar agentes aprovados

Endpoints:

- `GET /api/v1/client/me/agents`
- `GET /api/v1/client/me/agents/{agentId}`

Regras:

- o `Client` pode consultar apenas agentes aprovados em `ClientAgentAccess`
- a listagem retorna dados gerais e de perfil do agente ja liberado para aquele `Client`
- a consulta individual por `agentId` retorna `403` quando o agente nao estiver aprovado para aquele `Client`
- a listagem suporta filtros por `status`, busca por `search` e paginacao com `page` e `pageSize`
- cada agente na resposta inclui `isHubConnected` (boolean): indica se **este processo do hub** tem o agente registado no namespace Socket `/agents` apos `agent:register` (mesma nocao que o hub usa para despacho de comandos). O valor e um **instantaneo** no momento da resposta HTTP (pode mudar entre pedidos; com `refresh=true` reflecte o estado apos o trabalho de perfil desse pedido). Com varias instancias do servidor, o valor pode ser `false` numa replica em que o agente nao esta ligado, mesmo estando ligado a outra; nao confundir com `status` active/inactive do catalogo na BD. Se a variavel de ambiente `HUB_INSTANCE_ID` estiver definida, a resposta pode incluir o header `X-Hub-Instance-Id` para correlacionar com a replica
- em ambiente com load balancer na frente de varias replicas, integradores que precisem alinhar o resultado destes GET com o socket do agente devem usar **a mesma base URL** para REST e WebSocket ou **sticky sessions** de modo a bater na mesma instancia que mantem o socket do agente; caso contrario `isHubConnected` pode parecer `false` mesmo com o agente ligado a outra replica (ver tambem `docs/scaling_and_roadmap.md`). Isto evita depender de servicos ou pacotes adicionais no hub: o boolean continua derivado apenas do registo em memoria deste processo

## 4) Bloqueio, revogacao e efeito em Socket

Regras operacionais adicionais:

- `User` bloqueado: novas operacoes HTTP/Socket passam a falhar e sockets ativos em `/consumers` do proprio user sao desconectados com `ACCOUNT_BLOCKED`
- `Client` bloqueado: novas operacoes HTTP/Socket passam a falhar e sockets ativos em `/consumers` do client sao desconectados com `ACCOUNT_BLOCKED`
- revogacao de `ClientAgentAccess`: o client deixa de receber `client:agent.profile.updated` para aquele agente e o hub encerra a sessao Socket atual para forcar novo bootstrap/autorizacao
- `client:agent.profile.updated` considera apenas clients **ativos** e com acesso efetivo no momento do fan-out; client bloqueado ou acesso revogado nao deve continuar a receber push

### 3.5 Consultar pedidos de acesso

Endpoint:

- `GET /api/v1/client/me/agent-access-requests`

Regras:

- a listagem retorna os pedidos do `Client` com `status`, timestamps e `decisionReason` quando houver
- a listagem pode incluir o nome do agente para facilitar acompanhamento
- a listagem suporta filtros por `status`, busca por `search` e paginacao com `page` e `pageSize`

### 3.6 Governanca do `User` sobre `Client`s

Endpoints:

- `GET /api/v1/me/clients`
- `GET /api/v1/me/clients/{clientId}`
- `PATCH /api/v1/me/clients/{clientId}/status`
- `GET /api/v1/me/client-access-requests`
- `POST /api/v1/me/client-access-requests/{requestId}/approve`
- `POST /api/v1/me/client-access-requests/{requestId}/reject`
- `GET /api/v1/me/agents/{agentId}/clients`
- `DELETE /api/v1/me/agents/{agentId}/clients/{clientId}`

Regras:

- o owner (`User`) pode listar e consultar apenas `Clients` sob seu `userId`
- o owner pode bloquear/reativar seus `Client`s`; ao bloquear, refresh tokens do `Client` sao revogados
- `PATCH /api/v1/me/clients/{clientId}/status` nao processa `Client` em `pending`; nesse estado a decisao deve passar pelo fluxo oficial de aprovacao/rejeicao do cadastro
- o owner possui inbox autenticada para listar pedidos de acesso aos seus agentes e decidir por `requestId`
- o owner pode listar quais `Clients` estao aprovados para um agente especifico seu
- o owner pode revogar um acesso aprovado `clientId + agentId` sem alterar ownership do agente; se o pedido estava `approved`, passa a `revoked` com motivo `owner_revoked_access`
- o fluxo por token/email continua valido como canal alternativo para approve/reject

## 5) Regras de autorizacao por principal

O sistema usa `principal_type` no JWT para distinguir sessao de `user` e `client`.

### 5.1 HTTP

- rotas de `client` usam `requireClientAuth` e `requireClientActiveAccount`
- token de `client` nao deve acessar fluxo exclusivo de `user` e vice-versa
- em comandos para agente, autorizacao e por principal:
  - `user` valida por `AgentIdentity`
  - `client` valida por `ClientAgentAccess`
- `admin` pode operar qualquer agente ativo em `POST /agents/commands`, `agents:command` e `relay:conversation.start`
- em leitura HTTP de agentes aprovados do `Client`, a autorizacao tambem e por `ClientAgentAccess`
- endpoints legados de vinculacao manual de `Agent` deixam de fazer parte da regra de negocio

### 5.2 Socket

- namespace `/consumers` aceita roles configuradas em `SOCKET_CONSUMER_ROLES`
- principal autenticado e resolvido pelo JWT
- a autenticacao inicial acontece no handshake, mas conta ativa e autorizacao efetiva tambem sao revalidadas por evento nas operacoes sensiveis do namespace `/consumers`
- `agents:command`, `relay:conversation.start`, `relay:rpc.request`, `agents:stream_pull` e `relay:rpc.stream.pull` autorizam por principal:
  - `user` -> `AgentIdentity`
  - `client` -> `ClientAgentAccess`
- `admin` pode iniciar operacao em qualquer agente ativo
- se a conta do `User` ou do `Client` for bloqueada depois da conexao socket, novas operacoes sensiveis devem falhar imediatamente com erro de autorizacao; permanecer conectado nao preserva permissao operacional
- apos revogacao de `ClientAgentAccess`, novas chamadas `relay:rpc.request` na conversa existente voltam a validar acesso e devem falhar com `AGENT_ACCESS_DENIED`; a conversa pode permanecer aberta ate encerramento explicito/timeout
- apos revogacao de `ClientAgentAccess`, novas chamadas `agents:stream_pull` e `relay:rpc.stream.pull` tambem devem falhar com `AGENT_ACCESS_DENIED`

## 6) Regras de validacao e estado

- `agentId` precisa existir para pedido de acesso
- cadastro de `Client` exige `ownerEmail` valido de um `User` ativo
- conta `Client` em `pending` nao pode autenticar/operar por HTTP nem por socket
- conta `Client` bloqueada nao pode autenticar/operar por HTTP nem por socket
- conta `User` bloqueada nao pode autenticar/operar por HTTP nem por socket
- conta owner (`User`) bloqueada nao pode ser usada para novos cadastros de `Client`
- pedido pode estar em: `pending`, `approved`, `rejected`, `expired`
- acesso efetivo para executar comando existe apenas com registro em `ClientAgentAccess`

## 7) Matriz resumida

- ownership de agente: `AgentIdentity` (1 owner por agente)
- nascimento do ownership do agente: `agent-login` + `agent:register`, com bind oficial no `agent:register`
- ownership de client: `Client.userId` (1 owner por client)
- acesso de client ao agente: `ClientAgentAccess` (N:N apos aprovacao)
- pedido de acesso: `ClientAgentAccessRequest`
- decisao por token: `ClientAgentAccessApprovalToken`
- notificacao por email: owner no pedido, client na decisao

## 8) Rotas relacionadas

Autenticacao de client:

- `POST /api/v1/client-auth/register`
- `GET /api/v1/client-auth/registration/review`
- `GET /api/v1/client-auth/registration/status`
- `POST /api/v1/client-auth/registration/approve`
- `POST /api/v1/client-auth/registration/reject`
- `POST /api/v1/client-auth/login`
- `POST /api/v1/client-auth/refresh`
- `POST /api/v1/client-auth/logout`
- `GET /api/v1/client-auth/me`

Acesso client-agente:

- `GET /api/v1/client/me/agents`
- `GET /api/v1/client/me/agents/{agentId}`
- `POST /api/v1/client/me/agents`
- `DELETE /api/v1/client/me/agents`
- `GET /api/v1/client/me/agent-access-requests`
- `GET /api/v1/client-access/review`
- `GET /api/v1/client-access/status`
- `POST /api/v1/client-access/approve`
- `POST /api/v1/client-access/reject`

Governanca do user sobre clients:

- `GET /api/v1/me/clients`
- `GET /api/v1/me/clients/{clientId}`
- `PATCH /api/v1/me/clients/{clientId}/status`
- `GET /api/v1/me/client-access-requests`
- `POST /api/v1/me/client-access-requests/{requestId}/approve`
- `POST /api/v1/me/client-access-requests/{requestId}/reject`
- `GET /api/v1/me/agents/{agentId}/clients`
- `DELETE /api/v1/me/agents/{agentId}/clients/{clientId}`
