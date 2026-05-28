# Agent implementation status — entrega cross-repo

> **Audiencia.** Times do `plug_server` e `plug_agente`. Snapshot da
> entrega das melhorias propostas em
> [`03_performance_roadmap.md`](03_performance_roadmap.md) por parte do
> `plug_agente`. Atualizado a cada onda de entrega; **nao** e
> changelog detalhado por commit — o CHANGELOG canonico vive em
> `../../../plug_agente/CHANGELOG.md`.
>
> **Como esta pagina foi construida.** Audit cross-repo automatizado
> (2026-05-28) sobre o working tree do `plug_agente` em
> `D:\Developer\plug_database\plug_agente`. Conferiu:
> `lib/core/config/feature_flags.dart`,
> `lib/core/constants/connection_constants.dart`,
> `lib/domain/protocol/protocol_capabilities.dart`,
> `lib/infrastructure/external_services/transport/*.dart`,
> `lib/infrastructure/validation/schema_loader.dart`,
> `lib/infrastructure/external_services/socket_io_transport_client_v2.dart`,
> `test/**/*_test.dart`, `.env.example` e
> `docs/communication/socket_communication_standard.md`.
>
> **Como atualizar.** A cada nova onda de entrega do `plug_agente`:
> bumpa data + lista os arquivos tocados + atualiza os status de
> [`03_performance_roadmap.md`](03_performance_roadmap.md).

## TL;DR

**6 de 10** itens do roadmap entregues pelo `plug_agente` em 2026-05-28
no commit [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c)
(`perf(socket): align agent defaults with hub expectations + ack
coalescing`), ja em `origin/main`. 4 testes novos do lado do hub ja
capturam a interacao; **0 mudancas adicionais necessarias** no hub
para destravar os 6 itens em producao.

| status | itens | notas |
| ------ | ----- | ----- |
| ✅ shipped (commit [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c)) | 1, 2, 3, 6, 8, 9 | 6 de 10 |
| proposed (no active gate) | 4, 5, 7, 10 | aguardam baseline / ADR / requirement externo |

### Detalhes da entrega (commit `7923e38c`)

- **14 arquivos modificados** no `plug_agente` (lib + tests + docs +
  .env.example + CHANGELOG)
- **3 arquivos de teste tocados, 7 testes novos** cobrindo as mudancas
- **CHANGELOG do `plug_agente`** atualizado em `## Unreleased > ### Changed`
  com sub-bullets para cada item, citando o roadmap por numero
- **`.env.example`** ganhou `AGENT_STREAM_PULL_WINDOW_RECOMMENDED` (item 6)
  com guidance LAN/cabo (16-32) vs mobile/celular (4-8)
- **`docs/communication/socket_communication_standard.md`** atualizado
  (+69/-25 linhas) refletindo o novo contrato de pull window e acks
  coalescidos, plus nova subsecao "Ajustes 2026-05" consolidando todas
  as mudancas
- **Validacao no `plug_agente`**: `dart format`: 0 changed;
  `flutter analyze`: 0 issues; **`flutter test`: 3017 passed, 11
  skipped (E2E gated), 0 failed**.

> ℹ️ **Arquivos nao relacionados** (`installer/setup.iss` e
> `lib/core/constants/app_version.g.dart`) tinham apenas diffs de CRLF
> → LF (sem mudanca de conteudo); foram propositalmente excluidos do
> commit do roadmap para manter atomicidade. Podem ser limpos numa
> proxima passada por `git config core.autocrlf`.

## Itens entregues

### Item 1 — `enableSocketDeliveryGuarantees=true`

