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

REST, agents:command and relay support run/validateRun with optional io plus
sendInput, closeInput, getInputStatus, readIo and findExecution. Existing
cancel/getExecution semantics and legacy run/validate fields are preserved.
Terminal duplicate run calls return the original execution.

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

## Verification

Final hub lint/typecheck pass. Full suite: 2,537 passed and 25 unrelated optional
skips. Dedicated I/O: 208 tests in 24 suites, no skips. Shared fixtures have SHA-256
804a7ed26f8d8f742701bcd085a2bbfcce571f51f6a82e8d5edd595e6d1d5b5f in both repos.
Agent analyzer and 1,373-contract/264-UI gate pass. Private authenticated
REST/socket/relay runs traverse the real Windows process; desktop, revocation,
interruption, bounded readers and physical disk-full acceptance are recorded in
the agent reference. Skips and schema-only tests never substitute for live cases.

Independent recheck on 2026-10-30 repeated the current hub full suite (2,537
passed, 25 skipped), lint and typecheck successfully. Retained agent evidence
was inspected for the 18 journal interruption boundaries, interrupted native
write/output recovery, all three transports and physical-volume exhaustion.
The volume result explicitly records successful dismount. The current RPC
response-preparer regression suite was also rerun after its later file update.
This recheck does not claim a new complete desktop/native run or enable production.
