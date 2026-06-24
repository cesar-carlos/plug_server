# Observabilidade

Este documento concentra metricas, traces, alertas e sinais operacionais do
hub. Para **limites de acesso, quotas e respostas 429/503**, ver
[`docs/limits/limites_acesso_e_quotas.md`](limits/limites_acesso_e_quotas.md).
Regras Prometheus prontas para rate limits:
[`docs/observability/alerts/rate_limits.yml`](observability/alerts/rate_limits.yml).
Regras de negocio e semantica de autorizacao ficam em
`docs/api/client_agent_business_rules.md`. Defaults e variaveis ficam em
`docs/configuration.md`. Tuning operacional fica em
`docs/performance/performance_hub_agent.md`. Mapa geral: `docs/README.md`.

## Endpoints

- `GET /metrics` — texto Prometheus (alias util fora do prefixo `/api/v1`).
- `GET /api/v1/metrics` — mesmo payload.

> **Nota — `Retry-After` derivado do agente.** Erros JSON-RPC `-32013` com
> `error.data.retry_after_ms` ou `error.data.reset_at` (notavelmente
> `client_token.getPolicy` (introduzido no perfil 2.7) sao propagados pelo `POST /api/v1/agents/commands`
> como header HTTP `Retry-After`. Nao gera contador Prometheus dedicado; o
> sinal de volume continua em `plug_socket_relay_rate_limit_*` e nas series
> de erros do agente. Detalhes: `docs/api/api_rest_bridge.md`.

## Comeco rapido

Se fores olhar so o minimo:

1. valida `GET /metrics`
2. acompanha throughput/falhas do bridge REST
3. acompanha backlog/p95 da fila relay outbound
4. acompanha bloqueios/rate limits e falhas de auditoria

## Metricas uteis (exemplos PromQL)

Ajuste nomes ao scrape target do teu Prometheus. Exemplos genericos:

```promql
# Taxa de pedidos REST ao bridge de agentes (counter real: plug_rest_bridge_requests_total)
# Nota: estes contadores incrementam no handler HTTP depois de auth + rate limits da rota;
# rejeições 401/429 antes do handler não entram aqui (usar plug_rest_http_rate_limit_* quando aplicável).
rate(plug_rest_bridge_requests_total[5m])

# Sucesso vs falha (cada pedido incrementa `requests_total` uma vez)
rate(plug_rest_bridge_requests_success_total[5m])
rate(plug_rest_bridge_requests_failed_total[5m])

# Fracao de sucesso (~1.0 se estavel); `clamp_min` evita divisao por zero no arranque
rate(plug_rest_bridge_requests_success_total[5m])
  / clamp_min(rate(plug_rest_bridge_requests_total[5m]), 0.001)

# Pub/sub `client:custom.*` via Socket: novas emissoes apos `socket:event.publish` (exclui replay idempotente)
rate(plug_socket_custom_event_publish_via_socket_total[5m])

# Fracao de replays idempotent sobre aceites (REST + Socket)
rate(plug_socket_custom_event_publish_idempotent_replay_total[5m])
  / clamp_min(rate(plug_socket_custom_event_publish_accepted_total[5m]), 0.001)

# Nota: `plug_socket_custom_event_publish_via_socket_total` sobe apenas em publicacoes Socket que levam a uma **nova** emissao ao sink (nao conta `idempotentReplay: true`). `plug_socket_custom_event_publish_accepted_total` inclui REST e Socket apos emissao bem-sucedida. `plug_socket_custom_event_publish_rejected_total` incrementa **uma vez** por falha de `executeClientSocketEventPublish` (REST ou Socket) e tambem em falhas pre-`execute` no Socket (validacao, `403`, etc.); o teto de serializacao de idempotencia incrementa `plug_socket_custom_event_publish_idempotency_serialization_cap_rejected_total` **e** `publish_rejected_total`.

# Redis adapter activo, mas a contagem distribuida falhou e o hub emitiu mesmo assim (best-effort)
rate(plug_socket_custom_event_publish_distributed_recipient_count_failed_total[5m])
rate(plug_socket_custom_event_publish_recipient_count_best_effort_total[5m])
rate(plug_socket_custom_event_publish_recipient_cap_unverified_total[5m])

# Gauge: chaves distintas com cadeia de serializacao de idempotencia ainda activa neste processo (ver `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS`)
plug_socket_custom_event_publish_idempotency_serialization_tracked_keys

# Rejeicoes por teto de chaves distintas em serializacao (`503` ao publicar com nova chave quando o mapa esta cheio)
rate(plug_socket_custom_event_publish_idempotency_serialization_cap_rejected_total[5m])
# Nota: esse `503` inclui `details.retry_after_ms` = `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS`; no REST o hub pode tambem definir o header `Retry-After`.

# Aprovacao de acesso client-agent: joins em tempo real na room `consumer:client-agent:*` (por processo; ver docs de escala)
rate(plug_socket_consumer_client_agent_room_grant_attempts_total[5m])
rate(plug_socket_consumer_client_agent_room_grant_join_failures_total[5m])
rate(plug_socket_consumer_client_agent_room_grant_fetch_failures_total[5m])

# Reconciliacao periodica dessas rooms (repara drift apos falha de join/leave ou churn entre replicas)
rate(plug_socket_consumer_client_agent_room_reconcile_runs_total[5m])
rate(plug_socket_consumer_client_agent_room_reconcile_rooms_joined_total[5m])
rate(plug_socket_consumer_client_agent_room_reconcile_rooms_left_total[5m])
rate(plug_socket_consumer_client_agent_room_reconcile_failures_total[5m])
rate(plug_socket_consumer_client_agent_room_reconcile_clients_deferred_total[5m])
rate(plug_socket_consumer_client_agent_room_reconcile_ticks_skipped_total[5m])
plug_socket_consumer_client_agent_room_reconcile_in_flight

# Bootstrap assíncrono das rooms derivadas após `connection:ready`
rate(plug_socket_consumer_client_agent_room_bootstrap_started_total[5m])
rate(plug_socket_consumer_client_agent_room_bootstrap_completed_total[5m])
rate(plug_socket_consumer_client_agent_room_bootstrap_failed_total[5m])
plug_socket_consumer_client_agent_room_bootstrap_pending
plug_socket_consumer_client_agent_room_bootstrap_duration_avg_ms

# Subscricoes custom: 403 (principal nao-Client) vs outras rejeicoes
rate(plug_socket_custom_event_subscription_forbidden_total[5m])
rate(plug_socket_custom_event_subscription_rejected_total[5m])

# Pulls internos ao materializar stream SQL via REST
rate(plug_rest_sql_stream_materialize_pulls_total[5m])
rate(plug_rest_sql_stream_materialize_completed_total[5m])
rate(plug_rest_sql_stream_materialize_rows_merged_sum[5m])

# Bridge por metodo RPC e canal
sum by (channel, method, outcome) (rate(plug_bridge_rpc_method_requests_total[5m]))
avg by (channel, method, outcome) (plug_bridge_rpc_method_latency_p95_ms)
histogram_quantile(0.95, sum by (le, channel, method, outcome) (rate(plug_bridge_rpc_method_latency_bucket[5m])))
sum by (channel, method, outcome) (rate(plug_bridge_rpc_method_latency_count[5m]))

# Cortes por orçamento na materialização REST (streams grandes → preferir Socket)
rate(plug_rest_sql_stream_materialize_row_limit_exceeded_total[5m])
rate(plug_rest_sql_stream_materialize_chunk_limit_exceeded_total[5m])

# Gauge: materializações REST ainda sem rpc:complete
plug_rest_sql_stream_materialize_streams_in_flight

# Rejeições REST antes do dispatch (motivo separado; legado = soma dos três)
rate(plug_socket_relay_rest_global_pending_cap_rejected_total[5m])
rate(plug_socket_relay_rest_agent_queue_full_rejected_total[5m])
rate(plug_socket_relay_rest_agent_queue_wait_timeout_rejected_total[5m])
rate(plug_socket_relay_rest_pending_rejected_total[5m])

# Rate limiting relay por identidade (scope=user|anon)
rate(plug_socket_relay_rate_limit_conversation_start_rejected_total[5m])
rate(plug_socket_relay_rate_limit_request_rejected_total[5m])
rate(plug_socket_relay_rate_limit_stream_pull_credits_rejected_total[5m])
sum by (scope) (plug_socket_relay_rate_limit_stream_pull_credits_granted_total)

# Fila por agente no bridge REST (agregado, baixa cardinalidade)
plug_socket_relay_rest_dispatch_inflight_total
plug_socket_relay_rest_dispatch_queued_waiters_total
plug_socket_relay_rest_dispatch_agents_with_queue
plug_socket_relay_rest_dispatch_max_queue_depth

# HTTP Express: rate limit antes do parse JSON em `/api/v1` + limite da rota `/agents/commands`
rate(plug_rest_http_rate_limit_global_rejected_total[5m])
rate(plug_rest_http_rate_limit_agents_commands_user_rejected_total[5m])
rate(plug_rest_http_rate_limit_agents_commands_ip_rejected_total[5m])
rate(plug_rest_http_rate_limit_agents_self_profile_rejected_total[5m])
rate(plug_rest_http_rate_limit_client_thumbnail_rejected_total[5m])
rate(plug_rest_http_rate_limit_client_password_recovery_request_rejected_total[5m])

# Redis opcional dos rate limits HTTP (estado partilhado entre replicas)
plug_rest_http_rate_limit_redis_url_configured
plug_rest_http_rate_limit_redis_store_active
rate(plug_rest_http_rate_limit_redis_connection_events_total[5m])
rate(plug_rest_http_rate_limit_redis_fallback_events_total[5m])
rate(plug_rest_http_rate_limit_redis_runtime_command_errors_total[5m])
plug_rest_http_rate_limit_redis_circuit_open
rate(plug_rest_http_rate_limit_redis_circuit_opened_total[5m])

# Redis opcional dos rate limits Socket
plug_socket_rate_limit_redis_url_configured
plug_socket_rate_limit_redis_store_active
plug_socket_rate_limit_redis_circuit_open
rate(plug_socket_rate_limit_redis_fallback_events_total[5m])
rate(plug_socket_rate_limit_redis_runtime_command_errors_total[5m])

# Socket.IO Redis adapter (rooms/pubsub entre replicas)
plug_socket_io_redis_adapter_url_configured
plug_socket_io_redis_adapter_active
plug_socket_io_redis_adapter_attached_servers_total
rate(plug_socket_io_redis_adapter_connection_events_total[5m])
rate(plug_socket_io_redis_adapter_fallback_events_total[5m])
rate(plug_socket_io_redis_adapter_runtime_errors_total[5m])

# Retries de transacoes Prisma (serializacao/deadlock) em caminhos criticos
rate(plug_prisma_transaction_retry_attempts_total[5m])
rate(plug_prisma_transaction_retries_exhausted_total[5m])
rate(plug_prisma_transaction_retry_attempts_total{operation="client_registration_decision"}[5m])
rate(plug_prisma_transaction_retry_attempts_total{operation="user_registration_decision"}[5m])

# Redis opcional da idempotencia de `client:custom.*`
plug_socket_custom_event_idempotency_redis_url_configured
plug_socket_custom_event_idempotency_redis_store_active
rate(plug_socket_custom_event_idempotency_redis_connection_events_total[5m])
rate(plug_socket_custom_event_idempotency_redis_fallback_events_total[5m])
rate(plug_socket_custom_event_idempotency_redis_command_errors_total[5m])
rate(plug_socket_custom_event_idempotency_redis_replay_hits_total[5m])
rate(plug_socket_custom_event_idempotency_redis_conflicts_total[5m])
rate(plug_socket_custom_event_idempotency_redis_locks_acquired_total[5m])
rate(plug_socket_custom_event_idempotency_redis_lock_contention_total[5m])
rate(plug_socket_custom_event_idempotency_redis_lock_wait_timeouts_total[5m])
rate(plug_socket_custom_event_idempotency_redis_writes_total[5m])
rate(plug_socket_custom_event_idempotency_redis_lock_extensions_total[5m])

# Per-command latency histograms (ms) — alerte em p95 alto antes do circuit breaker abrir
histogram_quantile(0.95, sum by (le, op) (rate(plug_socket_rate_limit_redis_command_duration_ms_bucket[5m])))
histogram_quantile(0.95, sum by (le) (rate(plug_rest_http_rate_limit_redis_command_duration_ms_bucket[5m])))
histogram_quantile(0.95, sum by (le, op) (rate(plug_socket_custom_event_idempotency_redis_command_duration_ms_bucket[5m])))
histogram_quantile(0.95, sum by (le) (rate(plug_socket_io_redis_adapter_connect_duration_ms_bucket[5m])))

# Tracked keys (cardinality aproximada) do rate-limit Socket
plug_socket_rate_limit_redis_tracked_keys_window_size
rate(plug_socket_rate_limit_redis_tracked_keys_seen_total[5m])

# Redis Streams opcional para entrega at-least-once de `client:custom.*` cross-replica
plug_agent_event_stream_url_configured
plug_agent_event_stream_active
rate(plug_agent_event_stream_appends_total[5m])
rate(plug_agent_event_stream_backlog_reads_total[5m])
rate(plug_agent_event_stream_backlog_entries_delivered_total[5m])
rate(plug_agent_event_stream_acks_total[5m])
rate(plug_agent_event_stream_dropped_total[5m])
rate(plug_agent_event_stream_fallback_events_total[5m])
histogram_quantile(0.95, sum by (le, op) (rate(plug_agent_event_stream_command_duration_ms_bucket[5m])))

# Pipeline de fan-out (`MULTI/EXEC`) — uma round-trip independentemente do nro de recipients
rate(plug_agent_event_stream_batch_appends_total[5m])
rate(plug_agent_event_stream_batch_partial_failures_total[5m])
# Distribuicao do tamanho dos batches (sustained shift para a direita = rooms maiores)
histogram_quantile(0.95, sum by (le) (rate(plug_agent_event_stream_batch_size_bucket[5m])))
# Razao de falhas parciais por batch — alerte > 5% (XADD individual rejeitado dentro de EXEC bem-sucedido)
rate(plug_agent_event_stream_batch_partial_failures_total[5m])
  / clamp_min(rate(plug_agent_event_stream_batch_appends_total[5m]), 0.001)

# Rate-limit Socket: rollback atomico via Lua `consume_or_rollback` (1 RTT em vez de 2 no deny path)
rate(plug_socket_rate_limit_consume_atomic_rollbacks_total[5m])
# Compare contra rejected_total: deve seguir junto, com `atomic_rollbacks_total <= rejected_total`
rate(plug_socket_rate_limit_redis_rejected_total[5m])

# Boundary-burst telemetry (Sprint 11) + atomic rollback (Sprint P2): mantenha as 3 series juntas
rate(plug_socket_rate_limit_window_resets_total[5m])
rate(plug_socket_rate_limit_window_saturations_total[5m])
rate(plug_socket_rate_limit_consume_atomic_rollbacks_total[5m])

# Dedupe de `fetchSockets()` no publish (cluster-wide RPC reusada entre count + principal-id resolution)
rate(plug_socket_custom_event_publish_fetch_sockets_dedupes_total[5m])

# Relay: pedidos aceites vs rejeitados por rate-limit
rate(plug_socket_relay_rate_limit_request_allowed_total[5m])
rate(plug_socket_relay_rate_limit_request_rejected_total[5m])

# Fila por agente no relay Socket
plug_socket_relay_dispatch_inflight_total
plug_socket_relay_dispatch_total_queued_waiters
rate(plug_socket_relay_dispatch_queue_full_rejected_total[5m])
rate(plug_socket_relay_dispatch_queue_wait_timeout_rejected_total[5m])

# Fila hub→consumer relay (gzip async serializado por requestId): taxa de jobs e falhas
rate(plug_socket_relay_outbound_queue_jobs_finished_total[5m])
rate(plug_socket_relay_outbound_queue_jobs_failed_total[5m])

# Streams relay abertos sem rpc:complete ou com vida longa demais
rate(plug_socket_relay_stream_idle_timeouts_total[5m])
rate(plug_socket_relay_stream_lifetime_timeouts_total[5m])
rate(plug_socket_relay_stream_dispatch_slots_released_on_open_total[5m])

# Conversas relay expiradas por idle (sweep SOCKET_RELAY_CONVERSATION_IDLE_TIMEOUT_MS)
rate(plug_socket_relay_conversations_expired_total[5m])

# Custos do hot path relay (média por fase)
plug_socket_relay_overload_check_avg_ms
plug_socket_relay_frame_decode_avg_ms
plug_socket_relay_command_validate_avg_ms
plug_socket_relay_bridge_encode_avg_ms
plug_socket_relay_chunk_forward_jobs_avg_ms
plug_socket_relay_buffer_drain_avg_ms

# Gauge: `requestId` com cadeia de emit ainda nao drenada (0 em repouso)
plug_socket_relay_outbound_queue_inflight_request_ids

# Socket legado agents:command (mesma janela/max que REST por utilizador; contador separado)
rate(plug_socket_agents_command_rate_limit_allowed_total[5m])
rate(plug_socket_agents_command_rate_limit_rejected_total[5m])

# Sessao exclusiva por agente no namespace /agents (registo vs segundo agent:register)
rate(plug_agent_session_rejected_active_total[5m])
rate(plug_agent_session_takeover_disconnect_total[5m])
rate(plug_agent_session_register_rate_limited_total[5m])

# Idle enforcement: sweeps desligam sockets /agents registados ou /consumers ligados inactivos
rate(plug_agent_idle_timeout_disconnect_total[5m])
rate(plug_consumer_idle_timeout_disconnect_total[5m])

# Engine.IO e erros de namespace (handshake, adapter Redis, socket individual)
sum by (code) (rate(plug_socket_engine_connection_errors_total[5m]))
sum by (namespace) (rate(plug_socket_namespace_adapter_errors_total[5m]))
sum by (namespace) (rate(plug_socket_namespace_socket_errors_total[5m]))

# Perfil/capacidade dos agentes e respostas de `agent.getHealth`
rate(plug_socket_agents_capability_profiles_total[5m])
rate(plug_socket_agents_capability_agent_get_health_capable_total[5m])
rate(plug_socket_agents_ready_legacy_payload_total[5m])
rate(plug_socket_agents_ready_invalid_partial_payload_total[5m])
rate(plug_socket_agents_health_responses_total[5m])
rate(plug_socket_agents_health_errors_total[5m])
plug_socket_agents_health_last_healthy
plug_socket_agents_health_last_degraded
plug_socket_agents_health_last_sql_queue_current_size
plug_socket_agents_health_last_sql_queue_max_size
plug_socket_agents_health_last_active_workers
plug_socket_agents_health_last_max_workers
plug_socket_agents_health_last_sql_queue_rejections
plug_socket_agents_health_last_sql_queue_timeouts
plug_socket_agents_health_last_sql_queue_avg_wait_time_ms
plug_socket_agents_health_last_query_count
plug_socket_agents_health_last_query_errors
plug_socket_agents_health_last_query_success_rate
plug_socket_agents_health_last_avg_latency_ms
plug_socket_agents_health_last_p95_latency_ms
plug_socket_agents_health_last_p99_latency_ms
# Ex.: ratio de conflitos de sessao — comparar com taxa de registos bem-sucedidos noutro painel
# (SLI sugerida: pico de session_active apos restauro de backup em varios PCs)

# Contas bloqueadas (login/refresh/socket negados por status; sem PII nos labels)
rate(plug_auth_login_blocked_total[5m])
rate(plug_auth_refresh_blocked_total[5m])
rate(plug_auth_socket_blocked_total[5m])

# Alteracoes de estado por admin (bloquear/desbloquear via PATCH /api/v1/admin/users/:id/status)
rate(plug_admin_user_status_set_total[5m])

# Rate limit no PATCH de estado (por admin)
rate(plug_rest_http_rate_limit_admin_user_status_rejected_total[5m])

# Alertas (exemplos): muitas tentativas de login bloqueadas (possivel abuso ou lista de contas)
rate(plug_auth_login_blocked_total[5m]) > 0.5

# Escritas versionadas de perfil de agente (HTTP / socket / pull sync) e broadcast para clientes
rate(plug_agent_profile_writes_committed_total[5m])
rate(plug_agent_profile_writes_idempotent_total[5m])
rate(plug_agent_profile_writes_conflict_total[5m])
rate(plug_agent_profile_writes_pull_sync_version_content_conflict_total[5m])
rate(plug_agent_profile_writes_skipped_stale_remote_version_total[5m])
rate(plug_agent_profile_writes_skipped_missing_timestamp_total[5m])
rate(plug_agent_profile_writes_skipped_stale_timestamp_total[5m])
rate(plug_agent_profile_writes_legacy_no_expected_version_total[5m])
rate(plug_agent_profile_broadcast_emitted_total[5m])
rate(plug_agent_profile_broadcast_failed_total[5m])

# Manutencao de dados Agent
rate(plug_agent_profile_maintenance_prune_runs_total[5m])
rate(plug_agent_profile_maintenance_revisions_deleted_total[5m])
rate(plug_agent_profile_maintenance_idempotency_deleted_total[5m])
rate(plug_agent_profile_maintenance_prune_failed_total[5m])
rate(plug_client_agent_access_expiry_runs_total[5m])
rate(plug_client_agent_access_requests_expired_total[5m])
rate(plug_client_agent_access_expired_tokens_deleted_total[5m])
rate(plug_client_agent_access_expiry_failed_total[5m])

# Client — GET /api/v1/client/me/agents (listagem e detalhe)
rate(plug_client_me_agents_list_responses_total[5m])
rate(plug_client_me_agents_list_hub_connected_true_total[5m])
rate(plug_client_me_agents_detail_responses_total[5m])
rate(plug_client_me_agents_detail_hub_connected_true_total[5m])

# Client — POST /api/v1/client/me/agents (agregados por pedido HTTP)
rate(plug_client_agent_access_request_post_requested_total[5m])
rate(plug_client_agent_access_request_post_new_total[5m])
rate(plug_client_agent_access_request_post_reopened_total[5m])
rate(plug_client_agent_access_request_post_debounced_total[5m])
rate(plug_client_agent_access_request_post_already_approved_total[5m])
rate(plug_rest_http_rate_limit_client_me_agents_post_rejected_total[5m])
plug_agent_data_maintenance_pending_operations
```

Regras de transicao e API: `docs/api/user_status.md`.

Use `GET /metrics` num ambiente de desenvolvimento e copie os nomes exatos dos contadores expostos (podem evoluir com o CHANGELOG).

### Leituras novas para este pacote

- `plug_socket_custom_event_publish_distributed_recipient_count_failed_total` > 0 indica falha de `fetchSockets()` no fan-out distribuido; cruze com `..._recipient_count_best_effort_total` para ver quantos publishes seguiram em degradacao controlada.
- `plug_socket_consumer_client_agent_room_bootstrap_pending` e `..._duration_avg_ms` mostram o custo do backfill assíncrono das rooms derivadas depois de `connection:ready`.

- `plug_prisma_transaction_retry_attempts_total` a subir sem erro final indica contenção transitória recuperada por retry.
- `plug_prisma_transaction_retries_exhausted_total` > 0 exige olhar locks, `40001`, `40P01` e tamanho das transações.
- `plug_socket_consumer_client_agent_room_reconcile_rooms_joined_total` / `rooms_left_total` mostram drift real corrigido pelo sweep.
- `plug_socket_io_redis_adapter_attached_servers_total` ajuda a confirmar em testes locais se mais de um hub do mesmo processo anexou o adapter distribuído.
- `plug_agent_idle_timeout_disconnect_total` e `plug_consumer_idle_timeout_disconnect_total` sobem quando sweeps desligam sockets inactivos; picos sustentados podem indicar clientes sem heartbeat/trafego periodico.
- `plug_socket_engine_connection_errors_total{code="unsupported_protocol"}` aponta para clientes com versao Engine.IO incompativel; `bad_request` para handshakes malformados.
- `plug_socket_namespace_adapter_errors_total` correlaciona com falhas do adapter Redis (`SOCKET_IO_REDIS_ADAPTER_URL`); `plug_socket_namespace_socket_errors_total` isola erros por socket ligado.

## Snapshot minimo para tuning hub ↔ agente

Quando fizer tuning no bridge/relay, recolha estes pontos no mesmo intervalo
antes e depois da mudanca:

- `plug_socket_relay_outbound_queue_backlog`
- `plug_socket_relay_outbound_queue_job_duration_p95_ms`
- `plug_socket_relay_bridge_encode_avg_ms`
- `plug_socket_relay_frame_decode_avg_ms`
- `plug_rest_bridge_requests_total` e `plug_rest_bridge_requests_failed_total`
- `plug_socket_relay_rest_global_pending_cap_rejected_total`
- `plug_socket_audit_writes_attempted_total` e `plug_socket_audit_writes_sample_skipped_total`
- `plug_rest_sql_stream_materialize_completed_total`

Isto cobre capacidade, custo de CPU no caminho quente, impacto de auditoria e
degradacao funcional. Para presets de tuning e rollout, ver
`docs/performance/performance_hub_agent.md`.

## Tabela PostgreSQL `bridge_latency_traces` (latencia por fase)

Com `BRIDGE_LATENCY_TRACE_ENABLED=true`, o hub regista tempos por comando para: `POST /api/v1/agents/commands`, `agents:command` em `/consumers`, e pedidos `relay:rpc.request` (canal `relay`). A escrita e assincrona em lote (`BRIDGE_LATENCY_TRACE_*`), com limite de fila em memoria (`BRIDGE_LATENCY_TRACE_MAX_QUEUE`, defeito actual `50000`). Retencao: `BRIDGE_LATENCY_TRACE_RETENTION_*` + prune periodico (como auditoria). No shutdown, `flushPendingBridgeLatencyTraces()` drena a fila.

**Amostragem:** `BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT` aplica-se a comandos **bem-sucedidos rapidos**; outcomes `error`, `timeout` e `abort` gravam sempre (quando a sessao de trace existe). `BRIDGE_LATENCY_TRACE_SLOW_TOTAL_MS` (> 0) forca persistencia se `total_ms` for igual ou superior.

**Colunas uteis:** `phases_sum_ms` (soma das fases em `phases_ms`), `phases_schema_version` (versao do conjunto de chaves; hoje 1), `total_ms` (parede). Comparar `phases_sum_ms` com `total_ms` ajuda a detetar fases em falta.

**Prometheus:** `plug_bridge_latency_trace_*` em `GET /metrics` (fila, escritas, drops, `persist_skipped`, `phases_mismatch`, prune). **Nao** expor `conversation_id` ou outros IDs de alta cardinalidade como *labels* Prometheus; correlacao fica na tabela / traces, nao nas series agregadas.

**OpenTelemetry:** `BRIDGE_LATENCY_TRACE_OTEL_ENABLED=true` cria span `bridge.command` por sessao (e necessario tracer configurado na app).

**Privacidade (antes de enfileirar):** `BRIDGE_LATENCY_TRACE_REDACT_USER_ID=true` grava `user_id` como NULL. `BRIDGE_LATENCY_TRACE_TRUNCATE_REQUEST_ID_CHARS` (> 0) corta o `request_id` persistido (reduz vazamento de correlacao em logs/DB).

**Consistencia `total_ms` vs fases:** `BRIDGE_LATENCY_TRACE_PHASES_MISMATCH_WARN_MS` (> 0) incrementa `plug_bridge_latency_trace_phases_mismatch_total` e regista DEBUG quando `|total_ms - phases_sum_ms|` excede o limiar (fases em falta ou relogio).

**Retencao relay:** `BRIDGE_LATENCY_TRACE_RELAY_RETENTION_DAYS` (opcional) aplica-se apenas a linhas com `channel = 'relay'`; se vazio, usa o mesmo prazo que `BRIDGE_LATENCY_TRACE_RETENTION_DAYS`.

### Materialized view `bridge_latency_trace_hourly_rollups`

`bridge_latency_trace_hourly_rollups` agora e **materialized view** (nao mais
VIEW normal). O objetivo e evitar re-agregar `bridge_latency_traces` inteira a
cada SELECT de dashboard. O refresh corre via
`REFRESH MATERIALIZED VIEW CONCURRENTLY`, coordenado por advisory lock entre
replicas. Intervalo: `BRIDGE_LATENCY_TRACE_ROLLUP_REFRESH_INTERVAL_MINUTES`
(defeito `10`; `0` desativa o scheduler).

Consulta tipica:

```sql
SELECT * FROM bridge_latency_trace_hourly_rollups
WHERE hour_utc > now() AT TIME ZONE 'UTC' - interval '24 hours'
ORDER BY hour_utc DESC, request_count DESC
LIMIT 50;
```

Nota operacional:

- a migracao cria indice unico na chave natural (`hour_utc`, `channel`, `outcome`, `json_rpc_method`) para suportar `CONCURRENTLY`;
- se o refresh falhar, leitores continuam a ver o **snapshot anterior** da materialized view;
- o refresh e seguro em multi-replica porque apenas uma replica vence o advisory lock por vez.

Exemplo minimo de dashboard Grafana (Prometheus): `docs/grafana/bridge_latency_trace_minimal.json` — apos importar, associa um datasource Prometheus ao painel.

Fases tipicas em `phases_ms` (REST / consumer; relay inclui `consumer_frame_decode_ms`, `relay_preflight_ms`, `relay_forward_to_consumer_ms`, `relay_stream_duration_ms` quando aplicavel):

| Chave | Significado |
| --- | --- |
| `transform_ms` | Paginacao, normalizacao JSON-RPC, atribuicao de `id` no hub |
| `dispatch_preflight_ms` | Validacao, registry, capacidade REST pendente |
| `queue_wait_ms` | Espera na fila por agente (`SOCKET_REST_AGENT_*`) |
| `encode_ms` | `encodePayloadFrameBridge` (gzip omitido abaixo de `PAYLOAD_FRAME_COMPRESS_MIN_BYTES`; ver `docs/configuration.md`) |
| `emit_to_socket_ms` | `emit` de `rpc:request` |
| `agent_to_hub_ms` | Do fim do emit ate a entrada sincrona do handler `rpc:response` |
| `inbound_decode_ms` | `decodePayloadFrameAsync` |
| `pending_resolve_ms` | Do fim do decode ate `resolve` da promessa REST/socket (inclui merge de stream SQL quando aplicavel) |
| `normalize_ms` | Serializacao HTTP (`normalizeAgentRpcResponse`) |
| `response_write_ms` | `res.json` ou `emit(agents:command_response)` |

Exemplo de analise (percentil aproximado do tempo agente+rede, em ms):

```sql
SELECT
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (phases_ms->>'agent_to_hub_ms')::float)
    AS p95_agent_to_hub_ms
FROM bridge_latency_traces
WHERE created_at > now() - interval '1 hour'
  AND channel = 'rest'
  AND outcome = 'success';
```

Em producao, mantem a amostragem baixa (por exemplo 1–5%) para limitar I/O na base de dados.

### Alertas sugeridos (exemplos)

Ajusta `for` e limiares ao teu tráfego.

```promql
# Relay: chunks descartados por backpressure (deveria ser raro)
rate(plug_socket_relay_chunks_dropped_total[5m]) > 0.1

# Relay: emissões descartadas quando consumer desconecta durante stream
rate(plug_socket_relay_emit_discarded_consumer_gone_total[5m]) > 0

# Relay: conversas expiradas por idle (normal; picos sustentados podem indicar clientes que abrem conversas e nunca fecham)
rate(plug_socket_relay_conversations_expired_total[5m]) > 0.5

# Idle enforcement: picos de disconnect por inactividade (ajustar limiar ao trafego base)
rate(plug_agent_idle_timeout_disconnect_total[5m]) > 0.2
rate(plug_consumer_idle_timeout_disconnect_total[5m]) > 0.5

# Engine.IO: erros de handshake/transport (scanners, protocol mismatch, TLS/proxy)
sum(rate(plug_socket_engine_connection_errors_total[5m])) > 0.1

# Namespace: falhas do adapter Redis ou erros por socket ligado
sum(rate(plug_socket_namespace_adapter_errors_total[5m])) > 0
sum(rate(plug_socket_namespace_socket_errors_total[5m])) > 0.05

# Fila outbound relay: backlog crescente (jobs enfileirados - concluídos)
plug_socket_relay_outbound_queue_backlog > 50

# Fila outbound relay: tails órfãos (jobs zumbis / hung)
plug_socket_relay_outbound_queue_orphaned_request_ids > 0
rate(plug_socket_relay_outbound_queue_orphaned_tails_swept_total[5m]) > 0

# Fila outbound relay: percentil p95 da duração dos jobs acima de limiar
plug_socket_relay_outbound_queue_job_duration_p95_ms > 100

# Fila outbound relay: percentil p99 da duração dos jobs acima de limiar
plug_socket_relay_outbound_queue_job_duration_p99_ms > 200

# Cache de overload stale (refresh parado)
rate(plug_socket_relay_outbound_queue_overload_state_refresh_total[5m]) == 0

# Shed load no namespace /consumers quando a fila relay entra em overload
rate(plug_socket_relay_outbound_queue_overload_rejected_total[5m]) > 0

# Circuito do agente a abrir frequentemente
rate(plug_socket_relay_circuit_open_rejects_total[5m]) > 0.05

# Redis dos rate limits HTTP em fallback/circuito aberto
plug_rest_http_rate_limit_redis_circuit_open > 0
rate(plug_rest_http_rate_limit_redis_runtime_command_errors_total[5m]) > 0.1

# Redis dos rate limits Socket em fallback/circuito aberto
plug_socket_rate_limit_redis_circuit_open > 0
rate(plug_socket_rate_limit_redis_fallback_events_total[5m]) > 0.1
rate(plug_socket_rate_limit_redis_runtime_command_errors_total[5m]) > 0.1

# Relay Socket: fila por agente crescendo ou rejeitando overload
plug_socket_relay_dispatch_total_queued_waiters > 0
rate(plug_socket_relay_dispatch_queue_full_rejected_total[5m]) > 0
rate(plug_socket_relay_dispatch_queue_wait_timeout_rejected_total[5m]) > 0

# PayloadFrame: assinatura HMAC rejeitada (investigar key_id, rotacao ou segredo incorreto)
rate(plug_payload_frame_signature_rejected_total[5m]) > 0

# Contrato inbound do plug_agente: strict rejeitando payloads fora do contrato
rate(plug_socket_agents_inbound_contract_validation_failed_total[5m]) > 0

# Contrato inbound em warn: usar durante staging/rollout para encontrar drift antes de strict
rate(plug_socket_agents_inbound_contract_validation_warn_total[5m]) > 0

# Delivery guarantee: retry por falta de ACK esgotado por caminho REST/relay
rate(plug_socket_bridge_ack_retry_exhausted_total{path="rest"}[5m]) > 0
rate(plug_socket_bridge_ack_retry_exhausted_total{path="relay"}[5m]) > 0

# Backoff propagado ao cliente Socket; picos podem indicar agente saturado ou policy externa
rate(plug_socket_consumers_retry_after_ms_propagated_total[5m]) > 0
rate(plug_socket_agents_command_retry_after_seconds_propagated_total[5m]) > 0

# Agentes registados com perfil antigo ou desconhecido
rate(plug_socket_agents_capability_profiles_total{status!="current"}[15m]) > 0

# REST bridge: muitas falhas
rate(plug_rest_bridge_requests_failed_total[5m])
  / clamp_min(rate(plug_rest_bridge_requests_total[5m]), 0.001) > 0.15

# Auditoria: eventos descartados por amostragem (esperado se amostragem < 100; em produção o defeito sem env é 25)
rate(plug_socket_audit_writes_sample_skipped_total[5m])

# Bridge latency traces: fila em memoria cheia (perda de amostras)
rate(plug_bridge_latency_trace_writes_dropped_queue_full_total[5m]) > 0

# Bridge latency traces: falhas de escrita persistentes
rate(plug_bridge_latency_trace_writes_failed_total[5m]) > 0.1

# Bridge latency traces: discrepancia total_ms vs soma das fases (definir limiar com PHASES_MISMATCH_WARN_MS)
rate(plug_bridge_latency_trace_phases_mismatch_total[5m]) > 0

# `agent:register_error` e conflitos de sessao: picos indicam rotacao de credencial, conflito de ownership,
# `session_active` (restauro/segundo PC com o mesmo agentId) ou taxa; logs `agent_register_error_emitted` em
# STDERR; contadores `plug_agent_session_*` e `plug_agent_session_register_rate_limited_total` em `GET /metrics`.
```

## Dashboards operacionais sugeridos

Para o relay Socket, um dashboard mínimo útil costuma incluir:

- taxa de `plug_socket_relay_rate_limit_*_rejected_total` por `scope`
- `plug_socket_relay_outbound_queue_backlog`
- `plug_socket_relay_outbound_queue_job_duration_p95_ms`
- `plug_socket_relay_outbound_queue_orphaned_request_ids`
- `rate(plug_socket_bridge_ack_retry_attempts_total{path="rest"}[5m])`
- `rate(plug_socket_bridge_ack_retry_attempts_total{path="relay"}[5m])`
- `rate(plug_socket_bridge_ack_retry_exhausted_total[5m])`
- `rate(plug_socket_relay_emit_discarded_consumer_gone_total[5m])`
- `rate(plug_socket_relay_conversations_expired_total[5m])`
- `rate(plug_agent_idle_timeout_disconnect_total[5m])` e `rate(plug_consumer_idle_timeout_disconnect_total[5m])`
- `sum by (code) (rate(plug_socket_engine_connection_errors_total[5m]))`
- `sum by (namespace) (rate(plug_socket_namespace_adapter_errors_total[5m]))` e `..._socket_errors_total`
- `rate(plug_socket_relay_outbound_queue_overload_rejected_total[5m])`

## Rollout do contrato plug_agente

Para mudancas no contrato de comunicacao com `plug_agente`, usar este fluxo:

1. Rodar staging com `SOCKET_AGENT_INBOUND_CONTRACT_VALIDATION=warn`.
2. Monitorar `plug_socket_agents_inbound_contract_validation_warn_total` e logs
   `agent_inbound_contract_validation_failed`.
3. Corrigir qualquer drift no hub ou no agente antes de promover.
4. Trocar staging para `strict` e validar que nao ha rejeicoes.
5. Promover producao em `strict`.

Rotacao de assinatura HMAC: seguir
`docs/runbooks/payload_signing_key_rotation_runbook.md`.

## Sinais uteis do relay

### Fila outbound: cleanup de tails órfãos

Cada `requestId` mantem uma cadeia serializada na fila outbound. Se uma cadeia
ficar sem progresso por tempo demais, o hub passa a trata-la como orfa/zumbi e
a remove no sweep periodico:

- `SOCKET_RELAY_OUTBOUND_TAIL_STALE_MS`
- `SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS`

Metricas associadas:

- `plug_socket_relay_outbound_queue_orphaned_request_ids`
- `plug_socket_relay_outbound_queue_orphaned_tails_swept_total`

### Shed load em `/consumers`

Quando a fila outbound relay excede backlog ou latencia p95 configurados, o hub
passa a rejeitar temporariamente novos eventos relay de `/consumers` com
`SERVICE_UNAVAILABLE` e `retryAfterMs`:

- `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG`
- `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS`

Metrica associada:

- `plug_socket_relay_outbound_queue_overload_rejected_total`

### Stream pull: orçamento restante

`relay:rpc.stream.pull_response` agora pode incluir metadados de orçamento da janela:

```json
{
  "success": true,
  "requestId": "req-123",
  "streamId": "stream-123",
  "windowSize": 32,
  "rateLimit": {
    "remainingCredits": 768,
    "limit": 1000,
    "scope": "user"
  }
}
```

Quando bloqueado por limite, o mesmo bloco `rateLimit` acompanha o erro
`RATE_LIMITED`.

Semantica de autorizacao, revogacao e conta ativa no relay:
`docs/api/client_agent_business_rules.md`.

## Logs e tracing

- O bridge preserva `traceparent` / `tracestate` no `meta` JSON-RPC quando o cliente envia.
- Spans opcionais do bridge: `BRIDGE_LATENCY_TRACE_OTEL_ENABLED` (ver acima). Para tracing geral da app, ver `docs/studies/scaling_and_roadmap.md`.

## Teste de contrato com o repositorio `plug_agente`

Corre `npm run test:contract`. O ficheiro `tests/contract/plug_agente_optional.contract.test.ts` tenta resolver o checkout nesta ordem: variavel `PLUG_AGENTE_ROOT`, pasta irma `../plug_agente` (relativa ao cwd do projeto), ou caminho de desenvolvimento conhecido; se nenhum contiver `docs/communication/openrpc.json`, a suite fica em *skip*.

Opcionalmente forca a raiz:

```bash
set PLUG_AGENTE_ROOT=D:\Developer\plug_database\plug_agente
npm run test:contract
```

Quando o agente e encontrado, a suite valida metodos e versao minima no OpenRPC, existencia dos `schemas/*.json` publicados, compilacao **Ajv** (draft 2020-12) e payloads exemplo cruzados com os validadores Zod do hub.

## Adendo: sinais da degradacao controlada e deduplicacao

Esta rodada acrescentou sinais operacionais especificos para o endurecimento do
fluxo Socket do cliente:

- `plug_socket_custom_event_publish_distributed_recipient_count_circuit_opened_total`
- `plug_socket_custom_event_publish_distributed_recipient_count_circuit_rejected_total`
- `plug_socket_custom_event_publish_distributed_recipient_count_circuit_open`
- `plug_socket_consumer_client_agent_room_bootstrap_fetch_reused_total`
- `plug_socket_consumers_profile_push_recipient_fetch_reused_total`
- `plug_socket_agent_room_disconnect_triggered_total`
- `plug_socket_consumer_room_disconnect_triggered_total`

Leitura recomendada:

1. `..._distributed_recipient_count_failed_total` a subir com `..._circuit_opened_total` a zero indica degradacao curta, ainda dentro do cap local.
2. `..._circuit_rejected_total` > 0 indica que a contagem distribuida falhou vezes suficientes para o hub parar de publicar temporariamente.
3. `..._bootstrap_fetch_reused_total` e `..._profile_push_recipient_fetch_reused_total` devem crescer em reconnect storms ou rajadas de atualizacao de perfil; se ficarem sempre zerados, a deduplicacao nao esta a ser exercitada.
4. `..._room_disconnect_triggered_total` ajuda a distinguir revogacoes/bloqueios reais de churn normal de socket.
