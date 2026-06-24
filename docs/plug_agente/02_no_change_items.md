# Itens que NAO exigem mudanca no `plug_agente`

Esta pagina existe para o time do agente nao precisar abrir 4 PRs
explorando os documentos do cliente Colmeia — os itens abaixo sao
puramente hub-side. Use-a como referencia rapida ou ponto de
verificacao em revisoes futuras.

## Item 1 — Relay JSON-RPC batch (`relay:rpc.request.batch`)

### Onde vive

- Hub: `src/presentation/socket/consumers/relay_rpc_request_batch.handler.ts`
- Env: `SOCKET_RELAY_BATCH_ENABLED` (default `false`) em
  `src/shared/config/env.ts:1058`
- Cliente: `D:\Developer\Flutter\colmeia\docs\server_adjustments\relay_rpc_batch_protocol.md`
- Contrato: `docs/socket/socket_relay_protocol.md` ("Relay JSON-RPC batch")

### Por que nao toca no agente

O batch e **apenas** um novo evento que o consumer (Colmeia) usa para
enviar 1..32 `rpc:request` em um envelope unico. O hub:

1. Recebe `relay:rpc.request.batch` em `/consumers`.
2. Decodifica o frame.
3. Para cada item, **chama `dispatchRelayRpcToAgent` separadamente**
   (`relay_rpc_request_batch.handler.ts:367-383`), exatamente como faria
   para N `relay:rpc.request` individuais.
4. Cada item vira um `rpc:request` no canal `/agents`, indistinguivel
   de um request unary do ponto de vista do agente.

O ack do batch (`relay:rpc.batch_accepted`) e construido localmente no
hub a partir dos resultados dos N dispatches.

### O que o agente NAO precisa fazer

- Aceitar nenhum evento novo.
- Trocar handler de batch (`rpc_batch_inbound_handler.dart`) — ele
  continua sendo acionado apenas pelo `rpc:request` "real" do hub com
  payload em formato array (JSON-RPC batch nativo).
- Negociar nenhuma extensao adicional.

## Item 2 — `agents:command` fast-fail cross-agent

### Onde vive

- Hub: `src/presentation/socket/hub/relay/rpc_bridge_dispatch_command.ts:123-135`
  (lanca `AgentDisconnectedBeforeDispatchError`)
- Hub: `src/presentation/socket/consumers/agents_command.handler.ts:288-335`
  (handler responde `success: true` com offline-envelope quando ha
  `correlationId`, ou `SERVICE_UNAVAILABLE 503` quando nao)
- Cliente: `D:\Developer\Flutter\colmeia\docs\server_adjustments\agents_command_cross_agent_hang.md`
  (audit do Colmeia confirmou que **nao** era bug da hub)
- Contrato: `docs/api/api_rest_bridge.md` ("Limite de um `agentId` por envelope")

### Por que nao toca no agente

O fast-fail acontece **antes** do request chegar no agente — quando o
hub detecta que o `agentId` solicitado nao tem socket conectado. O
agente nem ve o request.

A "tela de hang" reportada pelo Colmeia foi inicialmente suspeitada de
ser falha de cross-agent no envelope, mas o audit do proprio cliente
(2026-05-28) confirmou que o `AgentCommandBatchCoordinator` ja agrupa
commands por `agentId` antes de empacotar. O contrato "1 agentId por
envelope" no `docs/api/api_rest_bridge.md` documenta isso explicitamente.

### O que o agente NAO precisa fazer

- Aceitar nenhuma flag nova em `rpc:request`.
- Mudar nenhum schema do `RpcRequest`.
- Mudar o handler do `rpc:request` (`rpc_inbound_handler.dart`) — ele
  continua recebendo requests "normais" como hoje.

## Item 4 — Server-side phase diagnostics (`requestServerTimings`)

### Onde vive

- Hub: `src/application/services/server_timings_envelope.ts`
- Hub: `src/application/services/bridge_latency_trace_builder.ts`
  (`BridgeLatencyTraceSession`, com `forceActive` para garantir
  snapshot mesmo com sampling global off)
- Opt-in nas 3 superficies:
  - `relay:rpc.request` envelope (`relay_rpc_request.handler.ts:68`)
  - `agents:command` body (`agents_command.handler.ts:146-157`)
  - `POST /api/v1/agents/commands` body (`agents.controller.ts`)
- Cliente: `D:\Developer\Flutter\colmeia\docs\server_adjustments\server_side_phase_diagnostics.md`
- Contrato: `docs/socket/socket_relay_protocol.md` ("Server-side phase diagnostics")

### Por que nao toca no agente

Todas as fases medidas sao **do lado do hub**:

| fase | onde e medida |
| ---- | ------------- |
| `consumer_frame_decode_ms` | hub decodifica frame do consumer |
| `relay_preflight_ms` | validacao + lookup de conversa + gate de capacidade |
| `encode_ms` | hub re-encoda para enviar ao agente |
| `emit_to_socket_ms` | `agentSocket.emit(rpc:request)` no hub |
| `agent_to_hub_ms` | wall-clock entre `emit_to_socket_ms` e `inbound_decode_ms` |
| `inbound_decode_ms` | hub decodifica resposta do agente |
| `pending_resolve_ms` | hub liga a resposta ao pending promise |
| `relay_forward_to_consumer_ms` | hub emite `relay:rpc.response` ao consumer |

Note que `agent_to_hub_ms` e a "caixa preta" do tempo agente, calculada
no hub a partir de timestamps locais (`performance.now()`). **O agente
nao reporta nenhuma fase individual** nessa janela.

### O que o agente NAO precisa fazer

- Aceitar nenhum campo novo em `rpc:request`.
- Emitir nenhum metadado novo na resposta.
- Negociar nenhuma extensao.

### Opcional / futuro

Se em algum momento decidirmos quebrar o "agent_to_hub_ms" em fases
mais finas (CPU do agent, espera de fila SQL, ODBC roundtrip), isso
exigiria mudanca no agente para reportar tempos por fase no
`meta` da resposta. Hoje **nao e necessario** — o objetivo do
`requestServerTimings` e isolar onde esta o gargalo na rede + hub, e
ja faz isso plenamente.

## Item 3 — Relay unary fast-path

Tratado separadamente em [`01_relay_body_id_echo.md`](01_relay_body_id_echo.md)
porque, embora o release atual nao exija mudanca no agente (Opcao B),
**existe** uma evolucao opcional (Opcao A) que precisaria de mudancas
coordenadas. Mantemos como roadmap.
