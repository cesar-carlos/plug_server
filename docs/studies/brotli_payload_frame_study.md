# Study: Brotli (`br`) in PayloadFrame compression negotiation

- **Status**: Proposed — no implementation until bytes-on-wire is measured as a bottleneck.
- **Date**: 2026-06-24

## Summary

Today hub and agent negotiate `gzip` and `none` only. Brotli often improves compression ratio on JSON at the cost of higher CPU. Node.js supports `zlib.brotliCompress`; Dart agent would need a `br` codec path.

## When to pursue

- Production profiles show **bandwidth** or **large payload encode** as dominant phase, not SQL or RTT.
- Median relay payload > `PAYLOAD_FRAME_COMPRESS_MIN_BYTES` with gzip ratio plateau.

## Hub changes (if adopted)

1. Add `br` to `HUB_TRANSPORT_COMPRESSIONS` env parsing.
2. Extend `agent:capabilities` negotiation and `encodePayloadFrame` compression branch.
3. Contract tests for `cmp: "br"` round-trip with plug_agente.

## Agent changes (`plug_agente`)

1. Advertise `br` in `compressions` when compiled with brotli support.
2. Decode inbound `br` frames on `rpc:request` / stream chunks.

## Risk

- CPU regression on small payloads if `br` is selected too aggressively.
- Must coordinate rollout: hub must not emit `br` until agent confirms support.

## References

- [`docs/plug_agente/03_performance_roadmap.md`](../plug_agente/03_performance_roadmap.md) item 10
- [`src/shared/utils/payload_frame.ts`](../../src/shared/utils/payload_frame.ts)
