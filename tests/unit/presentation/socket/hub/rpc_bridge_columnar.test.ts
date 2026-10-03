import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../../../src/shared/config/env";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";
import { createRpcBridgeAgentInboundHandlers } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_agent_inbound";
import { resetAgentInboundSequencerForTests } from "../../../../../src/presentation/socket/hub/relay/agent_inbound_sequencer";
import { resetAgentInboundIngressForTests } from "../../../../../src/presentation/socket/hub/relay/agent_inbound_ingress_guard";
import {
  resetActiveStreamRegistry,
  upsertActiveStreamRoute,
} from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import {
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";

const fixture = JSON.parse(
  readFileSync("tests/fixtures/socket/columnar_codec_fixture.json", "utf8"),
) as {
  chunk: Record<string, unknown>;
  expected_rows: unknown[];
};
afterEach(() => {
  resetRestPendingRequestsStore();
  resetActiveStreamRegistry();
  resetAgentInboundSequencerForTests();
  resetAgentInboundIngressForTests();
  vi.restoreAllMocks();
});

describe("columnar chunks through the inbound bridge", () => {
  it.each([false, true])(
    "normalizes signed frames before route delivery (gzip: %s)",
    async (gzip) => {
      vi.spyOn(env, "payloadSigningKey", "get").mockReturnValue("columnar-test-key");
      vi.spyOn(env, "payloadSigningKeyId", "get").mockReturnValue("columnar-test-id");
      vi.spyOn(env, "payloadSignOutbound", "get").mockReturnValue(true);
      vi.spyOn(env, "payloadFrameCompressMinBytes", "get").mockReturnValue(1);
      const onChunk = vi.fn();
      upsertActiveStreamRoute({
        requestId: "fixture-request",
        agentSocketId: "columnar-agent",
        agentId: "agent-1",
        streamId: "fixture-columnar",
        streamHandlers: { consumerSocketId: "client", onChunk, onComplete: vi.fn() },
      });
      const frame = encodePayloadFrame(fixture.chunk, {
        requestId: "fixture-request",
        compressionThreshold: gzip ? 1 : Number.POSITIVE_INFINITY,
      });
      expect(frame.cmp).toBe(gzip ? "gzip" : "none");
      expect(frame.signature).toBeDefined();
      createRpcBridgeAgentInboundHandlers({
        emitToConsumer: () => true,
        emitRpcStreamPullForRoute: () => undefined,
      }).handleAgentRpcChunk("columnar-agent", frame);
      await vi.waitFor(() => expect(onChunk).toHaveBeenCalledOnce());
      const [payload, metadata, original] = onChunk.mock.calls[0]!;
      expect(payload.rows).toEqual(fixture.expected_rows);
      expect(payload).not.toHaveProperty("columnar");
      expect(metadata.originalSizeBytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
      expect(metadata.compressedSizeBytes).toBe(frame.compressedSize);
      expect(
        original,
        "transformed signed bytes must not enter the forwarding fast path",
      ).toBeUndefined();
    },
  );

  it("materializes only normalized rows and preserves response/chunk/complete sequencing", async () => {
    const resolve = vi.fn();
    const reject = vi.fn();
    const timeoutHandle = setTimeout(() => undefined, 10000);
    registerRestPendingRequest({
      primaryRequestId: "fixture-request",
      correlationIds: ["fixture-request"],
      socketId: "columnar-agent",
      agentId: "agent-1",
      createdAtMs: Date.now(),
      resolve,
      reject,
      timeoutHandle,
      acked: false,
      restStreamAggregate: true,
    });
    const handlers = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: () => true,
      emitRpcStreamPullForRoute: () => undefined,
    });
    handlers.handleAgentRpcResponse(
      "columnar-agent",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "fixture-request",
          result: { stream_id: "fixture-columnar", rows: [] },
        },
        { requestId: "fixture-request" },
      ),
    );
    handlers.handleAgentRpcChunk(
      "columnar-agent",
      encodePayloadFrame(fixture.chunk, { requestId: "fixture-request" }),
    );
    handlers.handleAgentRpcComplete(
      "columnar-agent",
      encodePayloadFrame(
        { request_id: "fixture-request", stream_id: "fixture-columnar", total_rows: 2 },
        { requestId: "fixture-request" },
      ),
    );
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    expect(reject).not.toHaveBeenCalled();
    expect(resolve.mock.calls[0]![0].result.rows).toEqual(fixture.expected_rows);
    expect(resolve.mock.calls[0]![0].result).not.toHaveProperty("columnar");
    clearTimeout(timeoutHandle);
  });
});
