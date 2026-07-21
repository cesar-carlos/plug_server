# Changelog

Todas as mudancas notaveis neste projeto serao documentadas aqui.

O formato segue orientacoes de [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

## [Unreleased]

### Fixed (Auditoria de comunicação plug_agente ↔ plug_server — 2026-07-07)

Correções e melhorias de observabilidade/negociação identificadas no audit
cross-repo de alinhamento hub × agente:

- [`relay_route_response_forwarder.ts`](src/presentation/socket/hub/relay/relay_route_response_forwarder.ts):
  quando o job outbound do relay falha no encode/emit, a hub emite
  best-effort um frame de erro sintético JSON-RPC (`BRIDGE_OUTBOUND_PROCESSING_FAILED`,
  `retryable: true`) para o consumer antes de propagar o erro — evita hang
  silencioso após timeout cancelado.
- Mesmo forwarder: respostas de agente que chegam após timeout da rota
  (`timedOut === true`) agora incrementam
  `plug_socket_relay_late_response_after_timeout_total` (mantém o discard
  existente).
- Gate defensivo de `meta.agent_phases`: o hub remove `meta.agent_phases` do
  payload relay quando o agente **não** negociou `agentPhaseTimings: "v1"`,
  mesmo que o agente envie o campo (complementa o auto-gate agent-side; ver
  ADR 0012).
- [`agent_register.handler.ts`](src/presentation/socket/hub/handlers/agent_register.handler.ts):
  contador de adoção `plug_agent_parallel_batch_dispatch_negotiated_total`
  no registro de agente (visibilidade apenas — dispatch continua 100% no
  agente).
- Métricas novas em [`socket_consumer.metrics.ts`](src/shared/metrics/socket_consumer.metrics.ts)
  + [`socket_agent.metrics.ts`](src/shared/metrics/socket_agent.metrics.ts),
  expostas em [`metrics_renderer.ts`](src/presentation/http/controllers/metrics_renderer.ts).
- Lint: tipo de retorno explícito em
  [`plug_agente_live_server.e2e.test.ts`](tests/e2e/flows/plug_agente_live_server.e2e.test.ts).

**Documentacao:**

- [`docs/plug_agente/communication_sync_plug_agente.md`](docs/plug_agente/communication_sync_plug_agente.md) — tabela de alinhamento atualizada (2026-07-07).
- [`docs/socket/socket_relay_protocol.md`](docs/socket/socket_relay_protocol.md) — late-response, outbound failure sintetico, gate `meta.agent_phases`.
- [`docs/observability/observability.md`](docs/observability/observability.md) — metricas e alertas PromQL novos.

**Tests:**

- Novo [`relay_route_response_forwarder.test.ts`](tests/unit/presentation/socket/hub/relay_route_response_forwarder.test.ts)
  (late-response metric, synthetic error frame, strip/preserve de
  `meta.agent_phases`).
- [`socket_agent.metrics.test.ts`](tests/unit/shared/metrics/socket_agent.metrics.test.ts):
  contador `parallelBatchDispatchNegotiatedTotal`.
- Novo [`agent_register.handler.test.ts`](tests/unit/presentation/socket/hub/agent_register.handler.test.ts):
  adoção de `parallelBatchDispatch` no `agent:register`.
- Caso edge no forwarder: encode sintético também falha → consumer sem resposta,
  métrica `relayOutboundJobFailureNotifiedTotal` permanece em 0.

### Added (E2E: live hub suite — 2026-07-07, commit `c2a37de`)

- Suíte E2E opcional gated por `E2E_LIVE_AGENT_ID` em
  [`tests/e2e/flows/plug_agente_live_server.e2e.test.ts`](tests/e2e/flows/plug_agente_live_server.e2e.test.ts):
  exercita REST/Socket bridge e paginação de `sql.execute` (page + cursor)
  contra um agente real conectado ao hub.

### Fixed (Docs/infra: Swagger UI hardening — 2026-07-06, commit `98eb1d2`)

- Resolve páginas em branco do Swagger UI por conflito CSP/Helmet e race
  condition de `onload`.
- Serve assets versionados via Nginx com `gzip_static`.
- Sincronização automática no install.

### Performance (hub-agent performance plan P0–P5 — 2026-06-24, commit `7742faa`)

- Negociação de `parallelBatchDispatch` no canal agente.
- Health poll scheduler opcional.
- Scripts de baseline/audit de performance.
- Documentação de migração de canal.

### Fixed (Relay unary fast-path — JSON-RPC 2.0 §5 body.id echo)

Resposta ao defeito reportado pelo cliente Colmeia em
`D:\Developer\Flutter\colmeia\docs\server_adjustments\relay_unary_fast_path.md §1`:
a hub estava sobrescrevendo `body.id` da resposta relay com o `requestId`
interno (UUID gerado pela hub), violando JSON-RPC 2.0 §5. No fluxo legado
de 3 eventos isso era contornado pelo mapping em `relay:rpc.accepted`,
mas com `fastPath: true` o consumer ficava sem como rotear a resposta de
volta ao pending — `agent_sql_bridge_e2e_test.dart` ia de **7 s → 278 s**
(3 retries por SQL antes de sobreviver via cache).

**Mudancas:**

- [`rpc_bridge_agent_inbound.ts`](src/presentation/socket/hub/relay/rpc_bridge_agent_inbound.ts):
  novo `shouldEchoClientBodyId` no forwarder; quando `clientRequestId !==
  responseId` o bypass `encodeRelayOutboundFrameFromBytes` e sacrificado
  para reescrever `body.id` no payload do agente antes do encode final.
  Helper `resolveOutboundBodyId` aplica a mesma logica nas funcoes
  sinteticas de erro (`createRelayDecodeFailurePayload`,
  `createRelayUnexpectedFailurePayload`,
  `createRelayBatchResponseUnsupportedPayload`) e no caminho de erro de
  capacidade de stream. `correlation_id` continua referenciando o
  `requestId` da hub para diagnostico ops.
- [`rpc_bridge_relay_stream.ts`](src/presentation/socket/hub/relay/rpc_bridge_relay_stream.ts):
  `emitRelayTimeoutResponse` reescreve `body.id` para `clientRequestId`
  quando disponivel — sem isso, consumers em `fastPath: true` nunca
  conseguiam casar o timeout sintetico com o pending original.
- [`rpc_bridge_dispatch_relay.ts`](src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay.ts):
  caminho de erro pos-dispatch (waiters de idempotency) tambem reescreve
  `body.id` para `clientRequestId`.
- [`socket_consumer.metrics.ts`](src/shared/metrics/socket_consumer.metrics.ts) +
  [`metrics_renderer.ts`](src/presentation/http/controllers/metrics_renderer.ts):
  novo counter `plug_socket_relay_body_id_echo_total` para acompanhar
  adocao (deve trackear ~1:1 com respostas relay unary; cai a ~0 se/quando
  a extensao agent-side `clientRequestIdEcho` shipar, Opcao A).

**Documentacao:**

- [`docs/socket_relay_protocol.md`](docs/socket_relay_protocol.md) — secao
  "Correlacao de IDs no relay" atualizada para descrever a reescrita;
  secao "Relay unary fast-path" deixa explicito que `body.id` da resposta
  carrega o `client_request_id`.
- Nova pasta [`docs/plug_agente/`](docs/plug_agente/) orientando o time do
  agente: `README.md` (overview dos 4 itens),
  `01_relay_body_id_echo.md` (motivacao + Opcao B atual + Opcao A
  opcional via negociacao `clientRequestIdEcho` + tres diagramas mermaid
  de sequencia comparando os fluxos),
  `02_no_change_items.md` (itens 1, 2 e 4 — sem mudanca no agente),
  `03_performance_roadmap.md` (oportunidades cross-repo priorizadas por
  impacto/esforco com coluna **Status** rastreavel, incluindo dois bugs
  de defaults divergentes hub × agente).
- Cross-link em [`docs/communication_sync_plug_agente.md`](docs/communication_sync_plug_agente.md)
  apontando para a nova pasta como porta de entrada quando uma mudanca
  no contrato afetar o `plug_agente`.

### Added (relay fast-path observability + deployment knobs)

Complementos ao fix do fast-path:

- Novo env [`SOCKET_RELAY_FAST_PATH_FORBIDDEN`](src/shared/config/env.ts)
  (default `false`): quando `true`, a hub ignora `fastPath: true` em
  envelopes `relay:rpc.request` inbound e forca o fluxo legado de 3
  eventos. Util em deployments com requirements de auditoria /
  compliance que dependem do `relay:rpc.accepted` explicito.
- Novo counter `plug_socket_relay_fast_path_forbidden_total`: incrementa
  quando o env acima trip nega um opt-in de consumer. Permite observar a
  configuracao via Prometheus.
- Novo histograma-pares `plug_socket_relay_body_id_echo_overhead_sum_ms`
  + `_max_ms` + `_avg_ms` (derivado): quantificam o custo CPU da
  reescrita de `body.id` que sacrifica `canBypassReencode`. Pareados com
  `bodyIdEchoTotal`, formam o gate para a futura Opcao A (ver
  [`docs/adrs/0009-client-request-id-echo.md`](docs/adrs/0009-client-request-id-echo.md)).
  Sintetizados em [`rpc_bridge_agent_inbound.ts`](src/presentation/socket/hub/relay/rpc_bridge_agent_inbound.ts)
  via novo helper `observeRelayBodyIdEchoOverhead(elapsedMs)`.
- Novo log estruturado `relay_body_id_rewritten` gated em
  `logger.isLevelEnabled("debug")` para facilitar diagnostico em
  desenvolvimento (zero custo em producao com level=info).

### Added (relay fast-path documentation)

- Novo [`docs/adrs/0009-client-request-id-echo.md`](docs/adrs/0009-client-request-id-echo.md)
  formaliza a Opcao A (negociacao `clientRequestIdEcho: "v1"`) como
  roadmap. Define gates de reabertura, mudancas requeridas em ambos os
  repos, alternativas consideradas (rejeitadas) e criterios de
  aceitacao para o v1.
- [`docs/relay_fastpath_study.md`](docs/relay_fastpath_study.md) atualizado
  com status `SHIPPED` e secao "Resultado" linkando para o cliente
  Colmeia + metricas pos-fix.
- [`docs/socket_relay_protocol.md`](docs/socket_relay_protocol.md) ganhou
  secao "Caso degenerate: consumer sem `id` JSON-RPC" com tabela
  documentando o comportamento esperado em todos os edge cases
  (`id` omitido, `id: null`, numero, string, metodo invalido).
- [`docs/plug_agente/01_relay_body_id_echo.md`](docs/plug_agente/01_relay_body_id_echo.md)
  ganhou tres diagramas mermaid de sequencia (antes, depois Opcao B,
  futuro Opcao A) para acelerar leitura cross-team.

### Added (tests + benchmark)

- Novo cross-module test
  [`tests/unit/presentation/socket/hub/relay_fast_path_body_id_echo.e2e.test.ts`](tests/unit/presentation/socket/hub/relay_fast_path_body_id_echo.e2e.test.ts)
  exercita **handler → dispatch → registries → inbound forwarder** como
  uma chain integrada (sem Socket.IO server, sem Redis). Valida:
  - `rpc:request` ao agente carrega `body.id = hub_uuid` (contrato
    agent-side preservado);
  - `relay:rpc.response` ao consumer carrega
    `body.id = client_request_id` (JSON-RPC 2.0 §5);
  - `bodyIdEchoTotal` incrementa e `bodyIdEchoOverhead*` >= 0;
  - quando `clientRequestId` esta ausente, metrica fica em 0 e o
    fallback usa o `requestId` interno.
- Novos testes em [`relay_rpc_request.handler.test.ts`](tests/unit/presentation/socket/consumers/relay_rpc_request.handler.test.ts)
  cobrindo `SOCKET_RELAY_FAST_PATH_FORBIDDEN`: env on strip-a o flag,
  conta `fastPathForbiddenTotal` e nao conta quando o consumer nao
  pediu fast-path.
- Novo script
  [`scripts/bench-relay-body-id-echo.ts`](scripts/bench-relay-body-id-echo.ts)
  (gated por `BENCH=1`) compara o custo CPU do caminho echo (parse +
  mutate + re-encode) vs o bypass (`encodePayloadFrameFromBytes`) em
  payloads de 1 KB a 1 MB. Resultado tipico medido em dev: +6 µs em
  1 KB (~800%), +56 µs em 10 KB (~84%), +314 µs em 100 KB (~48%),
  +3.77 ms em 1 MB sem gzip. Fornece o numero concreto para o gate de
  reabertura do ADR 0009.

### Fixed (typo na pasta de docs)

- Renomeado `docs/pug_agente/` -> `docs/plug_agente/` (typo na criacao
  da pasta). Todos os comentarios em codigo, testes, CHANGELOG e docs
  atualizados.

### Added (cross-repo sync — entrega `plug_agente` 2026-05-28)

Audit cross-repo confirmou que **6 dos 10 itens** do roadmap
`docs/plug_agente/03_performance_roadmap.md` foram implementados em
uma unica onda no `plug_agente` — commit
[`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c)
(`perf(socket): align agent defaults with hub expectations + ack
coalescing`), ja em `origin/main`, validado com `flutter test` (3017
passed, 0 failed). Itens shippados: **1**
(`enableSocketDeliveryGuarantees=true`), **2**
(`enableSocketStreamingChunks=true`), **3** (coalescing de
`rpc:request_ack` em `rpc:batch_ack`), **6**
(`recommendedStreamPullWindowSize 1→8` + env
`AGENT_STREAM_PULL_WINDOW_RECOMMENDED`), **8** (fix preventivo no
`prepareForSend` preservando `meta.request_id`) e **9** (pre-warm de
schema validators em `TransportSchemaLoader.loadAll()`).

Itens **4** (`meta.agent_phases` — ADR 0012), **5** (`agent.getHealth`
piggyback — ADR 0011) e **7** (`clientRequestIdEcho` — ADR 0009) foram
shippados em 2026-06-24 (hub [`560ef2f`](https://github.com/cesar-carlos/plug_server/commit/560ef2f),
agente [`741b5677`](https://github.com/cesar-carlos/plug_agente/commit/741b5677)).
Apenas o item **10** (brotli) permanece `proposed (no active gate)`
aguardando evidência de banda como gargalo.

Mudancas no hub:

- Nova pagina
  [`docs/plug_agente/04_agent_implementation_status.md`](docs/plug_agente/04_agent_implementation_status.md)
  consolida o relatorio do audit: arquivos tocados no `plug_agente`,
  testes adicionados, instrucoes de validacao em prod, e acoes
  pendentes (commit / push / release / monitoramento de metricas).
- [`docs/plug_agente/03_performance_roadmap.md`](docs/plug_agente/03_performance_roadmap.md)
  atualizado com coluna `Status` reformatada e refs precisas para o
  `04`. Itens nao entregues agora marcados `proposed (no active gate)`
  com gate explicito.
- [`docs/plug_agente/README.md`](docs/plug_agente/README.md) ganhou um
  5o passo no guia de leitura linkando para o `04`.

**Tests:**

- [`tests/unit/presentation/socket/hub/rpc_bridge_agent_inbound.test.ts`](tests/unit/presentation/socket/hub/rpc_bridge_agent_inbound.test.ts)
  novo describe `client_request_id echo (JSON-RPC 2.0 §5 / fast-path)`
  com 3 testes (echo basico, fallback sem `clientRequestId`, echo no
  erro sintetico). Teste existente
  `rejects relay batch rpc responses per consumer without leaking
  original payloads` ajustado para validar a reescrita.
- [`tests/unit/presentation/socket/hub/rpc_bridge_relay_stream.test.ts`](tests/unit/presentation/socket/hub/rpc_bridge_relay_stream.test.ts)
  o teste de `emitRelayTimeoutResponse` agora decoda o frame e valida
  que `body.id === clientRequestId` e que `envelope.requestId` continua
  sendo o UUID da hub.

**Compat:**

- Zero mudanca de contrato no canal `/agents`. O agente continua
  recebendo `body.id = hub_uuid` e responde com o mesmo valor. A
  reescrita acontece **so na borda hub→consumer**.
- Para consumers que ja estavam no fluxo de 3 eventos: continua
  funcional. A reescrita simplesmente entrega `body.id` igual ao
  `client_request_id` que o `relay:rpc.accepted` ja indicava — nenhum
  consumer existente quebra.

### Performance (Generous profile — Onda A/B: capacity headroom)

Resposta ao perfil "generoso com os limites": eliminacao de chokepoints de
configuracao detectados pos-Sprints P1-P4 (Redis hardening). O foco e abrir
headroom de **capacidade** sem afrouxar safety nets reais (buffers, queue
caps, rate-limits criticos permanecem ativos).

**Onda A — `.env` apenas (sem mudanca de codigo):**

- **Postgres pool** ([`.env`](.env) `DATABASE_URL`): `connection_limit=15→40`, `pool_timeout=20→45`. Ajustar `max_connections` do Postgres em paralelo.
- **Queue waits** (`SOCKET_RELAY_AGENT_QUEUE_WAIT_MS`, `SOCKET_REST_AGENT_QUEUE_WAIT_MS`): `200→2000` ms. Bursts esperam 2s antes do `503`, evitando retry storm.
- **Outbound overload shedding** (`SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG`, `_P95_MS`): `200/250→0/0`. Desliga shedding por backlog/p95 — buffers e queue caps continuam protegendo.
- **Per-conversation pending** (`SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONVERSATION`): `32→256`. Alinhado com `_PER_CONSUMER=1024`.
- **JWT verify cache** (`JWT_VERIFY_CACHE_TTL_MS`, `_MAX_SIZE`): defaults `30s/2k → 120s/20k`. Hits ainda revalidam `exp`.
- **Swagger em producao** (`SWAGGER_ENABLED`): `true→false`. Operadores habilitam temporariamente quando precisam.
- **Profile sync concurrency** (`SOCKET_AGENT_PROFILE_SYNC_MAX_CONCURRENT`): `8→32`. Reconnect storm de ~60 agentes converge mais rapido.
- **Custom publish inflight** (`SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET`): `128→512`. Alinhado com `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`.
- **Audit batching** (`SOCKET_AUDIT_BATCH_MAX`, `SOCKET_AUDIT_MAX_QUEUE`): `64/50000→192/200000`. Menos round-trips Prisma; queue absorve stalls.
- **Profile recipients cache** (`SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS`, `_MAX_SIZE`): `10s/5k→30s/15k`. Reduz pressao DB; bounded por revoke.
- **Self profile rate limit** (`REST_AGENTS_SELF_PROFILE_RATE_LIMIT_MAX`): default `20/min → 0` (unlimited).
- **Email outbox poll/batch** (`REGISTRATION_EMAIL_OUTBOX_POLL_INTERVAL_MS`, `_BATCH_SIZE`): `3000/25→1000/100`. Drena bursts de aprovacao mais rapido.

**Onda B — mudancas de codigo:**

- **Email outbox concurrency env-driven**: novo env `REGISTRATION_EMAIL_OUTBOX_WORKER_CONCURRENCY` (default `4` para back-compat). [`registration_email_outbox.service.ts`](src/application/services/registration_email_outbox.service.ts) substitui o `Math.min(4, ...)` hardcoded por `env.registrationEmailOutboxWorkerConcurrency`. Generous profile usa `8`.
- **Room reconcile parallel leave/join**: [`consumer_client_agent_room_reconcile.ts`](src/presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile.ts) calcula `roomsToLeave`/`roomsToJoin` e dispara cada conjunto via `Promise.all`. Antes: ~120 round-trips sequenciais por client por tick para ~60 agentes. Agora: 2 batches paralelos por client.
- **HTTP RED histogram buckets** ([`http_red.metrics.ts`](src/shared/metrics/http_red.metrics.ts)): adicionado `15`, `30` segundos. Tail latency de REST bridge / materialize agora cai em bucket nomeado em vez do implicito `+Inf`.
- **Agent event stream batch size buckets** ([`agent_event_stream_metrics.service.ts`](src/application/services/agent_event_stream_metrics.service.ts)): adicionado `2000`, `5000`. Cobre fan-out de rooms grandes (P1 `appendAgentEventFramesBatch`).

**Tests:**

- [`tests/unit/presentation/socket/hub/relay_outbound_queue.test.ts`](tests/unit/presentation/socket/hub/relay_outbound_queue.test.ts) ajustado: o teste de overload agora pinneja o threshold via `Object.defineProperty` para nao depender da config ativa (que pode ter shedding desligado).
- [`tests/unit/application/services/agent_event_stream_metrics.service.test.ts`](tests/unit/application/services/agent_event_stream_metrics.service.test.ts) cobre os novos buckets `2000`/`5000`.

**Validacao:**

- `tsc --noEmit`: green
- `eslint`: green
- `vitest run`: 1584 passed | 16 skipped (integration sem broker)

### Performance (Redis perf v1 — Sprints P1-P4: hot-path RTT reductions)

- **P1 — Stream fan-out pipelining (`MULTI/EXEC`)**: novo `appendAgentEventFramesBatch` em `src/infrastructure/redis/agent_event_stream.ts` empacota `XADD` (+ `PEXPIRE` opcional) por recipient num único `MULTI/EXEC`, reduzindo `2N` round-trips para **1 RTT** independente da contagem de recipients. `appendAgentEventFrame` continua exposto como wrapper de uma entry. `client_socket_event_publish.service.ts` chama o batch nos 3 modos (`await`/`timeout`/`fire_and_forget`).
- **P1 — Métricas batch**: novos `plug_agent_event_stream_batch_appends_total`, `plug_agent_event_stream_batch_partial_failures_total`, e histograma `plug_agent_event_stream_batch_size_bucket{le}` (buckets 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, +Inf).
- **P1 — Bench script**: novo `scripts/bench-stream-fanout.ts` (gated por `BENCH=1`) compara legacy concurrent `XADD` vs batch `MULTI/EXEC` para 10/50/200 recipients.
- **P2 — Atomic consume-or-rollback Lua**: novo script `SOCKET_RATE_LIMIT_CONSUME_OR_ROLLBACK_SCRIPT` em `src/infrastructure/redis/socket_rate_limit_redis.ts` retorna `[allowed, used]` num único `EVALSHA`, fundindo o `INCRBY+PEXPIRE` com o `DECRBY+DEL` quando `used > max`. Reduz **deny path de 2 RTTs para 1 RTT** (~50% p95). Pré-loaded via `LuaScriptCache`. O legacy `consume` script e `refundSocketRateLimitRedis` (refund externo pós-validação) ficam intactos.
- **P2 — Métricas atomic rollback**: novo counter `plug_socket_rate_limit_consume_atomic_rollbacks_total` distingue rollbacks atômicos do refund externo.
- **P3.1 — Init Redis paralelo**: `bootstrap()` em `src/server.ts` agora roda os 4 inits independentes (`initRestHttpRateLimitRedis`, `initSocketRateLimitRedis`, `initClientSocketEventPublishIdempotencyRedis`, `initAgentEventStream`) via `Promise.all`. Total wait de boot passa de `Σ(initᵢ)` para `max(initᵢ)` — ganho 2-4× em ambientes degradados onde 1 Redis está unreachable. ADR-0007 documenta a decisão.
- **P3.1 — Shutdown via `Promise.allSettled`**: `closeSocketIoRedisAdapter`, `closeClient...IdempotencyRedis`, `closeAgentEventStream`, `closeRestHttpRateLimitRedis`, `closeSocketRateLimitRedis` rodam concorrentemente; falhas individuais geram warning `redis_module_close_failed` sem bloquear o shutdown geral.
- **P3.2 — fetchSockets dedupe**: `countSocketsInRoom` aceita `captureSockets: true` e expõe `fetchedSockets` no `RoomRecipientCount`. Quando `AGENT_EVENT_STREAM_ENABLED=true`, o publish handler reutiliza os sockets capturados na contagem para extrair `recipientPrincipalIds` (1 cluster-RPC ao invés de 2). Path local-only ainda faz fetchSockets dedicado quando count não pagou a RPC. Novo counter `plug_socket_custom_event_publish_fetch_sockets_dedupes_total`.
- **P4.1 — Histogram bucket binary search**: `redis_command_latency_histogram.ts` substitui scan linear por busca binária no `findBucketIndex`. ~5 comparações → 4 no pior caso para os 11 buckets atuais; cumulativo é mensurável em ambientes high-throughput.
- **P4.2 — Pre-allocated arrays em snapshots**: `histogram.snapshot()` substitui `Array.prototype.map` por arrays pré-alocados (`new Array<T>(buckets.length)`), evitando realocações em cada metrics scrape.
- **P4.3 — Microbench in-process**: novo `scripts/redis-perf-bench.ts` (gated por `BENCH=1`) roda 100k iterations das hot paths (observe, snapshot, boundary lookup) e imprime p50/p95/p99 ns por chamada.
- **Docs**: nova ADR-0007 (parallel Redis init); seção de microbenchmarks em `docs/load_testing.md` com exemplos de uso e sinais de regressão.

### Added (Redis hardening v3 — Sprint 9: Observability + Quick wins)

- **AUTH ping metrics**: novo counter `plug_redis_auth_ping_total{module, outcome="ok|auth_error|other_error"}` em `redis_auth_ping_metrics.service.ts` instrumentado nos 2 factories (`instrumented_redis_client.ts` e `pubsub_instrumented_redis_client.ts`).
- **OpenTelemetry spans para comandos Redis**: novo helper `withRedisSpan` em `src/infrastructure/observability/redis_span.ts` com env `REDIS_OTEL_SPANS_ENABLED=false` (default off). Quando enabled junto com `OTEL_TRACES_ENABLED=true`, comandos hot-path (consume, refund, lock, unlock, extend, xadd) ganham spans nomeados `redis.<module>.<op>` com atributos PII-safe (`redis.module`, `redis.op`, `redis.key.prefix`).
- **Cluster topology validator unit tests**: cobertura unitária completa (`tests/unit/infrastructure/redis/cluster_topology_validator.test.ts`) — standalone short-circuit, cluster com slots iguais e diferentes, error swallowing, edge cases.
- **Spikes index**: novo `docs/spikes/_README.md` com triggers concretos para revisitar os 2 NO-GO existentes; `socket_rate_limit_redis_sliding.ts` ganha JSDoc TODO apontando para os triggers do Sprint 11.
- **Cross-links de docs**: `docs/configuration.md` e `src/infrastructure/redis/README.md` agora apontam para `docs/redis_security.md` e vice-versa.

### Changed (Redis hardening v3)

- **Rename API: `agentId` → `principalId`** nos módulos `agent_event_stream`, `agent_event_stream_cursor` e `agent_event_stream_drain`. Parâmetro positional, então **chamadas existentes funcionam sem mudança**. Logs e mensagens de erro também usam `principalId`. Key prefix `plug_agent_stream:` mantido para back-compat de dados em flight.

### Added (Redis hardening v3 — Sprint 10: Stream evolution)

- **`schemaVersion=1` em frames do stream**: `appendAgentEventFrame` injeta `schemaVersion="1"` em cada XADD; `parseStreamMessage` rejeita versões desconhecidas via `noteAgentEventStreamDropped()`. Frames legacy sem `schemaVersion` são aceitos (back-compat).
- **Consumer groups (opt-in)**: novo env `AGENT_EVENT_STREAM_USE_CONSUMER_GROUPS=false` (default off) + `AGENT_EVENT_STREAM_CONSUMER_GROUP=plug_hub`. Quando ativado, `XGROUP CREATE MKSTREAM` é emitido lazy (BUSYGROUP swallowed); reads via `XREADGROUP GROUP plug_hub <replicaId>` e acks via `XACK`. Cross-replica drain de mesmo principalId fica coordenado.
- **Backpressure dual-mode**: nova env `AGENT_EVENT_STREAM_APPEND_MODE` com 3 modos:
  - `await` (default): publish bloqueia até todos appends resolverem (preserva at-least-once).
  - `timeout`: race contra `AGENT_EVENT_STREAM_APPEND_TIMEOUT_MS=50` por append; publish não espera além do timeout.
  - `fire_and_forget`: appends nunca bloqueiam o publish; falhas só aparecem em métricas/logs.

### Added (Redis hardening v3 — Sprint 11: URL/Topology flexibility)

- **Sentinel/multi-host URL resolver**: novo `src/infrastructure/redis/redis_url_resolver.ts` parseando `redis-sentinel://`, `rediss+sentinel://` e URLs `redis://` com múltiplos hosts. Aplicado em `buildResilientRedisClientOptions` com warning logado uma vez por shape detectado.
- **Read-replica para idempotency `getEntry`**: nova env `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_READ_URL` (default vazio = primary). Quando set, `getEntry` consulta o réplica enquanto writes (`setEntry`/`acquireLock`/`extendLock`/`releaseLock`) seguem para o primary. Tolerante a lag de replicação porque o re-read pós-lock acontece via primary.
- **Boundary-burst telemetry**: novos counters `plug_socket_rate_limit_window_resets_total` e `plug_socket_rate_limit_window_saturations_total` em `socket_rate_limit_redis_metrics.service.ts`. Sustained `saturations / resets > 0.5` em escopo com `windowMs >= 60s` é o trigger para revisitar a decisão NO-GO do sliding-window (`docs/spikes/sliding_window_rate_limit.md`).

### Added (Redis hardening v3 — Sprint 12: Multi-tenancy + Cluster ops)

- **Multi-tenancy via `REDIS_TENANT_ID`**: nova env opt-in (default vazio = single-tenant; valores `[A-Za-z0-9_-]{1,32}`). Quando set, todos os 5 módulos Redis injetam `<tenantId>` dentro do hash tag (ex: `plug_socket_rl:{plug}:acme:scope:user`), garantindo isolamento hard sem cross-tenant slot collision. Novo helper `redis_key_namespace.ts` centraliza a lógica. ADR-0006 documenta a decisão.
- **Cluster migration runbook**: novo `docs/runbooks/redis_cluster_migration.md` com 5 phases (pre-flight, stage rollout, cutover, rollback, decommission) + checklist de observabilidade.
- **Cluster readiness check CLI**: novo `scripts/redis-cluster-readiness-check.ts` valida `cluster_enabled`, single-slot dos prefixos plug, INCRBY+PEXPIRE, SCRIPT LOAD+EVALSHA e XADD+XLEN antes do cutover. Exit code 0 = ready.

### Added (Redis hardening v2 — Sprint 5: Streams Phase 2 wiring)

- **Backlog cross-replica live**: `client:custom.*` agora persiste cada frame no stream durável por destinatário e drena no `socket:event.subscribe` após reconexão. Default off via `AGENT_EVENT_STREAM_ENABLED=false`. Novo módulo `src/presentation/socket/hub/agent_event_stream_drain.ts` orquestra `getCursor → readBacklog → emit serial com ack → commitCursor → XDEL`. Wiring integrado em `socket.ts` (resolução de `recipientPrincipalIds` via `fetchSockets`) e em `client_socket_event_publish.service.ts` (append after live emit).
- **Cursor persistido**: novo `src/infrastructure/redis/agent_event_stream_cursor.ts` (`get/commit/purge`) com chave `plug_agent_stream_cursor:{plug}:<principalId>` e TTL = `AGENT_EVENT_STREAM_TTL_MS`. Default `"$"` no primeiro connect (skip histórico).
- **Feature flag por principal**: nova env `AGENT_EVENT_STREAM_AGENT_ALLOWLIST` (CSV) permite rollout gradual; vazio = todos.
- **Drain ack timeout**: nova env `AGENT_EVENT_STREAM_DRAIN_ACK_TIMEOUT_MS=5000`. Frames sem ack ficam no stream para próxima reconexão.
- **Integration test**: novo `tests/integration/agent_event_stream_backlog.integration.test.ts` exercita ciclo append → read → ack → cursor com Redis real (skipa sem broker).

### Added (Redis hardening v2 — Sprint 6: Performance + Refactor)

- **Lua single-round-trip consume**: `consumeSocketRateLimitRedis` agora executa `INCRBY` + `PEXPIRE` condicional em um único EVAL (`SOCKET_RATE_LIMIT_CONSUME_SCRIPT`). Reduz round-trips em ~50% no hot-path. Spike a/b mantido em `scripts/socket-bridge-load-test.mjs`.
- **`LuaScriptCache`**: novo `src/infrastructure/redis/lua_script_cache.ts` pré-carrega scripts via `SCRIPT LOAD` no `onConnected` e usa `EVALSHA` com fallback `NOSCRIPT`. Aplicado em `socket_rate_limit_redis` (consume + refund) e `client_socket_event_publish_idempotency_redis` (release_lock + extend_lock).
- **`createPubSubInstrumentedRedisClients`**: novo factory para o par `pub` + `sub.duplicate()` em `src/infrastructure/redis/pubsub_instrumented_redis_client.ts`. `socket_io_redis_adapter` consome o factory removendo ~80 LOC de cerimônia.
- **README do diretório Redis**: `src/infrastructure/redis/README.md` com diagrama dos 5 módulos e quando usar cada factory.
- **Type guard `xRead`**: substituiu o `type assertion` em `agent_event_stream.ts` por um `isXReadStreamBatch` reutilizável.

### Spikes documentados (NO-GO)

- **Sliding-window rate-limit**: `src/infrastructure/redis/socket_rate_limit_redis_sliding.ts` (não wired). Decisão NO-GO em `docs/spikes/sliding_window_rate_limit.md` — memória ~80× a do fixed-window e nenhum incidente de boundary-burst observado em 30 dias.
- **RedisClientPool**: análise em `docs/spikes/redis_client_pool.md`. NO-GO — node-redis@5 já multiplexa comandos; pool não reduz p95 sob nosso workload (sem comandos blocking).

### Added (Redis hardening v2 — Sprint 7: Security + Operability)

- **AUTH ping pós-connect**: `instrumented_redis_client.ts` e `pubsub_instrumented_redis_client.ts` executam `client.ping()` após `connect()` e abortam boot em produção se a resposta indica `WRONGPASS`/`NOAUTH`. Fora de produção, falhas autenticáveis logam `*_post_connect_ping_failed` e seguem.
- **Cluster topology validator**: novo `src/infrastructure/redis/cluster_topology_validator.ts` chamado de cada `init()` (best-effort, no-op em standalone). Valida via `CLUSTER INFO` + `CLUSTER KEYSLOT` que prefixos `{plug}` mapeiam ao mesmo slot; loga `*_cluster_topology_crossslot` quando detecta inconsistência.
- **`GET /health/redis`**: novo controller `health_redis.controller.ts` retornando estado por módulo (`adapter`, `socketRateLimit`, `restRateLimit`, `idempotency`, `agentEventStream`). 200 quando todos `active||skipped`, 503 caso contrário. Útil para readiness probes diferenciadas.
- **Chaos integration test**: `tests/integration/redis_chaos.integration.test.ts` mata clientes do broker mid-flight via `CLIENT KILL` e valida que watchdog pára de renovar, publish termina graciosamente, sem `unhandledRejection`. Gated em `INTEGRATION_REDIS_CHAOS_TESTS_ENABLED=true`.
- **Limpeza**: removidos arquivos órfãos `src/shared/config/env_schema_{infra,socket,http}.ts` (não importados em lugar nenhum desde a centralização em `env.ts`).

### Added (Redis hardening v2 — Sprint 8: Docs + Observability)

- **Quantis explícitos**: `redis_command_latency_histogram` agora calcula `p50Ms/p95Ms/p99Ms` por interpolação linear nos buckets. Renderer emite `plug_*_command_duration_ms_p50/p95/p99` para dashboards lightweight sem `histogram_quantile()` PromQL.
- **Grafana dashboard**: novo `docs/grafana/redis_dashboard.json` com 14 painéis (connection state stat-tiles, latency p95 por op, fallback rate por módulo, circuit state, tracked keys, stream backlog flow). Importável em Grafana 10.x.
- **Alerting rules**: novo `docs/observability/alerts/redis.yml` com 8 regras Prometheus cobrindo adapter down (critical), rate-limit circuit open (warning), latency p95 alta (warning), fallback events (warning), stream dropped (critical), stream fallback (critical), tracked keys saturation (warning).
- **ADRs**: novo diretório `docs/adrs/` com 5 documentos (`0001-fail-open-default`, `0002-hash-tag-prefix`, `0003-streams-vs-pubsub`, `0004-circuit-breaker-thresholds`, `0005-instrumented-redis-client-factory`).
- **Capacity planner CLI**: `scripts/redis-capacity-planner.ts` calcula memória steady-state e burst do agent_event_stream a partir de `agents`, `max-len`, `avg-frame-bytes`, `ttl-hours`, `active-fraction`. Recomenda `maxmemory` e eviction policy.

### Changed (Redis hardening v2)

- **`PublishConsumerSocketEventResult` ganha `recipientPrincipalIds?: ReadonlyArray<string>`**: handlers do sink podem retornar a lista de principalIds locais (resolvida apenas quando streams ativo). Compatível com handlers existentes (campo opcional, agregação faz Set-merge cross-handler).
- **Redis envs convencionadas**: `docs/configuration.md` documenta o contrato "vazio = desligado" para todos os 5 módulos Redis e centraliza o tuning compartilhado (`REDIS_DEFAULT_*`, `STRICT_REDIS_AUTH`).

### Added (Redis hardening)

- **Redis Streams para entrega at-least-once cross-replica (opt-in, default off)**: novo `src/infrastructure/redis/agent_event_stream.ts` (XADD com `MAXLEN ~ N` + `PEXPIRE` por append, XREAD desde `lastSeenStreamId`, XDEL para ack), metrics service `agent_event_stream_metrics.service.ts` (counters + histograma `append/read/ack/trim`). Novas envs `AGENT_EVENT_STREAM_REDIS_URL`, `AGENT_EVENT_STREAM_ENABLED=false`, `AGENT_EVENT_STREAM_MAX_LEN=1000`, `AGENT_EVENT_STREAM_TTL_MS=86400000`, `AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES=500`. Lifecycle integrado em `server.ts`. Wiring no publish/connect (Phase 2) documentado em `docs/redis_streams_agent_backlog.md`.
- **Redlock-style watchdog**: idempotency lock NX/PX agora pode ser estendido em-flight via Lua compare-and-pexpire (`extendLock`). Nova env `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_RENEWAL_MS` (default `0` = legacy fixed-TTL). Quando > 0, `executeClientSocketEventPublish` arma `setInterval` que renova o lock até o publish concluir. Metrica `plug_socket_custom_event_idempotency_redis_lock_extensions_total` + bucket `op="extend"` no histograma de latencia.
- **STRICT_REDIS_AUTH (production guard)**: nova env (default `false`); quando `true` e `NODE_ENV=production`, `env.ts` recusa boot se qualquer `*_REDIS_URL` usar `redis://` sem password. Aceita `rediss://` (TLS) ou `redis://default:<password>@host`. Documentado em `docs/redis_security.md`.

### Changed (Redis hardening)

- **Redis client resilience**: novo helper `src/infrastructure/redis/redis_client_options.ts` aplica `socket.connectTimeout` e `socket.reconnectStrategy` (capped exponential backoff) a todos os 4 modulos Redis (`socket_io_redis_adapter`, `socket_rate_limit_redis`, `rest_rate_limit_redis`, `client_socket_event_publish_idempotency_redis`). Novas envs `REDIS_DEFAULT_CONNECT_TIMEOUT_MS=5000`, `REDIS_DEFAULT_RECONNECT_BASE_MS=200`, `REDIS_DEFAULT_RECONNECT_MAX_MS=5000`. Adapter Socket.IO mantem suas envs `SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS/MAX_MS` para back-compat.
- **Redis hash tag (cluster-ready)**: prefixos das chaves de rate-limit e idempotency passam a usar `{plug}` para co-localizar slots em Redis Cluster: `plug_socket_rl:{plug}:<scope>:<key>`, `plug_rl:{plug}:<scope>:`, `plug_socket_event_idem:{plug}:<digest>`, `plug_socket_event_idem_lock:{plug}:<digest>`. **Migracao destrutiva** — contadores de rate-limit em janela activa e entradas de idempotency com TTL pendente nao sao migrados (efeito tipico: 1 minuto de janela perdida; idempotency keys repetidas durante o deploy podem produzir 2 publishes). Adapter Socket.IO (`SOCKET_IO_REDIS_ADAPTER_KEY`) nao foi alterado.
- **Tracked keys gauge sem GC spike**: `socket_rate_limit_redis_metrics.service.ts` substitui `Set<string>` ilimitado (clear de 10k strings na mudanca de geracao) por `Map<string, number>` com janela de 60 s e cap de 5000. Snapshot expoe `trackedKeysWindowSize` (gauge) e `trackedKeysSeenTotal` (counter monotonico) — antes `trackedKeysApprox`. Atualiza `metrics_renderer.ts` (`plug_socket_rate_limit_redis_tracked_keys_window_size`, `_seen_total`).
- **Latency histograms (per-command)**: novo `redis_command_latency_histogram.ts` (buckets 1ms..5s) instrumenta os 5 modulos Redis em `try/finally` com `performance.now()`. Novas metricas Prometheus: `plug_rest_http_rate_limit_redis_command_duration_ms_*`, `plug_socket_rate_limit_redis_command_duration_ms_*{op="consume|refund"}`, `plug_socket_io_redis_adapter_connect_duration_ms_*`, `plug_socket_custom_event_idempotency_redis_command_duration_ms_*{op="get|set|lock|unlock|extend"}`, `plug_agent_event_stream_command_duration_ms_*{op="append|read|ack|trim"}`. Atende `observe-metrics` rule.
- **Cerimonia de cliente Redis consolidada**: novo `instrumented_redis_client.ts` encapsula `createClient` resiliente + listeners `error`/`end`/`ready` + generation token + fallback handler. `socket_rate_limit_redis`, `rest_rate_limit_redis`, `client_socket_event_publish_idempotency_redis` e `agent_event_stream` passam a usar o factory; `socket_io_redis_adapter` mantem implementacao propria por causa do par `pub`+`sub.duplicate()` e backoff customizado.

### Docs

- **Redis Streams (at-least-once)**: novo `docs/redis_streams_agent_backlog.md` com arquitetura, capacity planning (formula `agentes × MAX_LEN × frame_size`), trade-offs vs pub/sub-only, e roadmap Phase 2 para wiring no publish/connect.
- **Observability metrics**: `docs/observability.md` lista os novos histogramas de latencia (`p95` PromQL pronto), `tracked_keys_*`, e o bloco completo `plug_agent_event_stream_*`.
- **Redis security checklist**: novo `docs/redis_security.md` com guidance de auth/TLS, ACL, network isolation, eviction policies, observability. `.env.example` linka o documento nas 4 secoes Redis.
- **Performance tuning (config)**: `.env.example` e `docs/configuration.md` documentam TTLs recomendados para staging/prod (`SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS=15000`, `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS=10000`, sweeps opcionais `120000` ms) com trade-offs staleness vs carga na BD; cross-link a metricas em `docs/observability.md`.
- **Limpeza de configuração**: removidas env órfãs `REST_ME_AGENTS_POST_RATE_LIMIT_*` (rota `POST /api/v1/me/agents` removida); `.env` local sincronizado. `docs/configuration.md` — secção de ajuste para `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET` (inclui `relay:conversation.start` na tabela de guards).
- **Socket client SDK — PayloadFrame migration**: `docs/socket_client_sdk.md` documenta decode de `agents:command_response`, `agents:command_stream_*` e `agents:stream_pull_response`; shims `SOCKET_AGENTS_COMMAND_COMPAT_MODE`, `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE` e `SOCKET_CONNECTION_READY_COMPAT_MODE` (remocao `2026-09-30`); consumer idle timeout (eventos significativos vs trafego hub→consumer); cross-links a `docs/configuration.md` e `docs/observability.md`.
- **Socket audit (operacao)**: `docs/configuration.md` documenta idle enforcement (`SOCKET_AGENT_IDLE_*`, `SOCKET_CONSUMER_IDLE_*`, `SOCKET_RELAY_CONVERSATION_*`), shim `SOCKET_AGENTS_COMMAND_COMPAT_MODE` e comportamento de `SOCKET_AUTH_REQUIRED` em test vs producao; `docs/observability.md` inclui metricas `plug_agent_idle_timeout_disconnect_total`, `plug_consumer_idle_timeout_disconnect_total`, `plug_socket_relay_conversations_expired_total`, `plug_socket_engine_connection_errors_total`, `plug_socket_namespace_adapter_errors_total`, `plug_socket_namespace_socket_errors_total` com exemplos PromQL e alertas sugeridos.

### Changed

- **Observabilidade — amostragem de metricas Socket (hot path)**: `SOCKET_METRICS_SAMPLE_RATE` (defeito `1`) aplica amostragem probabilistica com escalonamento apenas a contadores de alta frequencia no relay/stream hub (`plug_socket_relay_chunks_forwarded_total`, `plug_socket_relay_chunks_buffered_total`, `plug_socket_relay_stream_pulls_total`). Erros, seguranca e limites mantêm contagem exacta. Helper `shouldSampleMetric` / `sampledMetricDelta` em `src/shared/metrics/metrics_sample.ts`. Documentado em `.env.example` e `docs/configuration.md`. Testes: `metrics_sample.test.ts`.

- **Socket.IO / Redis adapter tuning (config)**: novas env `SOCKET_IO_REDIS_ADAPTER_KEY`, `SOCKET_IO_REDIS_ADAPTER_REQUESTS_TIMEOUT_MS`, `SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL`, `SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS`, `SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS`, `SOCKET_IO_REDIS_ADAPTER_RECONNECT_MAX_MS` e `SOCKET_IO_UPGRADE_TIMEOUT_MS` (Engine.IO); defaults preservam comportamento actual (`@socket.io/redis-adapter` + backoff 1s/30s). Codigo: `env.ts`, `socket_io_redis_adapter.ts`, `socket.ts`. Testes: `socket_io_tuning.test.ts`, `socket_io_redis_adapter.test.ts`. Docs: `.env.example`, `docs/configuration.md`.

- **Desempenho — PayloadFrame compress min (P2)**: `PAYLOAD_FRAME_COMPRESS_MIN_BYTES` (defeito **4096**) aplica limiar global em `encodePayloadFrame` e `encodePayloadFrameBridge`: frames com JSON UTF-8 abaixo deste tamanho usam `cmp: none`, evitando `gzipSync`/base64 em payloads pequenos (hot path continua com `encodePayloadFrameHotPath`). Documentado em `docs/configuration.md` e `.env.example`. Testes: `payload_frame_compression.test.ts`.
- **Socket `agents:stream_pull` PayloadFrame migration (P1)**: outbound `agents:stream_pull_response` passa a usar `PayloadFrame` por defeito no namespace `/consumers` (hot-path encode); inbound `agents:stream_pull` aceita plain JSON (legado) e `PayloadFrame` durante a transicao. Shim independente `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE=raw_json` restaura outbound plain JSON; aviso de arranque quando a data de remocao (`2026-09-30`) tiver passado (`warnIfAgentsStreamPullLegacyCompatExpired`). Codigo: `agents_stream_pull_wire.ts`, `agents_stream_pull.handler.ts`, `agent_bridge_parity.ts` (`agentsStreamPullWireMigration`), `env.ts`, `server.ts`. Testes: `agents_stream_pull_wire.test.ts`, `agents_stream_pull.handler.test.ts`, `socket_consumer_plain_json.contract.test.ts`, `agent_bridge_parity.contract.test.ts`, `socket.integration.test.ts`.
- **Socket `agents:command` PayloadFrame migration (Agent 1)**: outbound `agents:command_response` e `agents:command_stream_*` passam a usar `PayloadFrame` por defeito no namespace `/consumers`; inbound `agents:command` aceita plain JSON (legado) e `PayloadFrame` durante a transicao. Shim `SOCKET_AGENTS_COMMAND_COMPAT_MODE=raw_json` restaura outbound plain JSON; aviso de arranque quando a data de remocao (`2026-09-30`) tiver passado (`warnIfAgentsCommandLegacyCompatExpired`). Codigo: `agents_command_wire.ts`, `agents_command.handler.ts`, `agent_bridge_parity.ts` (`agentsCommandWireMigration`), `env.ts`, `server.ts`. Testes: `agents_command_wire.test.ts`, `agents_command.handler.test.ts`, `socket_consumer_plain_json.contract.test.ts`, `agent_bridge_parity.contract.test.ts`.
- **Socket hub (`socket.ts`) — consumer wiring extract (Agent 2)**: lifecycle de connect/disconnect e registo de eventos do namespace `/consumers` (`agents:command`, `agents:stream_pull`, `relay:*`, `socket:event.*`) movem-se para `register_consumer_socket_handlers.ts`; `socket.ts` fica como orquestrador fino. Preserva gates de inflight/overload, rate limits e passagem de envelopes relay pre-validados aos handlers.
- **Socket audit — performance P3 (selective consumer idle touch)**: `consumerRegistry.touch` deixa de correr em todo o trafego inbound via `onAny`; apenas eventos de actividade significativa (`agents:command`, `agents:stream_pull`, `relay:conversation.start/end`, `relay:rpc.request`, `relay:rpc.stream.pull`, `socket:event.subscribe/unsubscribe/publish`) refrescam `lastSeenAt`. Chunks/respostas relay reflectidas e trafego hub→consumer de alta frequencia nao reiniciam o relogio idle. Codigo: `consumer_idle_touch_events.ts`, `register_consumer_socket_handlers.ts`. Testes: `consumer_idle_touch_events.test.ts`.
- **Socket audit — idle enforcement & limits (C3)**: sweeps periodicos desligam sockets `/agents` registados inactivos (`SOCKET_AGENT_IDLE_TIMEOUT_MS`, `SOCKET_AGENT_IDLE_SWEEP_INTERVAL_MS`; metrica `plug_agent_idle_timeout_disconnect_total`) e `/consumers` ligados inactivos (`SOCKET_CONSUMER_IDLE_TIMEOUT_MS`, `SOCKET_CONSUMER_IDLE_SWEEP_INTERVAL_MS`; `app:error` `CONSUMER_IDLE_TIMEOUT` antes do disconnect; metrica `plug_consumer_idle_timeout_disconnect_total`). `relay:conversation.start` passa a respeitar o inflight gate por socket (`tryAcquireSocketInflightSlot` / `releaseSocketInflightSlot`). Codigo: `agent_registry.ts`, `agent_idle_timeout_scheduler.ts`, `consumer_registry.ts`, `consumer_idle_timeout_scheduler.ts`, `relay_conversation_start.handler.ts`, `env.ts`, `server.ts`, `socket.ts`, `socket_agent.metrics.ts`, `socket_consumer.metrics.ts`, `metrics.controller.ts`. Testes: `agent_registry.test.ts`, `agent_idle_timeout_scheduler.test.ts`, `consumer_registry.test.ts`, `consumer_idle_timeout_scheduler.test.ts`, `relay_conversation_start.handler.test.ts`.
- **Socket audit — performance P4 (profile push coalescing & access snapshot cache)**: push `client:agent.profile.updated` usa coalescing **trailing** por `agentId` (uniao de `changed_fields`, versao mais alta, um unico `encodePayloadFrameHotPath`/`emit` por rajada) em `consumer_client_agent_room_reconcile.ts`. Guard `assertConsumerSocketAgentAccess` suporta cache per-socket+agente via `SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS` (defeito `0`) para omitir `assertPrincipalAccess` e joins redundantes na mesma sessao ate expirar o TTL; conta activa continua a ser validada em cada evento. Testes: `consumer_client_agent_room_reconcile.test.ts`, `consumer_socket_guard.test.ts`. Docs: `configuration.md`, `.env.example`.
- **Socket audit — performance & consumer polish (C4)**: push de perfil de agente para consumers (`consumer_client_agent_room_reconcile.ts`) usa `encodePayloadFrameHotPath` (sem `gzipSync` no hot path). Lifecycle consumer connect/disconnect regista em `INFO` em producao (alinhado ao agente). Envelopes relay pre-validados em `socket.ts` passam dados parseados aos handlers (`relay_conversation_start`, `relay_rpc_request`, `relay_rpc_stream_pull`), eliminando validacao Zod duplicada.
- **Socket hub core (`socket.ts`)**: extrai modulos focados em `presentation/socket/hub/` (`custom_socket_event_distributed_count_circuit`, `consumer_client_agent_room_reconcile`, `socket_hub_error_handlers`); `socketServerStates` passa de `WeakMap` para `Map`; lifecycle de agente (`connect`/`register`/`disconnect`) regista sempre em `INFO`; `SocketData.capabilities` tipado via `AgentRegisterPayload`; metricas `hubErrors` em `getSocketMetricsSnapshot`; handlers para `io.engine` `connection_error` e erros de namespace/adapter/socket.

### Fixed

- **P4 — invalidação de snapshot de acesso consumer**: revogação de acesso client→agente limpa o cache per-socket `agentAccessSnapshots` via `invalidateConsumerClientAgentAccessSnapshots` (hook `onAccessRevoked`, alinhado a `invalidateAccessCache`); desativação de agente limpa snapshots do `agentId` em todos os sockets `/consumers` via `invalidateConsumerAgentAccessSnapshotsByAgentId` (hook `onAgentDeactivated`, alinhado a `invalidateAccessCacheForAgent`); bloqueio de conta user limpa `AGENT_ACCESS_CACHE_*` / `AGENT_REGISTER_BIND_CACHE_*` via `invalidateAccessCacheForUser` e snapshots per-socket na room `consumer:principal:user:{userId}` via `invalidateConsumerUserAccessSnapshots` (`AuthService.adminSetUserStatus`). `.env` local sincronizado com variáveis P1–P4 em falta.

- **Relay lifecycle (idle expiry, Workstream C1)**: o sweep de conversas inactivas emite `relay:conversation.ended` com `reason: expired` ao **agente** ligado (antes so ao consumer), limpa idempotencia da conversa explicitamente, e `relay:conversation.end` deixa de emitir quando o socket ja nao esta ligado. Codigo: `rpc_bridge_lifecycle.ts`, `socket.ts`, `relay_conversation_end.handler.ts`. Testes: `socket_disconnect_cleanup.test.ts`, `rpc_bridge_lifecycle.test.ts`, `relay_conversation_end.handler.test.ts`.
- **Socket audit — contratos / correlacao (Workstream C2)**: erros em `agents:command` incluem `requestId` no envelope `agents:command_response` quando o comando JSON-RPC tem `id` correlacionavel; `agents:stream_pull` valida `consumerSocketId` via `prepareLegacyAgentStreamPull` antes do guard de acesso na BD (alinhado a `rpc_bridge_stream_pull.ts`). Testes de contrato: `socket_consumer_plain_json.contract.test.ts`.
- **`relay:conversation.ended`**: respostas a `relay:conversation.end` incluem `requestId` no envelope canonico quando o cliente envia correlacao.

- **Socket audit — seguranca (Agent 1)**: `SOCKET_AUTH_REQUIRED=false` so permite handshakes anonimos em `/agents` com `NODE_ENV=test`; producao aborta o bootstrap se a flag estiver desligada; arranque emite `WARN` `socket_agent_auth_bypass_*`. Codigo: `socket_namespace_auth.middleware.ts`, `env.ts`, `log_socket_auth_bootstrap_hints.ts`, `server.ts`. Testes: `socket_namespace_auth.middleware.test.ts`, `log_socket_auth_bootstrap_hints.test.ts`.

- **Socket standards / contratos (auditoria)**: excecao legada plain-JSON documentada para `agents:command` / `agents:command_response` (`agentsCommandPlainJsonWireException` em `agent_bridge_parity.ts`, nota em `agents_command.handler.ts`); aviso de arranque quando a data de remocao do shim `connection:ready` raw_json (`2026-09-30`) tiver passado (`warnIfConnectionReadyLegacyCompatExpired`). Testes de contrato: `socket_agent_plain_json.contract.test.ts` (`agent:register_error`, `agent:session.superseded`), `agent_bridge_parity.contract.test.ts`, `connection_ready_handshake.test.ts`.

- **Socket audit — performance (Agent 3)**: `encodePayloadFrameHotPath` (`PAYLOAD_FRAME_HOT_PATH_ENCODE_OPTIONS`) evita `gzipSync` em frames de alta frequência hub→agente; `rpc:stream.pull` (`rpc_bridge_stream_pull.ts`, `rpc_bridge.ts`), `agent:capabilities` e `hub:heartbeat_ack` (`socket.ts`) passam a usar este helper. `rpc:response` invoca o ack Socket.IO logo após decode/validação (ack-then-process), antes do relay outbound, para reduzir retransmissões do agente. Testes: `payload_frame_compression.test.ts`, `rpc_bridge_agent_inbound.test.ts`.
- **Pub/sub `client:custom.*` — metricas e quotas**: `noteCustomSocketEventPublishRejected` deixa de ser chamado em duplicado no `catch` de `socket:event.publish` apos `executeClientSocketEventPublish` (o service ja contabiliza conflito de idempotencia, falha do sink e fingerprint); falha ao codificar `PayloadFrame` no fan-out local mapeia-se a `503` / `SERVICE_UNAVAILABLE` com `details.retry_after_ms`; teto de serializacao de idempotencia tambem incrementa `publish_rejected_total`. REST: `POST .../socket-events` usa `express-rate-limit` com `skipFailedRequests` e `requestWasSuccessful` = `statusCode < 500` para nao manter o hit da janela em respostas **5xx** (alinhado ao refund do rate limit Socket). Codigo: `client_socket_event_publish.service.ts`, `client_socket_event_publish_idempotency_serialization.ts`, `custom_socket_event_publish.handler.ts`, `rate_limit.middleware.ts`, `socket.ts`. Testes: `custom_socket_event_publish.handler.test.ts`, `client_socket_event_publish_idempotency_serialization.test.ts`, `client_socket_event_publish.service.test.ts`. Docs: `configuration.md`, `api_rest_bridge.md`, `observability.md`.

- **Pub/sub `client:custom.*` / `socket:event.publish` — refund de rate limit**: documentacao da politica em `shouldRefundSocketCustomEventPublishRateLimit`; refund apos falha do `execute` envolve-se em `try/catch` com `WARN` `client_socket_event_publish_rate_limit_refund_failed` para nao substituir o ack pelo erro do refund. Codigo: `custom_socket_event_publish.handler.ts`. Testes: `custom_socket_event_publish.handler.test.ts`. Docs: `socket_relay_protocol.md`.

- **Pub/sub `client:custom.*` — investigacao (retry, sink, docs)**: `503` por teto `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` inclui `details.retry_after_ms` = `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (header HTTP `Retry-After` quando aplicavel); `publishConsumerSocketEvent` sem handler registado regista **um** `WARN` `consumer_socket_event_publish_sink_missing` (com `eventName` / `clientId`) e volta a avisar depois de um handler ter sido registado e removido; documentacao actualizada (TTL `0` vs retries sequenciais, eviction do store por insercao, OpenAPI `503`, SDK, observabilidade, `api_rest_bridge`). Codigo: `client_socket_event_publish_idempotency_serialization.ts`, `consumer_socket_event_sink.ts`. Testes: `consumer_socket_event_sink.test.ts`, `client_socket_event_publish_idempotency_serialization.test.ts`.

- **Pub/sub `client:custom.*` — fila de idempotencia (memoria)**: entradas do mapa de serializacao por `(clientId, idempotencyKey)` sao removidas quando a cadeia de promessas termina (evita crescimento sem limite com chaves unicas); env opcional `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` (`0` = sem teto) rejeita novas chaves **distintas** em excesso com `503` / `SERVICE_UNAVAILABLE` ate libertar slots; metricas `plug_socket_custom_event_publish_idempotency_serialization_tracked_keys` (gauge) e `plug_socket_custom_event_publish_idempotency_serialization_cap_rejected_total`. Codigo: `client_socket_event_publish_idempotency_serialization.ts`, `env.ts`, `socket_consumer.metrics.ts`, `metrics.controller.ts`, OpenAPI `client_socket_events.routes.ts`. Testes: `client_socket_event_publish_idempotency_serialization.test.ts`.

- **Pub/sub `client:custom.*` — idempotencia, ACKs e metricas**: fila in-process por `(clientId, idempotencyKey)` evita emissao dupla em concorrencia antes do cache; `REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS=0` documentado como “sem armazenamento de replay”; fingerprint e limite de payload tratam `JSON.stringify` falhavel com `400` / `VALIDATION_ERROR`; `socket:event.subscribed` / `socket:event.unsubscribed` incluem `alreadySubscribed` e `wasSubscribed`; metrica `plug_socket_custom_event_subscription_forbidden_total` para `403` em subscribe/unsubscribe (deixa de contar em `subscription_rejected_total`). Codigo: `client_socket_event_publish_idempotency_serialization.ts`, `client_socket_event_publish.service.ts`, `client_socket_event_idempotency_store.ts`, `custom_socket_event_subscription.handler.ts`, `socket_consumer.metrics.ts`, `metrics.controller.ts`. Testes e docs actualizados.

- **Pub/sub `client:custom.*` — seguranca e operacao**: `socket:event.subscribe` / `socket:event.unsubscribe` restringem-se a principals **Client** (`403` antes do rate limit de controlo); `503` por fan-out local (`REST_SOCKET_EVENT_MAX_RECIPIENTS`) usa `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (por defeito `2000 ms`) em `retry_after_ms`, independente da janela de rate limit REST; `refundSocketRateLimitRedis` passa a um **EVAL** atomico (evita `DECRBY` aplicado e `DEL` a falhar seguido de retry que decrementava duas vezes); metricas Prometheus `plug_socket_consumer_client_agent_room_grant_*` para tentativas de `grantClientAccess`, joins bem-sucedidos e falhas. Codigo: `custom_socket_event_subscription.handler.ts`, `socket.ts`, `socket_rate_limit_redis.ts`, `env.ts`, `socket_consumer.metrics.ts`, `metrics.controller.ts`. Testes: `custom_socket_event_subscription.handler.test.ts`, `socket_rate_limit_redis.test.ts`. Docs: `socket_relay_protocol.md`, `socket_client_sdk.md`, `configuration.md`, `scaling_and_roadmap.md`, `observability.md`, `.env.example`.

- **Handshake `/agents`**: o hub entra na sala de identidade `agent:principal:{JWT sub}` **antes** de emitir `connection:ready`, alinhando o fluxo ao namespace `/consumers`. Teste de contrato: `tests/integration/socket.integration.test.ts` (*should have joined agent:principal room when connection:ready fires*). Documentação: `docs/api_rest_bridge.md` (*Erros e fases do handshake Socket*), `docs/migracao_plug_agente_namespaces.md`, `docs/README.md`, `docs/PROJECT_OVERVIEW.md`, `docs/configuration.md` (`SOCKET_AUTH_REQUIRED`), `docs/socket_client_sdk.md` (nota de capacidade em salas `consumer:client-agent:*`).
- **`agent:register` performance / fiabilidade**: (1) rate limit de `agent:register` corre **antes** de `bindOwnershipOnRegister`, reduzindo carga na BD em rajadas; (2) limite em janela deslizante passa a **podar** timestamps expirados ao rejeitar e liberta buckets quando a janela esvazia; (3) cache opcional `AGENT_REGISTER_BIND_CACHE_*` para omitir trabalho repetido de stub do catálogo + `bindIfUnbound` após `assertOwnershipEligible`, invalidado com `invalidateAccessCache*` / `invalidateAccessCacheForAgent`; documentação de **multi-réplica** na secção de validação de registo em `docs/configuration.md`. Testes: `agent_register_rate_limit.test.ts`, `agent_access_bind_cache.test.ts`.
- **CI (GitHub Actions)**: `actions/checkout@v5` e `actions/setup-node@v5`; removido `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`. Servico **PostgreSQL 16** com healthcheck e passo `npx prisma migrate deploy` antes de `npm run test`, para `DATABASE_URL` de CI corresponder a uma BD real e as integracoes Prisma nao ficarem a `return` cedo por BD indisponivel.

- **REST / Socket `agents:command` — agente catalogado sem socket `/agents`**: pedidos com JSON-RPC `id` correlacionavel passam a responder com **HTTP 200** (REST) ou `agents:command_response` com `success: true` (Socket) e corpo normalizado `error.code: -32000`, `message: agent_offline`, `data.reason: agent_disconnected_at_dispatch` (antes **503** / `SERVICE_UNAVAILABLE`). Comandos **apenas notification** (`id: null` em todos os itens) mantêm **503** quando o agente está offline. Implementação: `AgentDisconnectedBeforeDispatchError`, `agent_offline_bridge_response.ts`, `rpc_bridge_dispatch_command.ts`, `agents.controller.ts`, `agents_command.handler.ts`. Documentação: `docs/api_rest_bridge.md`, OpenAPI em `agents.routes.ts`. Testes: `agent_offline_bridge_response.test.ts`, `agents_http.integration.test.ts`, `agents_command.handler.test.ts`.
- **Arranque — hints Colmeia / socket**: `logSocketConsumerBootstrapHints()` (invocado após `createSocketServer`) emite `INFO` `socket_consumer_roles_ensured_client` quando o parse de `SOCKET_CONSUMER_ROLES` teve de acrescentar `client` (lista só `user,admin`); emite `WARN` se `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED` for `false`.
- **Pub/sub `client:custom.*` / `socket:event.publish`**: chave do limitador Socket (memoria e Redis com scope `client_socket_event_publish`) passa a `client:<JWT sub do Client>`; env opcionais `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_WINDOW_MS` e `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_MAX` permitem tetos só Socket (por defeito espelham `REST_SOCKET_EVENT_RATE_LIMIT_*`); rejeicao pre-Zod de envelopes JSON brutos acima de `socketEventPublishRawJsonMaxBytes` (derivado dos limites REST); `requestId` do publish Socket (e `response.locals.requestId` no REST, quando existir) propagam-se ao `PayloadFrame.requestId` e a `logger.debug` `client_socket_custom_event_published`; histograma Prometheus `plug_socket_custom_event_publish_recipients_hist_*` para dimensionar fan-out. Codigo: `env.ts`, `client_socket_event_publish_socket_rate_limiter.ts`, `custom_socket_event_publish.handler.ts`, `client_socket_event_publish.service.ts`, `consumer_socket_event_sink.ts`, `socket.ts`, `custom_socket_event.ts`, `socket_consumer.metrics.ts`, `metrics.controller.ts`, `client_socket_events.controller.ts`. Testes: `client_socket_event_publish.service.test.ts`, `custom_socket_event.test.ts`, `client_socket_event_publish_socket_rate_limiter.test.ts`, `client_socket_event_publish_inflight.integration.test.ts`. Docs: `docs/configuration.md`, `docs/socket_relay_protocol.md`, `docs/socket_client_sdk.md`, `docs/scaling_and_roadmap.md`, `.env.example`.
- **Pub/sub `client:custom.*` — follow-up (investigacao)**: alinhar chave HTTP do rate limit REST a `client:<JWT sub>` (`plug_rl:client_socket_event_publish:...`); refund da quota Socket apos `executeClientSocketEventPublish` falhar (nao refund em `409` idempotencia; refund em `5xx` e erros inesperados); `plug_socket_custom_event_publish_via_socket_total` so em emissao nova (exclui `idempotentReplay`); remover `releaseSocketInflightSlot` duplicado no `.catch` do handler; `WARN` no arranque se envelope max > `SOCKET_IO_MAX_HTTP_BUFFER_BYTES`; documentacao idempotencia cross-channel, Redis e metricas (`docs/socket_relay_protocol.md`, `docs/configuration.md`, `docs/scaling_and_roadmap.md`, `docs/api_rest_bridge.md`, `docs/observability.md`).
- **Consumer `/consumers` — salas client-agent e resiliencia**: apos aprovacao de acesso (token ou dono), o hub faz `join` na room `consumer:client-agent:{clientId}:{agentId}` em sockets ja ligados na room `client:{clientId}` (sem exigir reconnect); `refundSocketRateLimitRedis` tenta uma segunda vez apos falha transitória; `socket:event.publish` so emite `socket:event.published` se o socket ainda estiver ligado; env opcional `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` para teto de inflight dedicado ao publish (quando `0`, partilha `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`). Codigo: `consumer_socket_control_sink.ts`, `client_agent_access.service.ts`, `socket.ts`, `socket_rate_limit_redis.ts`, `per_socket_inflight_gate.ts`, `custom_socket_event_publish.handler.ts`, `env.ts`. Testes e docs actualizados.

### Fixed

- **Snapshot de cliente bloqueado**: `ClientAuthService.setManagedClientStatus` chama `invalidateSnapshotCache` ao passar para `blocked`, para guards Socket/REST nao servirem estado ativo obsoleto quando `PRINCIPAL_SNAPSHOT_CACHE_TTL_MS` > 0.
- **Testes Socket + cache in-process**: `socket.integration.test.ts` invalida caches alinhado aos servicos (`removeAccess` → `AgentAccessService.invalidateAccessCache`; bloqueio de user/client → `invalidateSnapshotCache` nos helpers), evitando falsos positivos com TTL > 0.
- **ESLint no CI**: `tests/unit/application/services/agent_access.service.test.ts` — `buildService` com tipo de retorno `Promise<...>` explicito (`@typescript-eslint/explicit-function-return-type`).

### Added

- **`socket:event.publish` / `socket:event.published`**: `Client` no namespace `/consumers` pode publicar eventos `client:custom.*` com o mesmo núcleo que `POST /api/v1/client/me/socket-events` (`executeClientSocketEventPublish`, idempotência, `PayloadFrame` para subscritores). Rate limit Socket usa as env `REST_SOCKET_EVENT_RATE_LIMIT_*` com balde separado do Express; Redis opcional com scope `client_socket_event_publish`. Código: `custom_socket_event_publish.handler.ts`, `client_socket_event_publish_socket_rate_limiter.ts`, `client_socket_event_publish.service.ts`, `client_socket_event_idempotency_store.ts` (movido para `application/services`), `socket.ts`, `socket_events.ts`, `custom_socket_event.ts`, métricas `plug_socket_custom_event_publish_via_socket_total` e `plug_socket_client_event_publish_rate_limit_*`. Testes: `client_socket_events.integration.test.ts`, `custom_socket_event.test.ts`. Documentação: `docs/socket_relay_protocol.md`, `docs/socket_client_sdk.md`, `docs/configuration.md`, `docs/scaling_and_roadmap.md`, OpenAPI em `client_socket_events.routes.ts` / `swagger.ts`.

- **Sessão exclusiva por agente (`/agents`)**: env `SOCKET_AGENT_SESSION_POLICY` (default `reject_active`), `SOCKET_AGENT_REGISTER_RATE_LIMIT_*`, novo `reason` `session_active` (`-32014`) em `agent:register_error`, evento `agent:session.superseded` antes do disconnect quando `takeover_disconnect_previous`, métricas Prometheus `plug_agent_session_*`. Código: `agent_registry.registerAgentSession`, `socket.ts`, `agent_register_rate_limit.ts`, `socket_agent.metrics.ts`. Testes: `agent_registry.test.ts`, `agent_register_error.test.ts`, `agent_session_policy.integration.test.ts`.
- **Handoff socket Colmeia — itens do checklist `socket_enable_handoff_checklist.md`**:
  - **`SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED`** (default `true`): nova env declarada em `src/shared/config/env.ts` que gateia o registro do handler em `src/socket.ts` para o broadcast `client:agent.profile.updated`. Default preserva o comportamento always-on; setar `false` desliga só o push (kill-switch operacional) sem afetar o restante do namespace `/consumers`. Cobertura em `tests/unit/shared/config/socket_client_agent_profile_push.test.ts`.
  - **`X-Hub-Instance-Id` global**: novo middleware `src/presentation/http/middlewares/hub_instance_id.middleware.ts` montado em `src/app.ts` logo após `requestIdMiddleware`. Quando `HUB_INSTANCE_ID` está definido, o header acompanha **toda** resposta Express (REST, Swagger, `/metrics`, 404), permitindo aos clientes validar afinidade de sessão (sticky) em qualquer endpoint — antes só `GET /client/me/agents` e `GET /client/me/agents/{agentId}` o emitiam. Helper inline `maybeSetHubInstanceIdHeader` removido de `src/presentation/http/controllers/client_agents.controller.ts`. Comentário do schema (`env.ts`) e descrição OpenAPI (`swagger.ts`) atualizados. Cobertura em `tests/unit/presentation/http/middlewares/hub_instance_id.middleware.test.ts`.
  - **Documentação nginx — sticky session**: `docs/nginx_production.md` ganha secção `12) Sticky session para Socket.IO (multi-replica)` com receitas `ip_hash` (built-in) e `sticky cookie` (módulo / nginx Plus), além de protocolo de validação via `X-Hub-Instance-Id` em chamadas REST consecutivas. `deploy/nginx/plug_server.conf.example` recebe bloco `02-plug-upstream.conf` documentando ambas as opções.

- **Alinhamento Socket com plug_agente v2.8** (`docs/communication/socket_communication_standard.md` em `plug_agente`):
  - **Evento `agent:register_error`** (`socket_events.ts` + `presentation/socket/hub/agent_register_error.ts`): emitido como **JSON puro** (NÃO `PayloadFrame`) com `{ code, reason, message }` em todas as falhas de `agent:register` (payload inválido, ownership conflict, token mismatch, sem userId). `reason` segue o catálogo `invalid_request` / `invalid_payload` / `authentication_failed` / `unauthorized` / `rate_limited` / `transient_failure` / `internal_error`, permitindo ao agente decidir entre **reagendar registo** (`transient_failure`, `rate_limited`) ou **forçar reconnect** (demais).
  - **Schema zod `agentRegisterPayloadSchema`** (`shared/validators/agent_register.ts`) alinhado a `agent.register.schema.json`: valida `agentId` (trim, não vazio), `timestamp` (ISO-8601 quando enviado, opcional para back-compat), `capabilities` (`protocols`/`encodings`/`compressions` mínimo 1 item; `extensions`/`limits` defaultam a `{}`), `profile` opcional. `socket.ts` substitui validação manual por este schema.
  - **`Retry-After` HTTP** (`presentation/http/serializers/agent_rpc_retry_after.ts`): `POST /api/v1/agents/commands` agora propaga `error.data.retry_after_ms` / `error.data.reset_at` de respostas JSON-RPC `code: -32013` (notavelmente `client_token.getPolicy` rate limit em v2.8) para o header HTTP padrão `Retry-After` (em segundos, arredondado para cima). Em batches usa o **maior** valor.
  - **Hints de stream pull**: `agent:capabilities` agora inclui `extensions.recommendedStreamPullWindowSize` e `extensions.maxStreamPullWindowSize` (derivados de `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`) via `buildHubServerCapabilities()`, ajudando agentes a calibrar `rpc:stream.pull` sem heurística própria.
  - **Enforcement de `signature.key_id`** (`shared/utils/payload_frame.ts`): quando `PAYLOAD_SIGNING_KEY_ID` está configurado, frames assinados sem `key_id` ou com `key_id` divergente são rejeitados com `Authentication failed` (alinhado a `payload-frame.schema.json` que marca `key_id` como required). Deployments single-key (sem `PAYLOAD_SIGNING_KEY_ID`) continuam aceitando frames sem `key_id`.
  - **`plugProfile`** atualizado de `plug-jsonrpc-profile/2.6` para `plug-jsonrpc-profile/2.8` em `HUB_TRANSPORT_EXTENSIONS`, refletindo suporte a `client_token.getPolicy` introspection.
  - **Documentação inline**: `meta.outbound_compression` em `agent_command.ts` agora documenta explicitamente que é **no-op no runtime atual** (per `socket_communication_standard.md` "Nota operacional"); `HUB_MAX_ROWS = 1_000_000` ganhou comentário sobre divergência intencional vs default 50.000 do agente (negociação `TransportLimits.negotiateWith` resolve no mínimo entre os dois).
  - **Cobertura de testes**: novos arquivos `tests/unit/shared/validators/agent_register.test.ts`, `tests/unit/presentation/socket/hub/agent_register_error.test.ts`, `tests/unit/presentation/http/serializers/agent_rpc_retry_after.test.ts`, `tests/unit/shared/constants/agent_transport_contract.test.ts`, `tests/unit/shared/utils/payload_frame.signature_key_id.test.ts` (38 testes); teste de integração `socket.integration.test.ts` "ownership changes after agent-login" passa a verificar `agent:register_error` (code `-32002`, reason `unauthorized`) em vez do antigo `app:error`. Helper e2e `tests/e2e/helpers/plug_agente_socket.ts` agora declara `limits: {}` no default de capabilities, espelhando o schema do agente.
- **Client — consulta de agentes (`isHubConnected`)**: `GET /api/v1/client/me/agents` e `GET /api/v1/client/me/agents/{agentId}` incluem `isHubConnected` (boolean) em cada `ClientAccessibleAgent`, derivado do `agentRegistry` via `isAgentConnectedToHub` em `agent_hub_connection.ts` (reutilizado no `container` para `isAgentOnline` do live profile). Header opcional `X-Hub-Instance-Id` quando `HUB_INSTANCE_ID` está definido; métricas `plug_client_me_agents_*` em `GET /metrics`. OpenAPI (`swagger.ts`); `docs/client_agent_business_rules.md` (secção 3.4), `docs/configuration.md`, `docs/observability.md`.
- **Manutencao de dados Agent**: scheduler para podar `agent_profile_revisions` e `agent_profile_write_idempotencies` por `created_at`, com envs `AGENT_PROFILE_*`, metricas `plug_agent_profile_maintenance_*` e indices de suporte em `created_at`; sweep periodico para expirar pedidos `Client -> Agent` cujo token de aprovacao venceu, remover `client_agent_access_approval_tokens` expirados e expor metricas `plug_client_agent_access_*`.
- **Documentacao (perfil de agente / versoes)**: narrativa alinhada ao hub em `docs/client_agent_business_rules.md` (`profile_version` no `agent.getProfile`, pull sync e divergencia com mesma versao, `PATCH` self-service com CAS/idempotencia, push `client:agent.profile.updated` para `Client` em `/consumers`); referencias cruzadas em `docs/configuration.md`, `docs/PROJECT_OVERVIEW.md`, `docs/observability.md` (exemplos PromQL `plug_agent_profile_*`), `docs/socket_client_sdk.md`, `docs/README.md` (OpenAPI `/docs`) e `docs/communication_sync_plug_agente.md` (campo opcional no schema publico do plug_agente).
- **Governanca `User` -> `Client`**: novos endpoints autenticados `GET /api/v1/me/clients`, `GET /api/v1/me/clients/{clientId}`, `PATCH /api/v1/me/clients/{clientId}/status`, `GET /api/v1/me/client-access-requests`, `POST /api/v1/me/client-access-requests/{requestId}/approve`, `POST /api/v1/me/client-access-requests/{requestId}/reject`, `GET /api/v1/me/agents/{agentId}/clients` e `DELETE /api/v1/me/agents/{agentId}/clients/{clientId}` para inbox de aprovacao, listagem e revogacao por owner.
- **Cobertura de integracao**: novo arquivo `tests/integration/user_clients.integration.test.ts` cobrindo cadastro de `Client` sob owner autenticado, aprovacao por inbox do owner e revogacao de acesso por agente.
- **Client -> Agent access flow**: `POST /api/v1/client/me/agents` para solicitar acesso por `agentId` com aprovacao do `User` owner; `GET /api/v1/client/me/agents`, `GET /api/v1/client/me/agents/{agentId}` e `GET /api/v1/client/me/agent-access-requests` para consultar agentes aprovados e pedidos com dados gerais/perfil, `status`, `search`, `page` e `pageSize`; `DELETE /api/v1/client/me/agents` para remover acessos da propria lista. Fluxo de decisao por email exposto em `GET /api/v1/client-access/review`, `GET /api/v1/client-access/status`, `POST /api/v1/client-access/approve` e `POST /api/v1/client-access/reject`. Testes: `tests/integration/client_agents.integration.test.ts`.
- **`PATCH /api/v1/auth/me`**: corpo `{ "celular": "<E.164>" | null }` para definir ou remover o telemóvel (mesma validação que no registo; unicidade). `UpdateMyCelularUseCase` + testes em `tests/integration/auth_profile.integration.test.ts`.
- **Admin**: log estruturado `admin_user_status_set` (`actorUserId`, `targetUserId`, `status`, `requestId`); rate limit por admin em `PATCH /api/v1/admin/users/:id/status` (`REST_ADMIN_USER_STATUS_RATE_LIMIT_*`, métrica `plug_rest_http_rate_limit_admin_user_status_rejected_total`).
- **Integração Socket**: teste `tests/integration/auth_socket_blocked.integration.test.ts` (consumidor bloqueado não conecta a `/consumers`).

- **Contas de utilizador (`UserStatus`)**: valor `blocked`; middleware `requireActiveAccount` + `requireAuthAndActiveAccount` (verificacao na BD apos JWT) nas rotas protegidas; `PATCH /api/v1/admin/users/:id/status` (admin) para `{ "status": "blocked" | "active" }` — ao bloquear, revogam-se todos os refresh tokens do utilizador. Métricas Prometheus em `GET /metrics`: `plug_auth_login_blocked_total`, `plug_auth_refresh_blocked_total`, `plug_admin_user_status_set_total`. Documentacao: `docs/user_status.md`; OpenAPI atualizado para `/auth/me` (403 quando bloqueado). Testes: `tests/unit/domain/use_cases/admin_set_user_status.use_case.test.ts`, `tests/integration/admin_users.integration.test.ts`.

- **Documentacao de desempenho**: `docs/performance_hub_agent.md` — secções *Presets recomendados* (`.env`) e *Checklist operacional*; fragmento espelhado em `.env.example`. `docs/configuration.md` e `docs/scaling_and_roadmap.md` apontam para estes presets.
- **Métricas Prometheus** (`GET /metrics`): `plug_socket_relay_outbound_queue_jobs_finished_total`, `jobs_failed_total`, `job_duration_sum_ms`, `job_duration_avg_ms`, `job_duration_max_ms`, `inflight_request_ids`; `docs/observability.md` com exemplos PromQL. Testes em `tests/unit/presentation/socket/hub/relay_outbound_queue.test.ts`.
- **Playbook de performance (baseline e rollout)**: `docs/performance_hub_agent.md` ganhou secções de baseline obrigatório antes/depois, estratégia de auditoria por perfil e rollout agressivo faseado com critérios de promoção/rollback.
- **Snapshot mínimo de tuning**: `docs/observability.md` passa a listar o conjunto mínimo de métricas para comparação antes/depois em mudanças de bridge/relay.
- **Estudo técnico de fast-path relay**: novo documento `docs/relay_fastpath_study.md` com gate de benchmark, requisitos de segurança e critérios de rollback.

### Changed

- **Client — `ClientAccessibleAgent`**: o mapeamento `toClientAgentDto` foi extraído para `src/presentation/http/mappers/client_agent.mapper.ts`, com testes unitários em `tests/unit/presentation/http/mappers/client_agent.mapper.test.ts`; `isHubConnected` continua a ser calculado no controller via `container.isAgentConnectedToHub`. `docs/client_agent_business_rules.md` (secção 3.4) passa a orientar integradores sobre **mesma base URL** / **sticky sessions** em cenários com load balancer e várias réplicas (remissão a `docs/scaling_and_roadmap.md`).
- **Bridge RPC / documentacao**: `docs/api_rest_bridge.md` (OpenAPI: exemplos incluem `agent.getProfile` e `client_token.getPolicy`), `docs/socket_client_sdk.md` (remissao ao catalogo de metodos em `api_rest_bridge.md`), `docs/communication_sync_plug_agente.md` (checklist: novo metodo RPC exige Zod + Swagger + docs em conjunto), `docs/client_agent_business_rules.md` (remissao a `client_token.getPolicy`). Constante `AGENT_CLIENT_TOKEN_CARRIER_PARAMS_JSON_MAX_BYTES` para o teto UTF-8 de params partilhados por `agent.getProfile` / `client_token.getPolicy`; `AGENT_GET_PROFILE_PARAMS_JSON_MAX_BYTES` mantido como alias. Testes: `client_token.getPolicy` acima do teto UTF-8; batch JSON-RPC misto `client_token.getPolicy` + `sql.execute`.
- **Documentacao do fluxo de perfil do agente**: `docs/client_agent_business_rules.md`, `docs/configuration.md`, `docs/observability.md` e `docs/communication_sync_plug_agente.md` passam a documentar tambem o caminho socket `agent:profile.update` / `agent:profile.updated` e a politica de manutencao dos dados satelite do agente.
- **OpenAPI** (`GET /docs.json`): `PATCH /api/v1/agents/{agentId}/profile` inclui `409` (CAS / idempotencia) e parametro de header `Idempotency-Key`; descricao de `components.responses.Conflict` e de `ClientAccessibleAgent.profileVersion` alinhadas ao comportamento do hub.
- **Cadastro de `Client`**: `POST /api/v1/client-auth/register` nao aceita `userId` no body; o owner passa a ser resolvido por `ownerEmail` com aprovacao explicita do `User` responsavel.
- **Cadastro de `Client` com aprovacao do owner**: `POST /api/v1/client-auth/register` passa a ser publico e exige `ownerEmail`; o `Client` nasce em `pending` e so ativa apos aprovacao por token em `GET /api/v1/client-auth/registration/review`, `GET /api/v1/client-auth/registration/status`, `POST /api/v1/client-auth/registration/approve` e `POST /api/v1/client-auth/registration/reject`. Login/refresh/operacao ficam bloqueados enquanto `pending`.
- **Resiliencia e seguranca no cadastro de `Client`**: o pedido pendente agora faz cleanup se o envio do email do owner falhar, pode usar o outbox de emails de registro para entrega assíncrona, nao expoe diferenca publica entre owner inexistente e owner inativo, e `PATCH /api/v1/me/clients/{clientId}/status` deixou de ativar/rejeitar contas ainda `pending` fora do fluxo oficial de aprovacao.
- **Handshake/sync de perfil de agente**: o `agent.getProfile` deixa de disparar cedo em agentes com `extensions.protocolReadyAck=true`; nesses casos o sync roda apenas após `agent:ready`. Para agentes sem ready explícito, mantém fallback após `agent:register` (grace window). Cobertura em `tests/integration/socket.integration.test.ts`.
- **Politica de autorizacao `admin`**: `admin` passa a operar qualquer agente ativo tambem em `POST /api/v1/agents/commands`, socket `agents:command` e `relay:conversation.start`, mantendo as regras de ownership para utilizadores nao-admin.
- **Revogacao em runtime**: apos perda/revogacao de `ClientAgentAccess`, novas chamadas `relay:rpc.request` em conversa ja aberta voltam a validar acesso e passam a falhar com `AGENT_ACCESS_DENIED` (`403`), sem depender de reconexao.
- **Ownership runtime**: `agentRegistry.ownerByAgentId` deixa de ser usado para decisao de ownership; `AgentIdentity` fica consolidado como fonte de verdade para autorizacao e vinculo.
- **Ownership e catalogo de agentes**: o ownership oficial do `Agent` deixa de ser gerido manualmente por HTTP e passa a nascer apenas em `agent:register`, depois de `agent-login` válido. Nesse registo o hub consulta `agent.getProfile`, cria automaticamente o agente no catalogo quando necessario, atualiza o cadastro existente quando ja houver registo e sincroniza `lastLoginUserId` apenas como atributo operacional. `agent-login` passa a aceitar agentes ainda nao catalogados, desde que o `agentId` nao pertença a outro `User`; se pertencer, responde com `409`. Swagger, validadores e testes de regressao/integracao foram alinhados.
- **Documentacao de negocio**: `docs/client_agent_business_rules.md` passa a concentrar as regras canonicas de `User`, `Agent` e `Client`; `docs/PROJECT_OVERVIEW.md`, `docs/api_rest_bridge.md`, `docs/configuration.md`, `docs/socket_client_sdk.md` e `docs/communication_sync_plug_agente.md` foram enxugados para remover duplicacao e apontar para essa fonte de verdade.
- **Auth / Socket.IO**: handshake em `/agents` e `/consumers` rejeita JWT valido quando a conta esta `blocked` (alinhado ao HTTP). `GET /api/v1/auth/me` e `getActiveAccountUser` reutilizam o utilizador do pedido (`response.locals.activeAccountUser` / argumento `preloaded`) para evitar `SELECT` duplicado. Nova metrica Prometheus: `plug_auth_socket_blocked_total`. Ver `docs/user_status.md`.
- **REST stream materialização**: `active_stream_registry.ts` — `restMaterializeState` em rotas agregadas REST; ao remover a rota (ex.: disconnect do agente antes de `rpc:complete`), limpa-se o timeout do pedido HTTP e chama-se `reject` com **503** (`Agent disconnected while SQL stream in progress`) em vez de esperar o `timeoutMs` completo. `removeActiveStreamRoute(..., { restMaterialize: "detach" })` em `rpc_bridge_dispatch_command.ts` (timeout, abort HTTP, falha de emit) só cancela o timer e evita sobrescrever a mensagem de erro. `resetActiveStreamRegistry` aborta materializações pendentes da mesma forma.
- **Relay hub → consumer**: `relay_outbound_queue.ts` — fila serial por `requestId` + `encodePayloadFrameBridge` (gzip assíncrono quando configurado) para `relay:rpc.response` / chunk / complete, acks relay, replay idempotente e timeout; `emitRelayTimeoutResponse` corre `removeRelayRequestRoute` após emit; `resetRelayOutboundQueueState` (tails + contadores) no lifecycle do bridge.
- **Documentacao**: `docs/performance_hub_agent.md` — relay outbound alinhado à fila + bridge async; lookup de rota relay no drain de `rpc:stream.pull`.
- **Guidance de canal REST vs relay/socket**: `docs/api_rest_bridge.md` e `docs/PROJECT_OVERVIEW.md` passam a incluir matriz/prática operacional para escolher canal por volume, latência e padrão de streaming.
- **Relay stream pull**: `rpc_bridge_stream_pull.ts` — uma leitura `getRelayRequestRoute` por pull ao drenar buffer (reutilizada para auditoria de chunks e complete).
- **Documentacao**: `docs/communication_sync_plug_agente.md` — secção *Implementação no plug_server (fluxos)* com diagramas Mermaid (REST/`agents:command` e relay); tabela de ficheiros corrige onde vive `api_version` (`rpc_bridge_command_helpers.ts` / relay), em vez de `rpc_bridge.ts`.
- **REST stream materialization**: `mergeSqlStreamRpcResponse` junta linhas de chunks com loop em vez de `push(...rows)`, evitando limites de argumentos do motor JS em resultados muito grandes.
- **Bridge latency trace retention**: `pruneBridgeLatencyTracesOlderThanDays` passa a receber opcoes (`defaultRetentionDays`, `relayRetentionDays`, `batchSize`) em vez de dias como primeiro argumento; o scheduler usa apenas `env` + `batchSize`.
- **PayloadFrame inbound**: `isPayloadFrameEnvelope` alinhado ao schema `payload-frame.schema.json` do plug_agente (`schemaVersion` 1.0, `contentType` application/json, tamanhos inteiros ≥ 0, sem propriedades extra, `signature` só com chaves permitidas); export `PAYLOAD_FRAME_SCHEMA_VERSION`; `requestId` no envelope aceita `null`; testes em `tests/unit/shared/utils/payload_frame.envelope.test.ts`.
- **Desempenho (defaults `env.ts`)**: `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES` **131072**; `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` **65536**; `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` **256**; `SOCKET_REST_AGENT_MAX_INFLIGHT` **32** / `SOCKET_REST_AGENT_MAX_QUEUE` **64**; relay `SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST` **256** / `SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS` **25600**. Com `NODE_ENV=production` e variáveis **omitidas**: `SOCKET_IO_TRANSPORTS` → só `websocket`, `SOCKET_IO_HTTP_COMPRESSION` → `false`, `PAYLOAD_FRAME_GZIP_LEVEL` → **3**, `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` → **25**. Ver `docs/configuration.md` e `docs/performance_hub_agent.md`; `.env.example` alinhado.
- **Inbound PayloadFrame**: `decodePayloadFrameAsync` com `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` (defeito **65536**): `gunzip` assincrono para frames `cmp: gzip` grandes em `rpc:response`, acks e relay consumer decode. **`rpc:chunk` / `rpc:complete` mantem `decodePayloadFrame` sync** para preservar ordem por socket. `decodePayloadFrame` sync em `agent:register` / heartbeat em `socket.ts`.
- **Auditoria**: `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` (0–100; fora de produção defeito **100**, em produção sem env **25**) — amostragem aleatoria de eventos `relay:rpc.chunk` antes de enfileirar/INSERT; metrica `plug_socket_audit_writes_sample_skipped_total`.
- **`agentRegistry`**: `SOCKET_AGENT_KNOWN_IDS_MAX` (defeito **0** = ilimitado) — quando o conjunto de IDs “conhecidos” offline excede o teto, remove-se IDs **nao ligados** ate ficar abaixo do limite.
- **Documentacao**: `docs/observability.md` (exemplos de alertas PromQL), `docs/socket_client_sdk.md` (limites e comportamento do hub), `docs/load_testing.md` (notas HTTP/Socket).
- **Desempenho hub→agente**: `encodePayloadFrameBridge` para `rpc:request` (REST + relay) com `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES` (defeito **131072**): JSON elegivel para gzip acima deste tamanho usa **gzip assincrono** (`zlib` + `promisify`) em vez de `gzipSync`; `0` desliga (sync). Pedido REST com resposta: frame e codificado **antes** de registar pending/timeout (evita timeout a contar durante compressao lenta).
- **Envelope PayloadFrame**: `omitTraceId` em `rpc:request`, `rpc:stream.pull` (materializador REST + pull relay), `relay:rpc.response` (relay para consumer), `agent:capabilities`, `hub:heartbeat_ack`, timeout relay — correlacao via `requestId` / `meta.trace_id` no JSON-RPC onde aplicavel.
- **Defaults**: `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` **256**; `SOCKET_AUDIT_BATCH_MAX` **48**; `SOCKET_AUDIT_BATCH_FLUSH_MS` **200**.
- **Desempenho relay PayloadFrame**: `relay:rpc.chunk` / `relay:rpc.complete` e acks relay para o consumer usam `omitTraceId` (sem `randomUUID()` por mensagem); `requestId` no envelope mantem correlacao. Com `SOCKET_IO_TRANSPORTS=websocket` apenas, Engine.IO usa `allowUpgrades: false`.
- **Desempenho Socket.IO**: `serveClient` defeito `false`; `SOCKET_IO_HTTP_COMPRESSION` configuravel (fora de produção defeito `true`; em produção sem env `false`); `SOCKET_IO_PING_INTERVAL_MS` / `SOCKET_IO_PING_TIMEOUT_MS` opcionais; documentado em `performance_hub_agent.md` e `configuration.md`.
- **PayloadFrame gzip**: `PAYLOAD_FRAME_GZIP_LEVEL` opcional (`1`–`9`) para `gzipSync` no hub (CPU vs tamanho).
- **Socket `agents:command`**: rate limit por JWT `sub` com os mesmos `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` e `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` que o POST HTTP (contador **separado** do Express); resposta `agents:command_response` com `error.code: TOO_MANY_REQUESTS` e `statusCode: 429`. Implementacao: `agents_command_socket_rate_limiter.ts`, sweep no timer do hub, limpeza da chave anonima no disconnect; metricas `plug_socket_agents_command_rate_limit_*` em `/metrics`.
- **Documentacao**: `socket_client_sdk.md` — paridade REST/Socket, rate limit, exemplo JSON `agents:command` (batch/paginacao), notas de **producao** para decode `PayloadFrame` (tamanhos, inflacao, assinatura) + link ao snippet; `api_rest_bridge.md` — nota cruzada no rate limit do POST commands; `README.md` — links para `socket_client_sdk` e `socket_relay_protocol`; `observability.md` — PromQL para `agents:command` rate limit.
- **PayloadFrame (hub)**: teto para tentativa de gzip configuravel por `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES` (defeito `524288`); `preencodePayloadFrameJson` aceita `maxGzipInputBytes` opcional (testes). Documentado em `docs/configuration.md`, `api_rest_bridge.md`, `socket_relay_protocol.md`, `performance_hub_agent.md`.
- **REST `POST /agents/commands` rate limit**: o limite configuravel por `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` passa a contar por **utilizador** (JWT `sub`), nao por IP. Opcional: segundo limitador por IP (`REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX`, `0` = desligado). Ver `docs/api_rest_bridge.md`.
- **Validacao JSON logica**: tetos UTF-8 em `sql` (1 MiB), `params` nomeado serializado (2 MiB) e `rpc.discover` `params` (64 KiB) em `agent_command.ts` + OpenAPI; ver `docs/api_rest_bridge.md`.
- **Desempenho Socket.IO**: `maxHttpBufferSize` alinhado a 10 MiB (PayloadFrame); `perMessageDeflate` desligado por defeito (`SOCKET_IO_PER_MESSAGE_DEFLATE`); `SOCKET_IO_TRANSPORTS` configurável (fora de produção defeito `websocket,polling`; em produção sem env só `websocket`). Ver `docs/performance_hub_agent.md`.
- **Defaults de throughput**: `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` **256**, `SOCKET_REST_AGENT_MAX_INFLIGHT` **32**, `SOCKET_REST_AGENT_MAX_QUEUE` **64**, `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS` **64**, buffers relay **256** / **25600** chunks.
- **Hub Socket**: `conversationRegistry.removeExpired` e `pruneExpiredRelayIdempotencyEntries` passam a recolher ids expirados antes de remover (evita apagar durante iteracao sobre `Map`). Resposta **503** com `retry_after_ms` partilhada em `serviceUnavailableWithRetry` (`shared/errors/http_errors.ts`); `rest_agent_dispatch_queue` e `rpc_bridge_dispatch_command` deixam de duplicar o helper. Documentacao do relay: secao **Rate limit por consumer (janela fixa)** em `socket_relay_protocol.md`. `agent_registry.knownAgentIds` documentado (retido pos-disconnect; sem prune).
- **Defaults de desempenho (env)**: tetos de REST/relay/auditoria evoluiram ao longo do tempo; estado atual em `.env.example` e `docs/performance_hub_agent.md`. `SOCKET_AUDIT_BATCH_MAX` **48**, `SOCKET_AUDIT_BATCH_FLUSH_MS` **200**; `SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS` **120000**. Envelopes de alta frequencia usam `omitTraceId` onde documentado; `meta.trace_id` no comando JSON-RPC continua quando o bridge injeta.
- **REST bridge (`sql.execute` unico)**: materializacao de stream com **creditos por janela** (como o relay): um pull inicial e novos `rpc:stream.pull` apenas quando a janela se esgota, em vez de um pull por chunk. Metrica `plug_rest_sql_stream_materialize_pulls_total`.
- **Timeout do bridge**: espera HTTP/Socket alinhada a `options.timeout_ms` de `sql.execute` / `sql.executeBatch` (`computeBridgeWaitTimeoutMs`); `body.timeoutMs` aceita ate **360000** ms (Zod + OpenAPI).
- **`api_version`**: repasse ao agente **preserva** o valor enviado pelo cliente; se ausente, usa `"2.5"` (REST batch item, comando unico e relay).
- **PayloadFrame (saida)**: opcao `PAYLOAD_SIGN_OUTBOUND=true` assina frames gerados pelo hub quando `PAYLOAD_SIGNING_KEY` esta configurada (`finishPayloadFrameEnvelope` / `encodePayloadFrame`).
- **OpenAPI**: schemas `SqlExecuteOptions`, `SqlExecuteBatchOptions` e `AgentCommandPagination` passam a declarar os mesmos `maximum` que o validador Zod (`AGENT_TIMEOUT_MS_LIMIT`, `AGENT_MAX_ROWS_LIMIT`, `AGENT_PAGE_SIZE_LIMIT`).
- **Documentacao**: `api_rest_bridge.md` (secao OpenAPI/Swagger); exemplos adicionais em `POST /agents/commands` (`pagination`, `execution_mode` preserve, `sql.cancel`, `rpc.discover`); `socket_relay_protocol.md` (teto 512 KiB para tentativa de gzip outbound); `communication_sync_plug_agente.md` (verificacao vs standard/guia plug_agente e nota sobre o exemplo Node do guia binario).
- **Handshake `agent:capabilities`**: `extensions.signatureAlgorithms` anuncia `["hmac-sha256"]`, alinhado ao exemplo do `socket_communication_standard.md` do plug_agente (assinatura de frame continua opcional).
- **Métricas REST bridge**: percentis p95/p99 de latencia usam **quickselect** compartilhado (`shared/utils/percentile.ts`).
- **Relay / `rpc_bridge`**: amostras de latencia por agente em **buffer circular** (`shared/utils/latency_ring_buffer.ts`); cleanup de streams/relay indexado por consumer/agent (**O(k)** no disconnect); `rpc:batch_ack` com varios IDs reutiliza **um** `JSON.stringify`+gzip por payload; logs de ack/stream em **DEBUG**.
- **Auditoria Socket**: opcao de **lote** (`SOCKET_AUDIT_BATCH_MAX` / `SOCKET_AUDIT_BATCH_FLUSH_MS`), flush no shutdown, gauge `plug_socket_audit_queued_events`.
- **Bridge REST e Socket (`agents:command`)**: `id` JSON-RPC **omitido** passa a receber **UUID gerado pelo servidor** antes do envio ao agente; a API **aguarda** `rpc:response` (HTTP `200` / resposta completa no Socket). Antes, `id` omitido era tratado como notification (HTTP `202` sem corpo de resultado).

### Removed

- **Ownership manual de `User` -> `Agent`**: removidas as rotas HTTP de mutacao `POST/DELETE /api/v1/me/agents` e `POST/DELETE/PUT /api/v1/users/:userId/agents`. `GET /api/v1/me/agents` e `GET /api/v1/users/:userId/agents` continuam apenas como leitura.
- **Mutacao HTTP do catalogo de agentes**: removidas `POST /api/v1/agents/catalog` e `PATCH /api/v1/agents/catalog/{agentId}`. O catalogo passa a ser mantido automaticamente pelo fluxo do agente; por HTTP, permanece apenas leitura e a desativacao administrativa.

### Migration

- **Operacao**: se precisares do comportamento anterior (auditoria 1 INSERT por evento, menos paralelismo REST, janela de pull menor, gzip sempre sincrono no bridge, buffer Engine.IO 1 MB, deflate WS ativo), define explicitamente `SOCKET_AUDIT_BATCH_MAX=1`, `SOCKET_AUDIT_BATCH_FLUSH_MS=150`, `SOCKET_REST_AGENT_MAX_INFLIGHT=8`, `SOCKET_REST_AGENT_MAX_QUEUE=16`, `SOCKET_REST_STREAM_PULL_WINDOW_SIZE=32`, `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES=0`, `SOCKET_IO_MAX_HTTP_BUFFER_BYTES=1000000`, `SOCKET_IO_PER_MESSAGE_DEFLATE=true`, `SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS=60000`, etc.
- Clientes que dependiam de **HTTP 202** ao **omitir** `id` devem:
  - passar a omitir `id` e consumir **HTTP 200** com `response` normalizada, **ou**
  - enviar explicitamente **`"id": null`** se o comportamento desejado continuar sendo fire-and-forget (notification).
- Clientes Socket em `agents:command` com a mesma expectativa de “notification sem `id`” devem usar **`id: null`** ou adaptar para a resposta com resultado.

### Added (Bridge e observabilidade)

- **Bridge latency traces**: vista SQL `bridge_latency_trace_hourly_rollups` (percentis horarios por canal/outcome/metodo); env `BRIDGE_LATENCY_TRACE_PHASES_MISMATCH_WARN_MS`, `BRIDGE_LATENCY_TRACE_REDACT_USER_ID`, `BRIDGE_LATENCY_TRACE_TRUNCATE_REQUEST_ID_CHARS`, `BRIDGE_LATENCY_TRACE_RELAY_RETENTION_DAYS`; metrica `plug_bridge_latency_trace_phases_mismatch_total`; retencao distinta para `channel = relay`; exemplo Grafana `docs/grafana/bridge_latency_trace_minimal.json`.
- **Documentacao**: `docs/configuration.md`, `docs/observability.md`, `docs/scaling_and_roadmap.md`, snippet `docs/snippets/payload_frame_client_encode.ts`.
- **Testes de contrato (`npm run test:contract`)**: `plug_agente_optional.contract.test.ts` resolve o checkout do agente por `PLUG_AGENTE_ROOT`, `../plug_agente` ou caminho Windows conhecido; valida OpenRPC (versao >= 2.5), existencia dos `schemas/*.json`, compilacao Ajv (draft 2020-12) e payloads exemplo cruzados com Zod (`bridgeCommandSchema`). Dev deps: `ajv`, `ajv-formats`.
- **`meta.outbound_compression`**: campo opcional `none` \| `gzip` \| `auto` no envelope JSON-RPC — validacao em `agent_command.ts`, OpenAPI `RpcMeta`, doc REST (`api_rest_bridge.md`).
- **PayloadFrame gzip (hub → agente)**: campo opcional `payloadFrameCompression` (`default` \| `none` \| `always`) no body de `POST /api/v1/agents/commands`, em `agents:command` e no envelope JSON de `relay:rpc.request` (junto a `conversationId` e `frame`). `default` usa modo **auto** (gzip so se menor que JSON UTF-8, como plug_agente `OutboundCompressionMode.auto`); `always` forca gzip mesmo quando expande. Capabilities do hub incluem `outboundCompressionMode: "auto"`.
- **`rest_sql_stream_materialize.ts`**: estado e passo puro de creditos do stream REST materializado extraidos de `rpc_bridge.ts` (modularizacao incremental).
- **`rest_agent_dispatch_queue.ts`**: fila e limite de inflight por agente (`acquireRestAgentDispatchSlot`) extraidos de `rpc_bridge.ts`; hook `wireRestAgentDispatchQueueMetrics` para `restPendingRejected`.
- **`rest_pending_requests.ts`**: mapa de JSON-RPC `id` (correlation) -> `PendingRequest`, contagem logica e helpers (`registerRestPendingRequest`, `forEachUniqueRestPendingRequest`, etc.) extraidos de `rpc_bridge.ts`.
- **`relay_idempotency_store.ts`**: mapas de idempotencia por conversa, timer de limpeza e `pruneExpiredRelayIdempotencyEntries` extraidos de `rpc_bridge.ts`.
- **`relay_stream_flow_state.ts`**: estado mutavel de backpressure do stream relay (creditos, chunks bufferizados, complete pendente) extraido de `rpc_bridge.ts`.
- **`relay_request_registry.ts`**: rotas relay pendentes (`RelayRequestRoute`), contagens por conversa/consumer, indices por socket e `registerRelayRequestRoute` / `removeRelayRequestRoute` extraidos de `rpc_bridge.ts`.
- **`bridge_relay_health_metrics.ts`**: circuit breaker por agente, amostras de latencia, contadores `relayMetrics`, falhas de decode de frame, `buildRelayHubMetricsSnapshot`, logger periodico (`scheduleRelayHubMetricsLogger`) e `resetRelayHubHealthAndMetrics` extraidos de `rpc_bridge.ts`.
- **`active_stream_registry.ts`**: rotas de stream ativas (REST + relay), indices por consumer/agent/conversa, `upsertActiveStreamRoute` / `removeActiveStreamRoute` / `resolveActiveStreamRoute` e integracao com `restSqlStreamMaterializeClearRequest` extraidos de `rpc_bridge.ts`.
- **`rpc_bridge_command_helpers.ts`**: helpers puros JSON-RPC / `BridgeCommand` (`pickResponseIds`, `toCorrelationIds`, `withBridgeMeta`, `resolveOutboundApiVersion`, `extractStreamIdFromRpcResponse`, `isBatchCommand`) extraidos de `rpc_bridge.ts`.
- **`rpc_bridge_relay_stream.ts`**: `createRelayStreamHandlers` e `emitRelayTimeoutResponse` (stream relay agente→consumer, backpressure, timeout + idempotencia) extraidos de `rpc_bridge.ts`; emissao ao consumer injetada via `EmitToConsumerFn`.
- **`rpc_bridge_agent_inbound.ts`**: eventos **do agente** (`rpc:response`, chunk, complete, ack, batch_ack) — REST pendente + relay + materializacao SQL stream — via `createRpcBridgeAgentInboundHandlers` (deps: `emitToConsumer`, `emitRpcStreamPullForRoute`); `rpc_bridge.ts` reexporta os mesmos nomes publicos.
- **`rpc_bridge_stream_pull.ts`**: `createRequestAgentStreamPull` — `agents:stream.pull` / creditos relay apos `rpc:stream.pull` ao agente (deps: `getAgentsNamespace`, `emitToConsumer`).
- **`rpc_bridge_dispatch_relay.ts`**: `createRpcBridgeRelayDispatch` — `dispatchRelayRpcToAgent`, `requestRelayStreamPull` (validacao frame, limites relay, idempotencia, timeout, emissao `rpc:request`).
- **`rpc_bridge_dispatch_command.ts`**: `createDispatchRpcCommandToAgent` — REST + Socket `agents:command` (pending requests, notificacao sem `id`, `sql.execute` stream aggregate); exporta `DispatchRpcCommandInput` / `DispatchRpcCommandResult`.
- **`rpc_bridge_lifecycle.ts`**: `cleanupConsumerStreamSubscriptions`, `cleanupAgentStreamSubscriptions`, `cleanupPendingRequestsForAgentSocket`, `cleanupConversationStreamSubscriptions`, `resetRpcBridgeMutableStores` (stores + timers); `rpc_bridge.resetSocketBridgeState` chama `resetRpcBridgeMutableStores` e anula refs aos namespaces Socket.IO.
- **`PAYLOAD_SIGN_OUTBOUND`**, **`SOCKET_REST_STREAM_PULL_WINDOW_SIZE`** (`env` + `.env.example`).
- **`merge_sql_stream_rpc_response.ts`**, **`extractSqlStatementTimeoutMs` / `computeBridgeWaitTimeoutMs`** em `command_transformers.ts`.
- Variavel de ambiente **`BRIDGE_LOG_JSONRPC_AUTO_ID`**: quando `true`, log **INFO** estruturado ao auto-atribuir `id`.
- Em **`NODE_ENV=development`**, o mesmo evento e emitido em nivel **DEBUG** (sem variavel).

## Roadmap tecnico

- **Modularizar `rpc_bridge.ts`**: *feito* — modulos acima + `rpc_bridge_stream_pull.ts`, `rpc_bridge_dispatch_relay.ts`, `rpc_bridge_dispatch_command.ts`, `rpc_bridge_lifecycle.ts`; `rpc_bridge.ts` concentra namespaces Socket.IO, `emitToConsumer`, metricas e composicao das factories.
