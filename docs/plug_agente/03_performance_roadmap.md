# Performance roadmap — oportunidades cross-repo

> **Audiencia.** Time do `plug_agente`. Lista priorizada de melhorias de
> performance / observabilidade que **dependem de mudanca no agente** para
> destravar ganhos no hub e/ou na ponta do consumer.
>
> **Como esta pagina foi construida.** Audit cross-repo
> (2026-05-28) cruzando `docs/performance_hub_agent.md`,
> `docs/runbooks/socket_perf_investigation.md`, `docs/spikes/`,
> `docs/scaling_and_roadmap.md`, codigo do agente em
> `lib/infrastructure/external_services/transport/`,
> `lib/application/queue/`, `lib/core/constants/connection_constants.dart`
> e `lib/core/config/feature_flags.dart`.
>
> **Como ler.** Cada item tem:
> - **Impacto** (high / medium / low) — ganho de p95 ou cost-on-CPU/RAM esperado.
> - **Esforco** (low / medium / high) — tamanho da PR no `plug_agente`.
> - **Gate** — o que precisa ser observado antes de comecar, alinhado ao
>   `.cursor/rules/performance.mdc` ("measure-before-optimize").
> - **Hub side** — se ha trabalho coordenado no `plug_server`.
>
> Os itens estao **ordenados por impacto / esforco**. Itens com selo
> `🚨` sao bugs de configuracao silenciosos (perda de performance hoje em
> producao por divergencia de defaults entre hub e agente).

## Sumario priorizado

Coluna **Status** segue o vocabulario `proposed | discussing | in-progress |
shipped | rejected`. Atualizar quando o item mudar de fase no `plug_agente`
ou no hub. **`-`** indica que ainda nao foi triado por ninguem.

| # | Item | Impacto | Esforco | Status | Gate | Hub coord? |
| - | ---- | ------- | ------- | ------ | ---- | ---------- |
| **1** | 🚨 `enableSocketDeliveryGuarantees=true` por defeito (ou negociar) | **high** | **low** | **proposed (bugfix)** | nenhum (bug obvio) | Sim — flag ja existente |
| 2 | 🚨 Reavaliar `enableSocketStreamingChunks=false` por defeito | **high** | low | **proposed (bugfix)** | medir p95 SQL > N rows | Nao |
| 3 | Coalescing de `rpc:request_ack` em `rpc:batch_ack` (debouncer 5 ms) | medium | low | proposed | volume de `request_ack` na metrica | Nao |
| 4 | Per-phase agent timings em `meta.agent_phases` | medium | medium | proposed | item 4 ja shippado no hub | Sim — schema novo (ADR pendente) |
| 5 | `agent.getHealth` piggyback em respostas RPC | medium | medium | proposed | freq atual de poll | Sim — schema novo (ADR pendente) |
| 6 | Tunable `recommendedStreamPullWindowSize` + default > 1 | medium | low | proposed | medir p95 RTT × rows | Nao |
| 7 | Extension `clientRequestIdEcho: "v1"` (Opcao A do item 3) | low-medium | medium | proposed | adocao do fast-path | Sim — ver [`ADR 0009`](../adrs/0009-client-request-id-echo.md) e [01_relay_body_id_echo.md](01_relay_body_id_echo.md) |
| 8 | Bug `prepareForSend` reescreve `meta.request_id` (so importa se item 7 for shipar) | low | trivial | proposed (preventivo) | item 7 entrar em planning | Nao |
| 9 | Pre-warm de schema validators / JSON schemas no `agent:ready` | low | medium | proposed | medir cold-start latency primeira request | Nao |
| 10 | Compressao brotli (negociar `br` em `compressions`) | low | high | proposed | medir CPU vs gzip em frames > 64 KiB | Sim — adicionar `br` nas `HUB_TRANSPORT_COMPRESSIONS` |

> **Como mover de coluna**: quando o time do agente abrir issue ou PR,
> mudar para `discussing` ou `in-progress` com link. Quando shippar,
> mudar para `shipped` com link para o PR/release. Quando rejeitado por
> nova evidencia, mover para a secao "Itens explicitamente recusados" no
> final do documento.

---

## 1. 🚨 `enableSocketDeliveryGuarantees=true` por defeito

### Sintoma observavel hoje

