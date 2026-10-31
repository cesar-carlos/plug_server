# Remote action I/O integration

Implemented `agentActions.io` v1; development acceptance completed on 2026-10-30.
`ENABLE_ACTION_IO_HOMOLOGATION` defaults to false and production remains disabled.
No release or activation is authorized by this document.

## Documentation ownership

The agent's `docs/communication/action_io.md` owns execution, journal, quotas,
authorization, recovery and acceptance evidence. Its OpenRPC and method schemas
are the canonical wire definitions. Hub runtime validation lives in
`src/shared/validators/action_io*.ts`; Swagger exposes dedicated request schemas.

- [REST bridge](../api/api_rest_bridge.md): HTTP and agents:command routing.
- [Relay protocol](../socket/socket_relay_protocol.md): consumer relay routing.
- [JSON examples](remote_action_io_examples.md): validated request/result examples.
- [Shared fixtures](../../contracts/action_io_shared_fixtures.json): peer parity.

The `drafts/action_io_v1.schema.json` and failure examples remain documentation
fixtures exercised by contract tests; they are not imported as runtime validators.
Keep them synchronized with the canonical per-method definitions. A union schema
alone must never validate a response to an unrelated method.

## Dispatch and security

Unavailable capabilities fail before dispatch with `CAPABILITY_UNAVAILABLE` and
safe reason/origin/recovery metadata. See [REST error example](../api/api_rest_bridge.md#mensagem-para-recurso-indisponível)
for the shared REST/socket/relay contract. Missing capability alone does not prove
an old installed version. Explicit JSON-RPC `-32601` remains distinct from an
unknown outcome after dispatch; never retry or remove requested guarantees automatically.

For a slow or reconnecting reader, `terminal` describes the execution. Drain
the remaining pages from the saved cursor through the `completed` event. The
[duplex load test](plug_node_alignment.md#carga-bidirecional-com-consumidor-lento-e-retomada-por-cursor)
checks both stream hashes and measures latency and process memory for this case.

REST, agents:command and relay support run/validateRun with optional io plus
sendInput, closeInput, getInputStatus, readIo and findExecution. Existing
cancel/getExecution semantics and legacy run/validate fields are preserved.
Terminal duplicate run calls return the original execution.

Faithful run and validation require a correlated response. Explicit `id: null`
is refused before dispatch with `ACTION_IO_INVALID_REQUEST`. In an allowed mixed
batch the hub applies its remaining deadline to each faithful I/O item. Unrelated
items retain their own metadata. A preflight capability refusal or expired I/O
budget does not count toward the agent circuit breaker.

The hub checks a base64 block's alphabet, padding bits and decoded length before
forwarding the original string. In a local Node 24.18.0 microbenchmark on
2026-10-31, the median of seven rounds validating 400 canonical 64 KiB blocks
fell from 100.9 ms to 81.3 ms after removing the decode/re-encode step. This
measurement covers elapsed validation time only, excluding transport and execution.

`agent.action.listAvailable` additionally requires catalog version 1. Omitting
that advertisement produces `not_advertised`. An explicitly disabled capability
produces `disabled`, and an unsupported version produces `incompatible`.

Require authenticated current agent capability, exact v1 agreement and sufficient
uncompressed frame/connection capacity before dispatch. The agent additionally
requires saved-action approval and current local Client credentials, explicit
I/O and operation scopes, binding and allowlist. The hub forwards credentials;
it never manufactures scopes. No arbitrary remote commandLine or parameters.

Carry byte buffers as canonical base64 without changing content. Validate each
method's parameters/result, correlation, safe integers, base64 and logical limits.
ACK, durable admission, pipe delivery and process outcome are distinct. A timeout
or lost response may follow committed effects; never retry mutations through ACK
retry or generic response caching. Mutations and waiting reads are excluded from
batches. Preserve typed errors and unknown progress, including nullable byte counts.
When validating a sendInput/closeInput response against its request, written
requires confirmed_bytes to equal the submitted decoded byte count (zero for
closeInput or an empty block). Partial progress remains valid in uncertain or
failed receipts; it cannot be presented as a complete write. getInputStatus
does not infer the original length when it is unavailable to the hub.
Within each readIo page, consecutive fragments of the same stream must have
contiguous byte offsets, even when stdout/stderr events interleave. The hub
rejects overlaps, gaps and offset arithmetic outside safe integers. The first
offset per stream may be nonzero for cursor resumption; continuity across pages
still requires the consumer's persisted stream offsets.

The complete request budget is 30 seconds. The hub overwrites caller deadline
metadata and propagates both remaining and absolute budgets; decoding and queueing
do not reset them. readIo waits at most 20 seconds while reserving five seconds
for authorization/response. Separate read leases preserve control capacity.
Abandoned reads send bounded rpc:read.cancel control to release the matching wait;
they do not cancel the process. Connection loss permits later cursor recovery.

## Reference client

`docs/snippets/action_io_reference_client.ts` implements initial/interactive
binary input, ordered close, input status, execution lookup and cursor-based
readIo. `docs/snippets/action_io_rest_transport.ts` adapts the existing normalized
REST single-command response. Neither layer retries. Credential callbacks resolve
current caller credentials per call; no credentials or payloads are logged or
persisted by these helpers. The snippets import repository validators and are
intended to run from this checkout, not as a standalone published SDK.

Construct the REST adapter with the exact `/api/v1/agents/commands` endpoint,
agent ID and a bearer-token callback, then construct ActionIoReferenceClient with
that adapter and a provisioned agent client-token callback. Call run with a
caller-persisted idempotency key and optional Uint8Array initial input. An absent
initial buffer differs from an explicit empty buffer. The returned reserved IDs
can be inspected with getInputStatus. Use the returned next_input_sequence when
admitting another message or close; retain each message ID and intended sequence
before sending. Do not infer input consumption from accepted or written.

Call readIo with the last locally committed cursor. Consume each output event by
base64-decoding its data_base64 directly into the selected stream; do not append
newlines or convert encoding. Commit next_sequence only after processing the
whole returned page. Repeating a read after interrupted local consumption can
redeliver events; use stream offsets/event sequences for local deduplication.
Capture completeness and process success are separate fields.

A lost mutation response raises ActionIoClientError with outcomeUnknown:true.
Use findExecution(action, key), getExecution or getInputStatus to reconcile; do
not automatically invoke run/sendInput/closeInput again. An unknown receipt is
not permission to replay. The adapter imposes a 30-second HTTP deadline, refuses
redirects and limits the normalized HTTP body to 1 MiB; the RPC validator retains
the negotiated 512 KiB logical limit. Abandoning the HTTP wait does not cancel
the process. The helper makes one request per call and does not run a poll loop.


Socket and relay adapters are in `docs/snippets/action_io_socket_transport.ts`.
Their credentials are resolved per call. Preserve action/key, execution ID,
message IDs/sequences and committed read cursor across reconnects. Adapter errors
retain safe correlation and action diagnostics; unsent failures are distinguished
from dispatched requests with unknown effects. No automatic replay is offered.
If an oversized HTTP response also fails stream cleanup, the adapter preserves
HTTP_RESPONSE_TOO_LARGE as the primary error and records cleanup_failed:true
without exposing the native exception or response content.
The reference client checks the 64 KiB initial/interactive input ceiling before
copying or base64-encoding the caller's buffer. Oversized input fails locally as
INVALID_REQUEST with outcomeUnknown:false. The REST adapter rejects malformed
JSON or invalid UTF-8 as INVALID_HTTP_JSON without exposing response excerpts;
after dispatch it preserves uncertainty and never retries the request.

## Verification

Recorded runtime review on 2026-10-30: hub lint/typecheck pass; full suite: 2,556
passed and 25 unrelated optional skips. These are dated results, not a claim
about every later checkout. The earlier dedicated I/O acceptance covered 208 tests
in 24 suites, no skips. Shared fixtures have SHA-256
804a7ed26f8d8f742701bcd085a2bbfcce571f51f6a82e8d5edd595e6d1d5b5f in both repos.
Agent analyzer and 1,373-contract/264-UI gate pass. Private authenticated
REST/socket/relay runs traverse the real Windows process; desktop, revocation,
interruption, bounded readers and physical disk-full acceptance are recorded in
the agent reference. Skips and schema-only tests never substitute for live cases.

Retained agent evidence was inspected for the 18 journal interruption boundaries, interrupted native
write/output recovery, all three transports and physical-volume exhaustion.
The volume result explicitly records successful dismount. The current RPC
response-preparer regression suite was also rerun after its later file update.
This recheck does not claim a new complete desktop/native run or enable production.

The final example review additionally validates the complete documented capability
with the runtime negotiator and each request/result pair with method-specific
hub validators and request correlation. This catches omissions and mismatched
execution/action/message identities that the documentation union schema alone
cannot detect. Documentation fixtures do not advertise or activate the extension.
The agent OpenRPC descriptions for run, validateRun, getExecution and cancel
also distinguish mandatory faithful authorization from legacy conditional token
authorization. The general RPC-cache description excludes faithful I/O and
durable SQL operations; neither may inherit session-cache replay semantics.

### End-to-end revalidation — 2026-10-30

Three sequential executions of the agent's `tool/homologation/action_io_hub_smoke.mjs`
completed successfully against the current server: native REST (default),
`--socket` and `--relay`. Each creates an isolated loopback hub with fresh
identities, local approval and credentials, then uses production RPC/journal/pipes
to execute a real Windows process. Each also exercises the TypeScript reference
client over REST, socket and relay. The final relay execution includes the client
correction preserving the agent's `error.data.failure_code` alongside `rpcCode`.

Verified assertions include initial/empty/interactive input, explicit stdin close,
byte equality of stdout and stderr, input receipts, terminal duplicate execution,
authorization refusals, content conflicts, cancellation and blocked-write unknown
delivery without replay. REST abandons an HTTP read and establishes a new caller;
socket disconnects/reconnects. Both find the same active execution and resume from
the retained cursor without process cancellation. The socket path also reconnects
between output pages. No automatic action/input replay is introduced.

Reproduce from the agent checkout, sequentially, with explicit absolute paths:

```text
node tool/homologation/action_io_hub_smoke.mjs <server-root> --native <flutter-dart-executable>
node tool/homologation/action_io_hub_smoke.mjs <server-root> --native <flutter-dart-executable> --socket
node tool/homologation/action_io_hub_smoke.mjs <server-root> --native <flutter-dart-executable> --relay
```

These fixtures do not certify public TLS, distributed deployments, the installed
desktop bootstrap or a new full disk/crash acceptance run. Production remains off.

The matrix was repeated after the final input-size precheck and strict HTTP
JSON/UTF-8 decoding corrections: REST, socket and relay controllers all exited
zero, including their embedded reference-client matrices. The full hub suite
and static checks for this round are recorded in Verification above.
No additional code correction was needed during this repeat. Logs for this
round are `action-io-final-{rest,socket,relay}.log` and
`action-io-final-server-suite.log` in the local system temporary directory.
These local logs are retained evidence, not portable versioned reports.
