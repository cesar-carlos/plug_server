#!/usr/bin/env node
/**
 * Microbench for the relay `body.id` echo path.
 *
 * Quantifies the cost of sacrificing `canBypassReencode` in
 * `rpc_bridge_agent_inbound.ts` when the consumer's `client_request_id`
 * differs from the hub-internal `requestId` and the response body needs to
 * be re-encoded with the rewritten id (JSON-RPC 2.0 §5).
 *
 * Compares two paths over a range of response sizes:
 *
 *   `bypass` : `encodePayloadFrameFromBytes` — bytes verbatim, no parse,
 *              no JSON.stringify (the hot-path optimization we lose when
 *              clientRequestId is set).
 *   `echo`   : decode JSON → mutate `body.id` → `encodePayloadFrameBridge`
 *              (the path the fix shipped in 2026-05 takes).
 *
 * No Redis / network — purely in-process measurement of the CPU cost.
 *
 * Usage:
 *   BENCH=1 npx tsx scripts/bench-relay-body-id-echo.ts \
 *     --sizes 1024,10240,102400,1048576 --iterations 2000
 *
 * Output: avg / p50 / p95 / p99 latency in ms for `bypass` vs `echo`, plus
 * delta in absolute ms and percentage. The script exits non-zero only on
 * fatal errors; per-scenario failures are reported as warnings.
 *
 * Gates the future "Opcao A" decision documented in
 * `docs/adrs/0009-client-request-id-echo.md` — if the measured `echo`
 * overhead pushes `plug_socket_relay_body_id_echo_overhead_avg_ms` over the
 * threshold in production, the ADR reopens.
 */

import { performance } from "node:perf_hooks";

import {
  encodePayloadFrameBridge,
  encodePayloadFrameFromBytes,
  decodePayloadFrame,
  type DecodedPayloadFrame,
} from "../src/shared/utils/payload_frame";

interface ParsedArgs {
  readonly sizes: readonly number[];
  readonly iterations: number;
}

const DEFAULTS: ParsedArgs = {
  // Sizes chosen to span typical payload distribution:
  //  1 KB  — small SQL result (a few rows)
  // 10 KB  — medium result
  // 100 KB — large result close to gzip threshold
  //  1 MB  — extreme tail; above this most workloads stream
  sizes: [1024, 10 * 1024, 100 * 1024, 1024 * 1024],
  iterations: 2000,
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const overrides: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      continue;
    }
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (typeof value === "string" && !value.startsWith("--")) {
      overrides[key] = value;
      i += 1;
    }
  }
  const sizes =
    overrides["sizes"] !== undefined
      ? overrides["sizes"]
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
      : DEFAULTS.sizes;
  return {
    sizes: sizes.length > 0 ? sizes : DEFAULTS.sizes,
    iterations:
      Number.parseInt(overrides["iterations"] ?? "", 10) > 0
        ? Number.parseInt(overrides["iterations"] ?? "", 10)
        : DEFAULTS.iterations,
  };
};

const quantile = (sortedValues: readonly number[], q: number): number => {
  if (sortedValues.length === 0) {
    return 0;
  }
  const idx = Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length));
  return sortedValues[idx] ?? 0;
};

/**
 * Build a synthetic SQL response payload sized to approximately
 * `targetBytes` UTF-8. Uses repeated rows of realistic shape so JSON parse
 * cost reflects production payloads (object keys, nested arrays, string
 * values) rather than degenerate uniform data.
 */
const buildSyntheticResponse = (hubRequestId: string, targetBytes: number): Record<string, unknown> => {
  // Roughly ~120 bytes per row after JSON.stringify in the shape below.
  const rowsNeeded = Math.max(1, Math.ceil(targetBytes / 120));
  const rows = Array.from({ length: rowsNeeded }, (_, i) => ({
    id: i + 1,
    nome: `Cliente ${i + 1}`,
    documento: `12345678901-${i}`,
    saldo: (i * 13.37).toFixed(2),
    ativo: i % 2 === 0,
    atualizado_em: new Date(Date.now() - i * 1000).toISOString(),
  }));
  return {
    jsonrpc: "2.0",
    id: hubRequestId,
    result: {
      columns: ["id", "nome", "documento", "saldo", "ativo", "atualizado_em"],
      rows,
      row_count: rows.length,
    },
  };
};

const benchBypass = async (
  decoded: DecodedPayloadFrame,
  hubRequestId: string,
  iterations: number,
): Promise<readonly number[]> => {
  const samples: number[] = [];
  for (let it = 0; it < iterations; it += 1) {
    const started = performance.now();
    // Mirror of `encodeRelayOutboundFrameFromBytes` in relay_outbound_queue.ts:
    // hub re-wraps the envelope but reuses the agent's already-encoded bytes.
    encodePayloadFrameFromBytes(decoded.decodedBytes, {
      requestId: hubRequestId,
      omitTraceId: true,
    });
    samples.push(performance.now() - started);
  }
  return samples;
};

