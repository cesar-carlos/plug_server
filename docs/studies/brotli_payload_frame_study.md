# Study: Brotli (`br`) in PayloadFrame compression negotiation

- **Status**: Proposed — no implementation until bytes-on-wire is measured as a bottleneck.
- **Date**: 2026-06-24
- **Gates vivos:** [`docs/performance/P5_future_gates.md`](../performance/P5_future_gates.md) §5.1

## Summary

Today hub and agent negotiate `gzip` and `none` only. Brotli often improves compression ratio on JSON at the cost of higher CPU. Node.js supports `zlib.brotliCompress`; Dart agent would need a `br` codec path.

## When to pursue

Ver gates em P5. Em resumo: bandwidth / encode dominante no baseline; median payload acima do limiar de compressao com gzip em plateau.

## Hub / agent changes (if adopted)

1. Hub: add `br` to `HUB_TRANSPORT_COMPRESSIONS`, negotiation, `encodePayloadFrame`, contract tests.
2. Agent: advertise + decode `br` when compiled with brotli support.
3. Coordinate rollout — hub must not emit `br` until agent confirms support.

## Risk

CPU regression on small payloads if `br` is selected too aggressively.

## References

- [`P5_future_gates.md`](../performance/P5_future_gates.md)
- [`03_performance_roadmap.md`](../plug_agente/03_performance_roadmap.md) item 10
- [`payload_frame.ts`](../../src/shared/utils/payload_frame.ts)
