# Spike: HMAC verification on worker thread for large PayloadFrames

> **Status**: not implemented. Gated behind a measurement requirement — see
> `docs/socket/socket_relay_protocol.md` ("Server-side phase diagnostics") for the
> opt-in needed to produce that measurement.

## Hypothesis

For PayloadFrames above some byte threshold, the synchronous HMAC-SHA256
signature verification (`validateFrameSignature` in `payload_frame.ts`)
contributes meaningfully to event-loop blocking. Offloading verification to
a worker thread above the threshold would lower tail latency (p95/p99) on
mixed-payload workloads at the cost of one IPC round-trip per offloaded
verify.

## Why this is a spike, not a feature

`.cursor/rules/performance.mdc`:

> *Optimize only after identifying the hot path, bottleneck, or operational
> limit being addressed. (...) document the assumption being optimized and
> verify the result with measurement or profiling.*

There is **no evidence today** that HMAC dominates the event-loop budget.
The existing `decodePayloadFrameAsync` already offloads `gunzip` for large
compressed payloads via `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES`,
which is the more likely CPU dominator (compression is typically heavier
than HMAC at equivalent payload size).

Shipping a worker-pool implementation without that data would:

- add operational complexity (worker pool sizing, lifecycle, error path)
- introduce a new IPC failure mode (worker crash → orphaned requests)
- increase code surface area for a benefit that may be zero on real traffic

## Gate

Implementation only proceeds when **all** the following are observed:

1. Production or load-test measurement (via `meta.serverTimings` opt-in or
   OTEL spans) shows `event_loop_lag_ms` p99 > 10 ms during peak relay
   throughput.
2. `consumer_frame_decode_ms` and the (currently sync) HMAC step together
   account for ≥ 20 % of `relay:rpc.response` end-to-end latency.
3. The dominant fraction of decode time is HMAC, **not** gunzip. (If gunzip
   dominates, fix is to lower `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES`
   instead — much smaller change.)

Capture the baseline numbers in this spike before any code change so the
post-implementation A/B has a comparable reference.

## Sketch of the implementation (when gate passes)

### Worker module

`src/infrastructure/workers/payload_frame_hmac_worker.ts`

- Node `worker_threads` worker
- Receives `{ requestId, payloadBytes, signature, keyId }`
- Computes HMAC-SHA256, returns `{ requestId, valid: boolean }`
- One worker per CPU core (cap via env `PAYLOAD_FRAME_HMAC_WORKER_COUNT`,
  default `0` = disabled)

### Pool

`src/infrastructure/workers/payload_frame_hmac_pool.ts`

- Round-robin dispatch (avoid promise-pending head-of-line block)
- `verifyAsync(bytes, signature, keyId): Promise<boolean>`
- Bounded queue per worker, falls back to inline verify on overflow
- Eager initialization on boot (avoid first-request cliff)

### Integration point

`validateFrameSignature` in `payload_frame.ts`:

```ts
const verifyFn =
  isWorkerEnabled && binaryPayload.length >= env.payloadFrameHmacWorkerMinBytes
    ? payloadFrameHmacPool.verifyAsync
    : verifyHmacSync;
```

Async path requires `validatePayloadFrameForDecode` to become `async`. That
ripples through `decodePayloadFrame` (sync) and most callers. Decision: keep
`decodePayloadFrame` sync, add `decodePayloadFrameAsyncFull` that uses the
worker, and route relay/REST forwarders through it.

### Env keys

```
PAYLOAD_FRAME_HMAC_WORKER_COUNT=0           # disabled by default
PAYLOAD_FRAME_HMAC_WORKER_MIN_BYTES=65536   # 64 KiB threshold
PAYLOAD_FRAME_HMAC_WORKER_QUEUE_MAX=128
```

`0` workers = feature disabled, in-thread verify retained (current behaviour).

### Metrics

- `plug_payload_frame_hmac_worker_jobs_total{outcome="ok|fallback|worker_error"}`
- `plug_payload_frame_hmac_worker_queue_depth` (gauge)
- `plug_payload_frame_hmac_worker_latency_ms` (histogram)

### Rollout

1. Ship with `PAYLOAD_FRAME_HMAC_WORKER_COUNT=0` (no behaviour change).
2. Enable on staging at `COUNT=2`, `MIN_BYTES=65536`. Compare event-loop
   lag p99 vs baseline over 24h.
3. If p99 improvement ≥ 30 % without increase in `worker_error_total`,
   promote to production at the same settings.
4. If improvement < 10 %, revert (the gate was not predictive) and update
   this spike with the negative result.

## Why this spike is recorded even without implementation

This is a **deliberate non-change** so future contributors who think "we
should offload HMAC" can find the reasoning, the gate, and the rollout plan
already laid out. If somebody implements it without the measurement, this
doc is the rejection target.

## References

- Existing async pattern for the same module:
  `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` in `env.ts`
- Source of the gate criteria:
  `.cursor/rules/performance.mdc`
- Observability for capturing the baseline:
  `docs/socket/socket_relay_protocol.md` ("Server-side phase diagnostics")
