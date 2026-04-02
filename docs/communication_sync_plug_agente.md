# Sincronizacao com `plug_agente`

## Objetivo

Este documento resume o estado atual de alinhamento entre o `plug_server` e a
documentacao de comunicacao do `plug_agente`.

Ele nao substitui os contratos normativos do hub. Use este ficheiro para:

- saber quais fontes do `plug_agente` devem ser acompanhadas
- ver o que ja esta alinhado no hub
- identificar lacunas intencionais ou operacionais
- seguir um checklist curto quando o protocolo evoluir

## Fontes de referencia no `plug_agente`

Quando houver um checkout local do repositório irmao, estas sao as referencias
principais:

- `../plug_agente/docs/communication/socket_communication_standard.md`
- `../plug_agente/docs/communication/socketio_client_binary_transport.md`
- `../plug_agente/docs/communication/openrpc.json`
- `../plug_agente/docs/communication/schemas/`

Validacao automatizada no hub: `npm run test:contract`.

## Documentos canonicos no `plug_server`

- `docs/api_rest_bridge.md`
- `docs/socket_relay_protocol.md`
- `docs/socket_client_sdk.md`
- `docs/configuration.md`
- `docs/performance_hub_agent.md`

Regras de negocio de ownership de `Agent`, acesso de `Client` e aprovacao por
owner nao sao mantidas neste resumo de sincronizacao; a fonte canonica para esse
tema e `docs/client_agent_business_rules.md`.

Historico detalhado de mudancas: `CHANGELOG.md`.

## Alinhamento atual

| Area | Estado no hub | Fonte principal |
| ---- | ------------- | --------------- |
| Namespace do agente em `/agents` | alinhado | `docs/migracao_plug_agente_namespaces.md` |
| Handshake autenticado e `agent:register` | alinhado | `docs/PROJECT_OVERVIEW.md`, `docs/api_rest_bridge.md` |
| Negociacao de capabilities | alinhado | `docs/socket_relay_protocol.md` |
| Readiness explicito com `agent:ready` | alinhado | `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md` |
| `PayloadFrame` com gzip, assinatura opcional e payload base64 | alinhado | `docs/socket_relay_protocol.md` |
| `rpc:response` invalido com fail-fast | alinhado | `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md` |
| `rpc:chunk` / `rpc:complete` invalidos com fail-fast | alinhado | `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md` |
| `rpc:complete.terminal_status` no REST materializado | alinhado | `docs/api_rest_bridge.md` |
| Backpressure relay com encerramento explicito | alinhado | `docs/socket_relay_protocol.md` |
| Pull capability-aware (`recommendedStreamPullWindowSize`, `maxStreamPullWindowSize`) | alinhado | `docs/socket_relay_protocol.md`, `docs/api_rest_bridge.md` |
| `execution_mode`, `preserve_sql`, `effective_max_rows` | alinhado | `docs/api_rest_bridge.md` |
| `id` omitido vs `id: null` no bridge | alinhado | `docs/api_rest_bridge.md`, `docs/socket_client_sdk.md` |
| Teste de contrato contra OpenRPC/schemas do agente | alinhado | `docs/observability.md` |

## Diferencas intencionais

Estas diferencas nao sao gaps acidentais; fazem parte do desenho atual do hub:

- REST continua sem streaming progressivo para o cliente HTTP.
- O hub materializa streams SQL no REST e recomenda Socket para baixa latencia.
- Parte do estado do bridge e do relay continua em memoria por processo.
- O hub pode preencher `id` omitido no bridge REST e em `agents:command` para
  simplificar integracao do consumer.

Detalhes:

- `docs/api_rest_bridge.md`
- `docs/scaling_and_roadmap.md`

## Checklist de sincronizacao

Sempre que o `plug_agente` mudar o contrato de comunicacao:

1. Rever `socket_communication_standard.md` e `socketio_client_binary_transport.md`.
2. Comparar `openrpc.json` com os metodos e versao minima esperada no hub.
3. Revalidar `schemas/*.json` e exemplos com `npm run test:contract`.
4. Atualizar os docs normativos do hub, nao este ficheiro primeiro:
   `api_rest_bridge.md`, `socket_relay_protocol.md`, `socket_client_sdk.md`.
5. So depois ajustar este resumo, se houver mudanca relevante de alinhamento.

## Quando editar este ficheiro

Edite este documento apenas quando houver:

- novo item alinhado ou nova divergencia intencional
- mudanca nas fontes canonicas do `plug_agente`
- alteracao no processo de verificacao

Nao use este ficheiro como changelog detalhado por PR ou por dia. Esse historico
deve ficar no `CHANGELOG.md` e nos documentos normativos do hub.