A hub manda `rpc:request` ao agente e arma um timer de **1 segundo**
(`SOCKET_AGENT_ACK_TIMEOUT_MS`, default `true` em `SOCKET_AGENT_ACK_RETRY_ENABLED`).
Se nao recebe `rpc:request_ack`, **re-emite o mesmo `rpc:request`**:

```442:483:src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay.ts
const scheduleAckRetry = (wireFrame: PayloadFrameEnvelope): void => {
  if (
    !env.socketAgentAckRetryEnabled ||
    env.socketAgentAckMaxRetries <= 0 ||
    clientRequestId === null
  ) {
    return;
  }

  relayRoute.ackRetryTimer = setTimeout(() => {
    // ...
    liveAgentSocket.emit(socketEvents.rpcRequest, wireFrame);
    // ...
  }, env.socketAgentAckTimeoutMs);
};
```

O agente por defeito **nao emite acks**:

```347:349:../plug_agente/lib/infrastructure/external_services/transport/rpc_inbound_handler.dart
if (_featureFlags.enableSocketDeliveryGuarantees && !request.isNotification) {
  await _emitRequestAck(request.id);
}
```

E o defeito de `enableSocketDeliveryGuarantees`:

```165:171:../plug_agente/lib/core/config/feature_flags.dart
/// Whether to enforce delivery guarantees (ack/retry) for critical events.
bool get enableSocketDeliveryGuarantees => _prefs.getBool(_keyEnableSocketDeliveryGuarantees) ?? false;
```

**Resultado**: toda SQL relay que demora mais de **1 s** no agente recebe
um **re-emit completo** do `rpc:request`. Em metricas Prometheus do hub
isso aparece como `noteBridgeAckRetryAttempt("relay")` constante.

### Impacto medido / esperado

Para queries com latencia tipica `> 1 s` (SQL agregadas, cross-agent
`mergeAll`, ODBC com network jump):

- **CPU duplo no agente**: parse, validacao schema, signature, dedup,
  dispatch — tudo roda duas vezes mesmo para queries non-idempotent (o
  segundo dispatch pode ser bloqueado pelo `RpcRequestGuard` replay
  cache, mas a deteccao acontece **depois** de parse+validate+signature).
- **Frame extra na fila inbound do agente**: ocupa `maxConcurrentRpcHandlers`
  (32 default), reduzindo paralelismo efetivo.
- **Ruido em logs e metricas**: `rpc_timeout_without_ack` periodicamente
  para queries longas saudaveis.

### Solucao

**Opcao A (recomendada)**: defaultar `enableSocketDeliveryGuarantees` para
`true` em `feature_flags.dart`. Custo do ack e ~1 emit/request (Socket.IO
otimiza acks vazios para poucos bytes). O hub ja esta preparado para
receber e correlacionar.

**Opcao B**: negociar via extensao no `agent:capabilities`:
```json
{ "extensions": { "deliveryGuaranteesAck": "v1" } }
```
e gatear a logica de `scheduleAckRetry` no hub por essa extensao
(hoje gateia so pelo env). Mais conservador, exige mudanca no hub.

### Validacao

Antes e depois da mudanca, capturar:

- `plug_socket_bridge_ack_retry_attempts_total{channel="relay"}` (esperado: **cair para zero**)
- `plug_socket_bridge_ack_retry_exhausted_total{channel="relay"}` (esperado: cair para zero)
- p95 de E2E relay sob SQL > 1s (esperado: melhorar pelo `agent_to_hub_ms` nao incluir um re-emit).

### Gate

Nenhum — esta e uma divergencia de defaults documentada (hub espera ack,
agente nao envia). Pode entrar como bugfix.

---

## 2. 🚨 Reavaliar `enableSocketStreamingChunks=false` por defeito

### Sintoma observavel hoje

```221:225:../plug_agente/lib/core/config/feature_flags.dart
/// Whether to send large query results as ordered chunks (rpc:chunk,
/// rpc:complete) instead of a single payload.
bool get enableSocketStreamingChunks => _prefs.getBool(_keyEnableSocketStreamingChunks) ?? false;
```

Default `false`. Mesmo com `enableSocketStreamingFromDb=true` (que **le**
do ODBC em streaming), o resultado e **bufferizado inteiro** antes de
serializar em um unico `rpc:response`. Para queries que devolvem
centenas de milhares de linhas:

- Memoria do agente sobe linearmente com `row_count × avg_row_bytes`
- Encode JSON + gzip + signature roda em **um burst grande** (mesmo com
  isolate offload, latency p95 sobe)
- Hub recebe o frame inteiro de uma vez (`maxDecodedPayloadBytes` cap)
  e re-encoda para o consumer no mesmo padrao
- Consumer espera tudo antes do primeiro byte renderizar (UX ruim)

### Impacto esperado

Para a workload do Colmeia (queries SQL Server cross-agent, comum 10-100k
linhas), o switch para streaming chunks deve melhorar:

- Latencia ate o primeiro byte (TTFB): **>50% reducao** (chunks fluem
  enquanto o resto do resultado e lido do DB)
- Pico de RAM no agente: **>70% reducao** para queries com muitas linhas
- Recovery em desconexao: streaming + `rpc:stream.pull` permite re-pull do
  ultimo chunk em vez de reexecutar a query inteira

### Solucao

Defaultar `enableSocketStreamingChunks` para `true`. Streaming so
acontece quando:
- (a) `negotiatedExtensions.streamingResults == true` (hub avisa o suporte)
- (b) Resultado excede `HUB_STREAMING_ROW_THRESHOLD` (default 500)

Para resultados pequenos, segue como hoje (um unico `rpc:response`). Nao
quebra nada.

### Validacao

Em ambiente de teste, com um SQL que retorna ~10k linhas:

```
# Hub Prometheus
plug_socket_relay_chunks_forwarded_total  # esperado: aumentar
plug_socket_relay_responses_forwarded_total  # esperado: incluir o `rpc:complete` final
```

Em produccao, monitorar:
- `agent_event_loop_lag_ms` p99 (esperado: cair em workloads com queries grandes)
- Latencia ate primeiro byte E2E (consumer-side; Colmeia precisa instrumentar)

### Gate

Confirmar que o consumer (Colmeia) ja consome chunks. Pelo
`socket_channel_performance_review.md` da Colmeia, eles ja consomem.

---

## 3. Coalescing de `rpc:request_ack` em `rpc:batch_ack`

### Contexto

Apos shipar item 1 (acks habilitados por defeito), cada `rpc:request`
emite um `rpc:request_ack` individual. Em bursts (`mergeAll` cross-agent,
N requests em paralelo), isso e N emits separados onde 1 emit de
`rpc:batch_ack` com `request_ids: [...]` resolveria.

O hub ja **aceita** `rpc:batch_ack` (ver
`rpc_bridge_agent_inbound.ts` `handleAgentBatchAck`) — o agente ja usa
para batches JSON-RPC nativos via `_emitBatchRequestAck`. So precisa
estender para single requests recebidos em rajada.

### Solucao

Em `RpcInboundHandler`, substituir `_emitRequestAck` por um debouncer:

```dart
// Pseudocodigo
final _pendingAcks = <dynamic>[];
Timer? _ackFlushTimer;

Future<void> _scheduleAck(dynamic requestId) async {
  _pendingAcks.add(requestId);
  if (_pendingAcks.length >= ConnectionConstants.maxAckCoalesceBatch) {
    await _flushPendingAcks();
    return;
  }
  _ackFlushTimer ??= Timer(const Duration(milliseconds: 5), () {
    _ackFlushTimer = null;
    unawaited(_flushPendingAcks());
  });
}

Future<void> _flushPendingAcks() async {
  if (_pendingAcks.isEmpty) return;
  final ids = _pendingAcks.toList();
  _pendingAcks.clear();
  if (ids.length == 1) {
    await _emitRequestAck(ids.first);
  } else {
    final ackPayload = {
      'request_ids': ids.map((id) => id.toString()).toList(),
      'received_at': DateTime.now().toIso8601String(),
    };
    await _emitEvent('rpc:batch_ack', ackPayload);
  }
}
```

Cap de `maxAckCoalesceBatch` deve respeitar `HUB_MAX_BATCH_SIZE` (32).

### Impacto

- Reduz emits no canal `/agents` em **N→1** durante bursts
- Reduz custo de Socket.IO encoding (cada emit tem overhead fixo de
  packet framing)
- Em `mergeAll` de 8 agentes (cenario tipico Colmeia), cai de 8 acks para
  1 batch ack

### Gate

Medir o volume atual de `rpc:request_ack` apos item 1 entrar. Se
estiver < 100 acks/segundo em pico, o ganho e marginal. Acima disso,
vale.