**Status:** ✅ shipped (`plug_agente` [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28)

**Por que era 🚨 bug:** o hub default `SOCKET_AGENT_ACK_RETRY_ENABLED=true`
com timeout de 1 s arma re-emit do `rpc:request` se nao receber
`rpc:request_ack`. O agente nao emitia ack por defeito → toda SQL relay
que durava `> 1 s` recebia re-emit desperdicado, com parse, validacao,
signature, dedup e dispatch duplicados.

**Implementacao:**

- `lib/core/config/feature_flags.dart:174` — default mudou de `false`
  para `true` com comentario explicito referenciando o roadmap item 1
- Teste novo em `test/core/config/feature_flags_test.dart` (`enforces
  socket delivery guarantees (ack/retry) by default`) cobrindo default,
  toggle e `resetToDefaults`

**Como validar em prod:** a hub deve ver
`plug_socket_bridge_ack_retry_attempts_total{channel="relay"}` cair
drasticamente apos rollout do agente. Counter ja existe no hub.

### Item 2 — `enableSocketStreamingChunks=true`

**Status:** ✅ shipped (`plug_agente` [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28)

**Por que era 🚨 bug:** mesmo com `enableSocketStreamingFromDb=true` (le
do ODBC em streaming), o resultado era bufferizado inteiro antes de
serializar em um unico `rpc:response`. Para queries grandes: memoria
sobe linearmente, encode/sign/gzip em burst, TTFB ruim.

**Implementacao:**

- `lib/core/config/feature_flags.dart:238` — default mudou de `false`
  para `true` com comentario explicito referenciando o roadmap item 2
- Teste atualizado em `test/core/config/feature_flags_test.dart` (`enables
  DB streaming and ordered chunk streaming by default`)
- Streaming so e ativado quando (a) `negotiatedExtensions.streamingResults
  == true` (hub avisa o suporte) e (b) resultado excede
  `HUB_STREAMING_ROW_THRESHOLD` (default 500) — pequenos resultados
  continuam como `rpc:response` unico

**Como validar em prod:** `plug_socket_relay_chunks_forwarded_total`
sobe; `event_loop_lag_ms` p99 do agente cai em workloads com queries
grandes; TTFB E2E observado pelo Colmeia melhora.

### Item 3 — Coalescing de `rpc:request_ack` em `rpc:batch_ack`

**Status:** ✅ shipped (`plug_agente` [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28)

**Implementacao:**

- `lib/infrastructure/external_services/transport/rpc_inbound_handler.dart`:
  - Novo `_pendingAckIds: List<String>` + `_ackFlushTimer: Timer?`
  - Novo `_scheduleAck(requestId)` substitui chamada direta a
    `_emitRequestAck`
  - Novo `_flushPendingAcks()` decide entre `rpc:request_ack`
    (single id, preserva wire shape legada) e `rpc:batch_ack`
    (`request_ids: [...]`, para bursts)
  - Novo `resetAckBuffer()` chamado no disconnect para nao vazar timer
- `lib/core/constants/connection_constants.dart`:
  - `rpcAckCoalesceFlushInterval = Duration(milliseconds: 5)` — debounce
  - `rpcAckCoalesceMaxBatch = 32` — alinhado com `HUB_MAX_BATCH_SIZE`
- 4 testes novos no describe `rpc:request_ack coalescing (B2)` em
  `rpc_inbound_handler_test.dart`:
  1. Single emite `rpc:request_ack` apos flush window
  2. Burst (3 requests) coalesce em `rpc:batch_ack`
  3. Delivery guarantees off → 0 acks emitidos
  4. `resetAckBuffer` descarta pendings sem emit

**Como validar em prod:** volume de eventos `rpc:request_ack` cai;
volume de `rpc:batch_ack` sobe em workloads com bursts.

### Item 6 — `recommendedStreamPullWindowSize` default > 1

**Status:** ✅ shipped (`plug_agente` [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28)

**Implementacao:**

- `lib/core/constants/connection_constants.dart:395-411`:
  - `defaultRecommendedStreamPullWindowSize = 8` (era `1`)
  - Getter `recommendedStreamPullWindowSize` le env
    `AGENT_STREAM_PULL_WINDOW_RECOMMENDED`, clamp para
    `[1..maxBackpressureChunkQueueSize]`
- `lib/domain/protocol/protocol_capabilities.dart:67-69` — usa o getter
  no `agent:capabilities.extensions.recommendedStreamPullWindowSize`
- `.env.example` ganhou bloco documentando o env com guidance
  operacional:
  - LAN/cabo: pode subir para 16-32
  - mobile/celular: manter 4-8 para nao exaurir RAM em backpressure
  - default 8 e o sweet spot

**Como validar em prod:** latencia de streaming relay cai
proporcionalmente a `(N_chunks - window) * per_pull_RTT`. Para uma
query com 100 chunks e RTT 20 ms: ~1.8 s de melhora por query.

### Item 8 — Bug preventivo `prepareForSend`

**Status:** ✅ shipped preventivamente (`plug_agente` [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28)

**Por que preventivo:** hoje `body.id == response.id == meta.requestId
== hub_uuid` (todos sao o mesmo valor). A reescrita atual em
`prepareForSend` (`'request_id': response.id?.toString()`) e portanto
um no-op. Mas se o Item 7 (Opcao A do `clientRequestIdEcho`) shipar,
`response.id` viraria `client_request_id` enquanto `meta.request_id`
precisa continuar `hub_uuid`. O fix corrige isso AGORA para que o
shipping de item 7 nao precise tocar este arquivo.

**Implementacao:**

- `lib/infrastructure/external_services/transport/rpc_response_preparer.dart:64-82`:
  - Le `existingMeta['request_id']` propagado por `attachRequestTrace`
  - Usa esse valor preferencialmente; fallback para
    `response.id?.toString()`
- Teste novo em `rpc_response_preparer_test.dart` (`preserves propagated
  meta.request_id when it differs from response.id`) — usa
  `RpcProtocolMeta(requestId: 'hub-uuid-1')` e `id: 'client-req-42'`
  para garantir que o fix funciona como esperado quando item 7 entrar

### Item 9 — Pre-warm de schema validators

**Status:** ✅ shipped (`plug_agente` [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28)

**Implementacao:**

- `lib/infrastructure/validation/schema_loader.dart:170-194`:
  - Novo `_warmupHotSchemas()` chamado ao fim de `loadAll()`
  - Exercita `validate(<>)` em 6 schemas hot (`payload-frame`,
    `rpc.request`, `rpc.response`, `rpc.error`, `rpc.batch.request`,
    `rpc.batch.response`)
  - Best-effort — falhas de validacao (esperadas em schemas com
    required) sao engolidas com `on Object { /* swallow */ }`. Objetivo
    e wall-clock warmup, nao validacao correta
- Schemas ja eram compilados eagerly no boot via `service_locator.dart`
  — esta extensao apenas paga o custo JIT/inline-cache da primeira
  chamada

**Como validar em prod:** `time_to_first_response_ms` apos reconnect cai
no agente. Sem regressao no resto.

## Itens NAO entregues (4 de 10)

### Item 4 — Per-phase agent timings em `meta.agent_phases`

**Status:** proposed (no active gate)

**Bloqueio:** item 4 ja shippado no lado do hub (counter
`plug_socket_relay_server_timings_opt_in_total` existe), mas adocao
real ainda baixa. Reabre quando o Colmeia ou outro consumer comecar a
opt-in com `requestServerTimings: true` em volume e a fase
`agent_to_hub_ms` virar o gargalo dominante (>70% do total) sem cause
identificada. Ai vale o esforco do schema novo + plumbing por dispatch
no agente.

### Item 5 — `agent.getHealth` piggyback

**Status:** proposed (no active gate)

**Bloqueio:** sem evidencia de que `agent.getHealth` polls sejam custo
significativo hoje. Reabre se observado > 1 poll/segundo por agente em
prod ou se a deteccao de degradacao precisar ser sub-segundo (hoje e
N segundos = intervalo de poll).

### Item 7 — Extension `clientRequestIdEcho: "v1"` (Opcao A)

**Status:** proposed (no active gate). **ADR 0009 aberto.**

**Bloqueio:** o hub ja paga o custo da reescrita de `body.id` (Opcao B).
ADR 0009 documenta as 3 condicoes para reabrir:

1. `plug_socket_relay_body_id_echo_overhead_avg_ms` sustentado `> 0.5 ms`
   em pico (medido em janela p95);
2. `plug_socket_relay_body_id_echo_total` sustentado `> 1 K/s` em pico;
3. requirement externo (auditoria, conformidade, novo cliente) que
   exija `client_request_id` visivel nos logs do agente.

Status atual em dev: counter incrementa ~1:1 com relay unary; overhead
medido pelo bench `scripts/bench-relay-body-id-echo.ts` em 50-300 us
para payloads tipicos (10-100 KB). Sem requirement externo. **Nao
acionar ainda.**

**Lado bom:** o item 8 ja foi shippado preventivamente, entao quando
item 7 acionar, o agent-side fica menor.

### Item 10 — Compressao brotli

**Status:** proposed (no active gate)

**Bloqueio:** Dart nao tem brotli na standard library (precisa de
pacote externo ou platform channel). Sem evidencia de banda como
gargalo nos deployments atuais (LAN/cabo principalmente). Reabre se
volume de bytes-on-wire por request virar problema mensuravel em
mobile/3G.

## Acoes pendentes (post-entrega do agente)

1. ~~**`plug_agente` precisa commitar e pushar**~~ ✅ **Feito em
   [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c)
   (2026-05-28).** Commit unico cobrindo os 6 itens do roadmap. Arquivos
   com diff apenas de CRLF (`installer/setup.iss`,
   `app_version.g.dart`) foram propositalmente excluidos.
2. **`plug_server` deve validar em ambiente de teste** apos o release
   do agente que:
   - `plug_socket_bridge_ack_retry_attempts_total{channel="relay"}` cai
     proximo a zero (item 1)
   - Latencia de streaming relay cai (item 6)
   - `event_loop_lat_ms` p99 melhora em queries grandes (item 2)
3. **Quando o agente release shipar em prod**, atualizar a coluna
   Status em [`03_performance_roadmap.md`](03_performance_roadmap.md)
   de `shipped (commit 7923e38c)` para `shipped (released vX.Y.Z)`
   apontando para o tag/release do GitHub.
4. **Acompanhar os 4 itens em `proposed (no active gate)`** (4, 5, 7,
   10) — reabrir quando o gate especifico de cada um trip (ver seca
   "Itens NAO entregues" abaixo).

## Historico de atualizacoes

| data | autor | mudanca |
| ---- | ----- | ------- |
| 2026-05-28 | hub audit | criacao inicial; snapshot dos 6 itens entregues + 4 pendentes (working tree) |
| 2026-05-28 | hub audit | atualizado para refletir commit [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) shipado em `origin/main` |