const benchEcho = async (
  decoded: DecodedPayloadFrame,
  hubRequestId: string,
  clientRequestId: string,
  iterations: number,
): Promise<readonly number[]> => {
  const samples: number[] = [];
  for (let it = 0; it < iterations; it += 1) {
    const started = performance.now();
    // Mirror of the `shouldEchoClientBodyId` branch in
    // `rpc_bridge_agent_inbound.ts`: clone the decoded payload, overwrite
    // body.id, re-encode via the bridge encoder (which does JSON.stringify
    // + optional gzip + optional HMAC sign).
    const payload = decoded.data as Record<string, unknown>;
    // Avoid mutating the shared decoded fixture across iterations — copy
    // into a per-iteration object so the rewrite cost is symmetric to the
    // production path that operates on `decoded.data` (which is also a
    // freshly parsed object per request).
    const echoed: Record<string, unknown> = { ...payload, id: clientRequestId };
    await encodePayloadFrameBridge(echoed, {
      requestId: hubRequestId,
      omitTraceId: true,
    });
    samples.push(performance.now() - started);
  }
  return samples;
};

interface Summary {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

const summarize = (samples: readonly number[]): Summary => {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    avg: sum / Math.max(1, sorted.length),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
};

const formatMs = (ms: number): string => {
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)}us`;
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  return `${ms.toFixed(2)}ms`;
};

const printRow = (label: string, samples: readonly number[]): Summary => {
  const s = summarize(samples);
  // eslint-disable-next-line no-console
  console.log(
    `${label.padEnd(8)} avg=${formatMs(s.avg).padStart(9)} ` +
      `p50=${formatMs(s.p50).padStart(9)} ` +
      `p95=${formatMs(s.p95).padStart(9)} ` +
      `p99=${formatMs(s.p99).padStart(9)} ` +
      `max=${formatMs(s.max).padStart(9)}`,
  );
  return s;
};

const main = async (): Promise<void> => {
  if (process.env["BENCH"] !== "1") {
    // eslint-disable-next-line no-console
    console.error("[bench-relay-body-id-echo] BENCH=1 is required to run");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(
    `[bench-relay-body-id-echo] iterations=${args.iterations} sizes=${args.sizes.join(",")}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[bench-relay-body-id-echo] bypass = encodePayloadFrameFromBytes (no parse, no stringify)`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[bench-relay-body-id-echo] echo   = mutate body.id + encodePayloadFrameBridge (parse-less, but JSON.stringify + optional gzip)`,
  );

  for (const sizeBytes of args.sizes) {
    const hubRequestId = "00000000-0000-4000-8000-000000000001";
    const clientRequestId = "11111111-1111-4111-8111-111111111111";
    const payload = buildSyntheticResponse(hubRequestId, sizeBytes);

    // Warm-up: produce a real PayloadFrame envelope to feed both paths.
    // Bypass uses `decoded.decodedBytes`, echo uses `decoded.data`.
    const warmFrame = await encodePayloadFrameBridge(payload, {
      requestId: hubRequestId,
      omitTraceId: true,
    });
    const decodeResult = decodePayloadFrame(warmFrame);
    if (!decodeResult.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bench-relay-body-id-echo] size=${sizeBytes} decode failed: ${decodeResult.error.message}`,
      );
      continue;
    }
    const decoded = decodeResult.value;
    const actualBytes = decoded.frame.originalSize;

    // eslint-disable-next-line no-console
    console.log(
      `\n# scenario: target=${sizeBytes}B actual_decoded=${actualBytes}B cmp=${decoded.frame.cmp}`,
    );

    try {
      // Run echo first then bypass to avoid warm/cold ordering bias toward
      // bypass; alternate-run averages would be cleaner but for a static
      // CPU benchmark the asymmetry is negligible.
      const echoSamples = await benchEcho(decoded, hubRequestId, clientRequestId, args.iterations);
      const echoSummary = printRow("echo", echoSamples);
      const bypassSamples = await benchBypass(decoded, hubRequestId, args.iterations);
      const bypassSummary = printRow("bypass", bypassSamples);

      const deltaAvg = echoSummary.avg - bypassSummary.avg;
      const deltaPct = bypassSummary.avg > 0 ? (deltaAvg / bypassSummary.avg) * 100 : 0;
      // eslint-disable-next-line no-console
      console.log(
        `delta    avg=+${formatMs(deltaAvg).padStart(8)} (+${deltaPct.toFixed(1)}% vs bypass)`,
      );
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bench-relay-body-id-echo] scenario size=${sizeBytes} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[bench-relay-body-id-echo] fatal:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