---

## 4. Per-phase agent timings em `meta.agent_phases`

### Contexto

O hub ja shippou opt-in `requestServerTimings: true` que devolve
`meta.serverTimings.phasesMs` ao consumer com:

```
consumer_frame_decode_ms, relay_preflight_ms, encode_ms,
emit_to_socket_ms, agent_to_hub_ms, inbound_decode_ms,
pending_resolve_ms, relay_forward_to_consumer_ms
```

`agent_to_hub_ms` e calculado como `tInboundArrival - tEmitComplete`
(wall-clock). E uma **caixa preta** que inclui:

- Tempo de wire (agent socket → hub socket, ida e volta)
- Frame decode no agente (gzip + JSON parse + HMAC verify)
- SQL queue wait (`SqlExecutionQueue` backpressure)
- ODBC roundtrip
- Frame encode no agente (JSON stringify + gzip + HMAC sign)

Para investigar regressoes nao basta saber que `agent_to_hub_ms = 800ms`:
precisa saber se foi ODBC (160ms = ok), SQL queue (640ms = saturacao do
agente) ou serialize (320ms = blob enorme).

### Solucao

Quando o request vier com `meta.requestServerTimings: true`, o agente
anexa `meta.agent_phases` na resposta:

```json
{
  "meta": {
    "agent_phases": {
      "schema_version": 1,
      "phases_ms": {
        "frame_decode_ms": 0.8,
        "schema_validate_ms": 0.4,
        "signature_verify_ms": 1.2,
        "queue_wait_ms": 5.0,
        "dispatch_ms": 0.3,
        "db_execute_ms": 142.5,
        "result_serialize_ms": 4.7,
        "frame_encode_ms": 2.1,
        "signature_sign_ms": 1.0
      }
    }
  }
}
```

Hub side: estender `BridgeLatencyTraceSession.addPhaseMs` para mergear
o `agent_phases.phases_ms` no snapshot final, prefixados com `agent_`.

### Implementacao no agente

- `RpcInboundHandler.handleRequest`: detectar
  `requestMap.meta?.requestServerTimings == true`, instanciar um
  `AgentLatencyTrace` e passar atraves do `_dispatcher.dispatch`.
- `RpcResponsePreparer.prepareForSend`: se trace presente, mergear em
  `meta.agent_phases`.
- Schema: estender `rpc.response.schema.json` para aceitar
  `meta.agent_phases` opcionalmente.

### Impacto

Habilita a coluna "agent_to_hub" do runbook
`socket_perf_investigation.md` Step 4 a ser quebrada em sub-fases
acionaveis. Sem isso, qualquer regressao no agente vira "alguma coisa
ficou lenta" — com isso, vira "ODBC subiu p95 de 80 ms pra 240 ms,
investigar driver".

### Gate

Confirmar que item 4 do hub (ja shippado, ver
[02_no_change_items.md](02_no_change_items.md)) esta sendo usado em
producao. Hoje e opt-in dos consumers — se ninguem usa, o agent-side
nao adiciona valor.

---

## 5. `agent.getHealth` piggyback em respostas RPC

### Contexto

Hoje o hub chama `agent.getHealth` periodicamente (intervalo varia por
deployment) para detectar agentes lentos / em circuit-breaker. Cada
chamada e um round-trip dedicado.

Se o agente piggybackasse um snapshot de saude (`sql_queue_pressure`,
`active_streams`, `circuit_state`) em **toda Nth resposta** RPC, o hub
poderia atualizar o modelo sem chamadas dedicadas.

### Solucao

- Adicionar `meta.agent_health_snapshot` opcional nas respostas, com
  `freshness_threshold_ms` para a hub saber quando ignorar (e.g. so
  considera snapshots gerados < 30 s atras).
- Negociar via extensao `healthPiggyback: { intervalRequests: 50 }` no
  `agent:capabilities`.
- Hub: ao ver `meta.agent_health_snapshot`, atualizar `agentRegistry` e
  pular a proxima poll dedicada.

### Impacto

- Reduz emits de `agent.getHealth` em ~ N×, onde N e o intervalo de
  piggyback.
- Reduz CPU no agente (avaliacao de health roda piggyback em
  oportunismo, nao em RPC dedicada).
- Acelera deteccao de degradacao do agente (uma resposta normal ja
  carrega o sinal).

### Esforco

