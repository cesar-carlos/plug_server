# Regras de Negocio - User, Agent e Client

Data: 2026-04-02

Este documento consolida as regras de negocio do modelo com tres entidades:
`User`, `Agent` e `Client`.

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

Regra principal de acesso do client ao agente:

- o `Client` solicita acesso informando o `agentId`
- o pedido e submetido ao `User` responsavel por aquele `Agent`
- somente apos aprovacao o `Client` pode consultar aquele agente na sua propria lista
- o `Client` pode listar os seus agentes aprovados e consultar diretamente um agente especifico ja aprovado

Governanca do `User`:

- o `User` e responsavel pela governanca dos seus `Agent`s
- o `User` e responsavel pela governanca dos seus `Client`s
- a exposicao de rotas HTTP para gestao/listagem de `Client`s pelo `User` depende do escopo funcional do ciclo, mas o ownership e a responsabilidade de negocio ja pertencem ao `User`

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

## 3) Fluxo de acesso Client -> Agent

## 3.1 Solicitar acesso

Endpoint principal:

- `POST /api/v1/client/me/agents`

Regras:

- o `Client` envia uma lista de `agentIds`
- cada `agentId` deve existir no catalogo
- para cada `agentId`, o servidor resolve o owner via `AgentIdentity`
- se acesso ja existe em `ClientAgentAccess`, marca como `alreadyApproved`
- se nao existe, cria/atualiza pedido `ClientAgentAccessRequest` com status `pending`
- gera token de aprovacao e envia email para o owner do agente
- depois de aprovado, o `Client` pode consultar os dados gerais e de perfil desses agentes pela propria area `/client/me/agents`

## 3.2 Aprovar/Rejeitar

Endpoints:

- `POST /api/v1/client-access/approve`
- `POST /api/v1/client-access/reject`
- `GET /api/v1/client-access/status`
- `GET /api/v1/client-access/review` (pagina HTML de revisao)

Regras:

- token de aprovacao deve existir e estar valido
- pedido deve estar `pending` para decisao
- aprovacao cria (ou mantem) vinculo em `ClientAgentAccess`
- rejeicao nao cria vinculo
- ao aprovar/rejeitar, pedido sai de `pending` para status final
- ao aprovar ou rejeitar, `Client` recebe notificacao por email

## 3.3 Revogar acesso

Endpoint:

- `DELETE /api/v1/client/me/agents`

Regras:

- remove vinculos existentes em `ClientAgentAccess` para os `agentIds` informados
- nao altera ownership do agente
- operacao idempotente para itens ja removidos

## 3.4 Consultar agentes aprovados

Endpoints:

- `GET /api/v1/client/me/agents`
- `GET /api/v1/client/me/agents/{agentId}`

Regras:

- o `Client` pode consultar apenas agentes aprovados em `ClientAgentAccess`
- a listagem retorna dados gerais e de perfil do agente ja liberado para aquele `Client`
- a consulta individual por `agentId` retorna `403` quando o agente nao estiver aprovado para aquele `Client`
- a listagem suporta filtros por `status`, busca por `search` e paginacao com `page` e `pageSize`

## 3.5 Consultar pedidos de acesso

Endpoint:

- `GET /api/v1/client/me/agent-access-requests`

Regras:

- a listagem retorna os pedidos do `Client` com `status`, timestamps e `decisionReason` quando houver
- a listagem pode incluir o nome do agente para facilitar acompanhamento
- a listagem suporta filtros por `status`, busca por `search` e paginacao com `page` e `pageSize`

## 3.6 Governanca do `User` sobre `Client`s

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

- o owner (`User`) pode listar e consultar apenas `Client`s` sob seu `userId`
- o owner pode bloquear/reativar seus `Client`s`; ao bloquear, refresh tokens do `Client` sao revogados
- o owner possui inbox autenticada para listar pedidos de acesso aos seus agentes e decidir por `requestId`
- o owner pode listar quais `Client`s` estao aprovados para um agente especifico seu
- o owner pode revogar um acesso aprovado `clientId + agentId` sem alterar ownership do agente
- o fluxo por token/email continua valido como canal alternativo para approve/reject

## 4) Regras de autorizacao por principal

O sistema usa `principal_type` no JWT para distinguir sessao de `user` e `client`.

## 4.1 HTTP

- rotas de `client` usam `requireClientAuth` e `requireClientActiveAccount`
- token de `client` nao deve acessar fluxo exclusivo de `user` e vice-versa
- em comandos para agente, autorizacao e por principal:
  - `user` valida por `AgentIdentity`
  - `client` valida por `ClientAgentAccess`
- `admin` pode operar qualquer agente ativo em `POST /agents/commands`, `agents:command` e `relay:conversation.start`
- em leitura HTTP de agentes aprovados do `Client`, a autorizacao tambem e por `ClientAgentAccess`
- endpoints legados de vinculacao manual de `Agent` deixam de fazer parte da regra de negocio

## 4.2 Socket

- namespace `/consumers` aceita roles configuradas em `SOCKET_CONSUMER_ROLES`
- principal autenticado e resolvido pelo JWT
- `agents:command` e `relay:conversation.start` autorizam por principal:
  - `user` -> `AgentIdentity`
  - `client` -> `ClientAgentAccess`
- `admin` pode iniciar operacao em qualquer agente ativo
- apos revogacao de `ClientAgentAccess`, novas chamadas `relay:rpc.request` na conversa existente voltam a validar acesso e devem falhar com `AGENT_ACCESS_DENIED`; a conversa pode permanecer aberta ate encerramento explicito/timeout

## 5) Regras de validacao e estado

- `agentId` precisa existir para pedido de acesso
- conta `Client` bloqueada nao pode autenticar/operar
- conta owner (`User`) bloqueada nao pode ser usada para novos cadastros de `Client`
- pedido pode estar em: `pending`, `approved`, `rejected`, `expired`
- acesso efetivo para executar comando existe apenas com registro em `ClientAgentAccess`

## 6) Matriz resumida

- ownership de agente: `AgentIdentity` (1 owner por agente)
- nascimento do ownership do agente: `agent-login` + `agent:register`, com bind oficial no `agent:register`
- ownership de client: `Client.userId` (1 owner por client)
- acesso de client ao agente: `ClientAgentAccess` (N:N apos aprovacao)
- pedido de acesso: `ClientAgentAccessRequest`
- decisao por token: `ClientAgentAccessApprovalToken`
- notificacao por email: owner no pedido, client na decisao

## 7) Rotas relacionadas

Autenticacao de client:

- `POST /api/v1/client-auth/register`
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
