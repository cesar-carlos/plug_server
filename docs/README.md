# Documentacao do `plug_server`

## Como navegar

Este diretorio foi organizado para separar:

- **visao geral** do produto e da arquitetura
- **regras de negocio** de `User` / `Agent` / `Client`
- **contratos de transporte** REST e Socket
- **operacao** (configuracao, observabilidade, performance e roadmap)

Quando dois documentos tocarem no mesmo tema, use esta precedencia:

1. `docs/client_agent_business_rules.md` para ownership, aprovacao, autorizacao e revogacao
2. `docs/api_rest_bridge.md` para contrato REST e canal legado `agents:*`
3. `docs/socket_relay_protocol.md` para contrato relay `relay:*`
4. `docs/configuration.md` e `src/shared/config/env.ts` para defaults e variaveis

## Inicio rapido

- `docs/PROJECT_OVERVIEW.md`: ponto de entrada para entender o hub, os papeis e os canais
- `docs/client_agent_business_rules.md`: regra oficial de negocio do modelo `User` / `Agent` / `Client`
- `docs/api_rest_bridge.md`: uso de `POST /api/v1/agents/commands` e `agents:*`
- `docs/socket_relay_protocol.md`: contrato relay no namespace `/consumers`
- `docs/socket_client_sdk.md`: guia minimo para implementar um cliente Socket relay

## Por assunto

### Modelo de negocio

- `docs/client_agent_business_rules.md`
- `docs/user_status.md`

### Transporte e integracao

- `docs/api_rest_bridge.md`
- `docs/socket_relay_protocol.md`
- `docs/socket_client_sdk.md`
- `docs/migracao_plug_agente_namespaces.md`
- `docs/communication_sync_plug_agente.md`

### Operacao e tuning

- `docs/configuration.md`
- `docs/nginx_production.md`
- `docs/performance_hub_agent.md`
- `docs/observability.md`
- `docs/load_testing.md`
- `docs/scaling_and_roadmap.md`

### Estudos e material complementar

- `docs/e2e_benchmark_hub_agent.md`
- `docs/relay_fastpath_study.md`

## Intencao de cada documento

- `PROJECT_OVERVIEW.md`: resumo executivo e mapa conceitual
- `client_agent_business_rules.md`: fonte canonica de regra de negocio
- `api_rest_bridge.md`: contrato detalhado do bridge REST e do legado `agents:*`
- `socket_relay_protocol.md`: contrato detalhado do relay
- `socket_client_sdk.md`: guia pragmatico do consumidor Socket
- `communication_sync_plug_agente.md`: resumo de alinhamento com o repositório `plug_agente`
- `nginx_production.md`: ajuste de proxy reverso para producao (API, Socket.IO e uploads)
- `scaling_and_roadmap.md`: backlog e limites conhecidos, nao contrato atual