Medium — exige (a) schema novo, (b) campo opcional no agent registry do
hub, (c) logica de skip-next-poll no scheduler de health do hub.

### Gate

Verificar volume atual de `agent.getHealth` em producao. Se < 1/minuto
por agente, o ganho e baixo.

---

## 6. Tunable `recommendedStreamPullWindowSize` + default > 1

### Contexto

```68:69:../plug_agente/lib/domain/protocol/protocol_capabilities.dart
'recommendedStreamPullWindowSize': recommendedStreamPullWindowSize ?? 1,
'maxStreamPullWindowSize': maxStreamPullWindowSize ?? ConnectionConstants.maxBackpressureChunkQueueSize,
```

O agente anuncia `recommendedStreamPullWindowSize = 1` por defeito. O
hub respeita esse hint (`RECOMMENDED → effective`) ao iniciar a janela
de credits para `rpc:stream.pull`. Resultado: cada chunk e um round-trip
de pull dedicado.

Para 100 chunks de uma query streaming: **100 round-trips de pull**
quando 6-12 round-trips em paralelo seriam suficientes para saturar a
banda.

### Solucao

- Aumentar default para `8` ou `16` (mantendo `maxStreamPullWindowSize`
  como teto seguro).
- Expor env `AGENT_STREAM_PULL_WINDOW_RECOMMENDED` para tunar por
  deployment.
- Documentar no `agent_perf` guidance que devices em LAN fast podem subir
  para `32` sem risco; devices em mobile celular devem ficar em `4-8`
  para nao exaurir RAM em backpressure.

### Impacto

Latencia de streaming relay cai aproximadamente
`(N_chunks - window) × per_pull_RTT`. Para N=100, window=8, RTT=20 ms:
~1.8 s de melhora por query streaming.

### Esforco

Trivial — uma constante.

### Gate

Capturar baseline com window=1 (atual). Comparar com window=8 em load
test. Documentar no `agent_perf_guidance.md`.

---

## 7. Extension `clientRequestIdEcho: "v1"` (Opcao A)

Ja documentado em [`01_relay_body_id_echo.md`](01_relay_body_id_echo.md).

Resumo: hoje o hub reescreve `body.id` na borda hub→consumer (Opcao B,
ja shippado). Custo: ~50-200 µs por resposta relay (perde o
`canBypassReencode`). Se o agente passar a ecoar o `client_request_id`
ao inves do `hub_uuid`, o hub volta ao bypass. Acks precisam migrar para
`meta.requestId`.

**Quando reabrir**: quando o counter `plug_socket_relay_body_id_echo_total`
sustentar > 1 K/s em producao (i.e., o bypass perdido virou custo
mensuravel), OU quando observabilidade end-to-end por `client_request_id`
virar requirement.

---

## 8. Bug `prepareForSend` reescreve `meta.request_id`

Ver `rpc_response_preparer.dart:73`:

```dart
'request_id': response.id?.toString(),
```

Hoje funciona porque `response.id == request.id == hub_uuid == meta.request_id`
(o hub overwrites tudo para o mesmo valor). Apos item 7 (Opcao A),
**falharia**: `response.id` viraria `client_request_id`, mas
`meta.request_id` deveria continuar sendo `hub_uuid` (o wire-level
correlator).

**Fix preventivo** (independente de item 7 shippar):

```dart
'request_id': request.meta?.requestId ?? response.id?.toString(),
```

Requer expor `request.meta` para o `prepareForSend` (hoje a funcao so
recebe `response`). Refactor pequeno.

### Esforco

Trivial — mas so faz diferenca depois do item 7.

---

## 9. Pre-warm de schema validators / JSON schemas no `agent:ready`

### Contexto

Schemas em `lib/infrastructure/validation/schemas/` sao carregados
lazily na primeira validacao. A primeira `rpc:request` apos reconnect
paga:
- Schema parse + compile
- JIT warmup do `JsonSchemaContractValidator`

Impacto p99 na **primeira resposta** apos cada reconnect (especialmente
em mobile com sleep/wake).

### Solucao

Em `app_initializer.dart` (ou onde o `agent:ready` e emitido), invocar
um warmup explicito:

```dart
await _schemaValidator.precompileAll();
// Aquecer pipeline cache com um payload sintetico
await _payloadFrameCodec.prepareOutgoing(event: 'rpc:response', logicalPayload: warmupSentinel);
```

