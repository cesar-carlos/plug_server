# Itens que NAO exigem mudanca obrigatoria no `plug_agente`

Esta pagina existe para o time do agente nao precisar abrir PRs explorando
os documentos do cliente Colmeia — os itens abaixo sao puramente hub-side
**no caminho default**. Extensoes opt-in (Opcao A, `agentPhaseTimings`)
ja shipparam; ver ADRs e o [README](README.md) para status vivo.

## Item 1 — Relay JSON-RPC batch (`relay:rpc.request.batch`)

### Onde vive

- Hub: `src/presentation/socket/consumers/relay_rpc_request_batch.handler.ts`
- Env: `SOCKET_RELAY_BATCH_ENABLED` (default `false`) em
  `src/shared/config/env.ts`
- Contrato: `docs/socket/socket_relay_protocol.md` ("Relay JSON-RPC batch")
- Decisao: [ADR 0008](../adrs/0008-relay-batch-protocol.md)

### Por que nao toca no agente

O batch e **apenas** um novo evento que o consumer usa para enviar 1..32
`rpc:request` em um envelope unico. O hub:

1. Recebe `relay:rpc.request.batch` em `/consumers`.
2. Decodifica o frame.
3. Para cada item, chama `dispatchRelayRpcToAgent` separadamente —
   exatamente como N `relay:rpc.request` individuais.
4. Cada item vira um `rpc:request` no canal `/agents`, indistinguivel
   de um request unary do ponto de vista do agente.

O ack do batch (`relay:rpc.batch_accepted`) e construido localmente no hub.

### O que o agente NAO precisa fazer

- Aceitar nenhum evento novo no canal consumer.
- Trocar handler de batch nativo do agente — continua apenas para
  `rpc:request` array JSON-RPC real no `/agents`.
- Negociar nenhuma extensao adicional so por causa do batch consumer.

## Item 2 — `agents:command` fast-fail cross-agent

### Onde vive

- Hub: `rpc_bridge_dispatch_command.ts` (`AgentDisconnectedBeforeDispatchError`)
- Hub: `agents_command.handler.ts` (offline-envelope / 503)
- Contrato: `docs/api/api_rest_bridge.md` ("Limite de um `agentId` por envelope")

### Por que nao toca no agente

O fast-fail acontece **antes** do request chegar no agente — quando o
hub detecta que o `agentId` solicitado nao tem socket conectado.

### O que o agente NAO precisa fazer

- Aceitar nenhuma flag nova em `rpc:request`.
- Mudar schema do `RpcRequest` ou o handler unary.

## Item 4 — Server-side phase diagnostics (`requestServerTimings`)

### Onde vive

- Hub: `server_timings_envelope.ts`, `bridge_latency_trace_builder.ts`
- Opt-in nas 3 superficies: `relay:rpc.request`, `agents:command`,
  `POST /api/v1/agents/commands`
- Contrato: `docs/socket/socket_relay_protocol.md` ("Server-side phase diagnostics")

### Hub-only (sem trabalho obrigatorio no agente)

Todas as fases abaixo sao **do lado do hub**:

| fase | onde e medida |
| ---- | ------------- |
| `consumer_frame_decode_ms` | hub decodifica frame do consumer |
| `relay_preflight_ms` | validacao + lookup de conversa + gate de capacidade |
| `encode_ms` | hub re-encoda para enviar ao agente |
| `emit_to_socket_ms` | `agentSocket.emit(rpc:request)` no hub |
| `agent_to_hub_ms` | wall-clock entre emit e inbound decode |
| `inbound_decode_ms` | hub decodifica resposta do agente |
| `pending_resolve_ms` | hub liga a resposta ao pending |
| `relay_forward_to_consumer_ms` | hub emite `relay:rpc.response` |

`agent_to_hub_ms` e a "caixa preta" do tempo agente, calculada no hub.
**Para obter so estas fases hub-side, o agente nao precisa mudar nada.**

### Extensao opt-in (ja shippada) — `meta.agent_phases`

Para quebrar `agent_to_hub_ms` em sub-fases no agente, existe a extensao
negociada `agentPhaseTimings: "v1"` ([ADR 0012](../adrs/0012-agent-phase-timings.md),
shipped 2026-06-24). Quando negociada e o consumer pede
`requestServerTimings: true`, o agente pode emitir `meta.agent_phases`.
Isso e **opt-in**, nao requisito dos 4 itens Colmeia hub-only.

## Item 3 — Relay unary fast-path

Tratado em [`01_relay_body_id_echo.md`](01_relay_body_id_echo.md).

- **Opcao B** (fallback): sem mudanca no agente.
- **Opcao A** (`clientRequestIdEcho`): **shipped** 2026-06-24 —
  [ADR 0009](../adrs/0009-client-request-id-echo.md). Deploy coordenado
  so e necessario para agentes que ainda nao negociam a extensao.