### Impacto

Reduz p99 da primeira request apos reconnect. Nao afeta steady state.

### Esforco

Low-medium — depende de quanto refactor o codigo atual precisa para
expor um `precompileAll`.

### Gate

Medir `time_to_first_response_ms` apos reconnect em painel da Colmeia.
Se p99 > 500 ms, vale. Se < 200 ms, baixa prioridade.

---

## 10. Compressao brotli (negociar `br` em `compressions`)

### Contexto

Hoje o hub e o agente negociam apenas `gzip` e `none`. Brotli oferece
~10-20% melhor ratio que gzip a CPU comparavel para JSON.

### Custo

- Dart: precisa de pacote externo (`brotli` ou similar) ou platform
  channel. Nao e standard library.
- Node hub: brotli e built-in (`zlib.brotliCompress`).

### Impacto

Reducao de banda em ~10-20% para frames > 4 KiB que ja passam pelo
gzip. Em maioria de deployments locais (LAN/cabo) o ganho e
desprezivel; em mobile/3G pode ser sensivel.

### Esforco

High — package new dependency, codec change, negotiation, fallback path,
metric.

### Gate

Capturar baseline de **bytes-on-wire por request** em producao. Se o
volume de banda nao for problema (caso comum em LAN), nao vale o
esforco. Se for (mobile, fan-out massivo), reabrir.

---

## Itens **explicitamente recusados** (com motivo)

Mantidos aqui para que ideias recorrentes nao virem PRs sem leitura
previa:

- **Batch outbound de `rpc:response`** (varias respostas num array).
  O hub **rejeita** explicitamente arrays no `rpc:response` (ver
  `rejectRelayBatchResponse` em `rpc_bridge_agent_inbound.ts`). Quebra
  contrato.
- **Eliminar `RpcRequestGuard` replay cache.** Mesmo com hub-level
  idempotency, agente precisa de fallback local — multi-process /
  multi-replica do hub poderia mandar o mesmo `body.id` duas vezes via
  caminhos diferentes. Mantem como defesa em profundidade.
- **Reduzir `maxConcurrentRpcHandlers` para < 32.** Esse cap reflete o
  cap correspondente no hub (`SOCKET_RELAY_AGENT_MAX_INFLIGHT`). Mudar
  unilateralmente cria backpressure em um lado sem o outro saber. Se
  precisar, mudar **em coordenacao com o hub**.
- **Substituir Drift por Hive/Isar no idempotency store.** Sem evidencia
  de que SQLite e gargalo. Drift e estavel, testado, e suportado por todo
  fluxo de auditoria.

---

## Como medir antes de agir

Para cada item, seguir o
[`docs/runbooks/socket_perf_investigation.md`](../runbooks/socket_perf_investigation.md):

1. Capturar baseline com `requestServerTimings: true` em load
   representativo (≥ 100 samples, ≥ 5 runs).
2. Identificar fase dominante (Step 2-3 do runbook).
3. So agir nos itens onde a fase dominante alinha (Step 4):
   - Fase `agent_to_hub_ms` > 70% **e** suspeita de ack-retry-induced
     load → item 1
   - Fase `agent_to_hub_ms` > 70% **e** large-result workload → item 2
   - Fase `agent_to_hub_ms` > 70% **e** investigacao agent-side cega →
     item 4
   - Volume de pull > 50/seg por stream → item 6

## Onde discutir

- Itens marcados `🚨` (1, 2): podem ser tocados como bugs.
  Recomendado abrir issue no `plug_agente` linkando esta pagina.
- Itens com **Hub coord** (1, 4, 5, 7, 10): exigem PR coordenado.
  Recomendado spec doc no `plug_server` em `docs/adrs/` antes de codigo,
  seguindo o padrao do
  [`docs/adrs/0008-relay-batch-protocol.md`](../adrs/0008-relay-batch-protocol.md).
- Restante: PRs unilaterais no `plug_agente` apos coleta de baseline.

## Atualizacao desta pagina

Editar apenas quando:

- Um item entrar em planning (mover para "✅ shipping", linkar PR).
- Um item for descartado por nova evidencia (mover para "Itens
  recusados").
- Nova oportunidade identificada (adicionar nova linha + secao).

**Nao** transformar em changelog detalhado por sprint. O historico vai
no `CHANGELOG.md` dos repositorios.
