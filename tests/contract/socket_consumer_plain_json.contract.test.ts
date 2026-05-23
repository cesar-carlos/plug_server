import { describe, expect, it } from "vitest";

import {
  agentsCommandPlainJsonWireException,
  agentsCommandWireMigration,
  agentsStreamPullPlainJsonWireException,
  agentsStreamPullWireMigration,
} from "../../src/shared/constants/agent_bridge_parity";
import { socketEvents } from "../../src/shared/constants/socket_events";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../src/shared/utils/payload_frame";
import {
  buildAgentsCommandResponseForWire,
  buildAgentsCommandStreamEventForWire,
} from "../../src/presentation/socket/consumers/agents_command_wire";
import { buildAgentsStreamPullResponseForWire } from "../../src/presentation/socket/consumers/agents_stream_pull_wire";

/** Canonical success envelope for `agents:command_response` (logical JSON before wire encode). */
type AgentsCommandSuccessResponse = {
  success: true;
  requestId: string;
  response: unknown;
  streamId?: string;
  retryAfterSeconds?: number;
};

/** Canonical failure envelope for `agents:command_response` (logical JSON before wire encode). */
type AgentsCommandErrorResponse = {
  success: false;
  requestId?: string;
  error: {
    code: string;
    message: string;
    statusCode?: number;
    retryAfterMs?: number;
  };
};

/** Agent `rpc:chunk` body forwarded on `agents:command_stream_chunk`. */
type AgentsCommandStreamChunkPayload = {
  stream_id: string;
  request_id: string;
  chunk_index?: number;
  rows?: unknown[];
  [key: string]: unknown;
};

/** Agent `rpc:complete` body forwarded on `agents:command_stream_complete`. */
type AgentsCommandStreamCompletePayload = {
  stream_id: string;
  request_id: string;
  total_rows?: number;
  [key: string]: unknown;
};

/** Canonical success envelope for `agents:stream_pull_response` (logical JSON before wire encode). */
type AgentsStreamPullSuccessResponse = {
  success: true;
  requestId: string;
  streamId: string;
  windowSize: number;
  rateLimit?: {
    remainingCredits: number;
    limit: number;
    scope: "user" | "anon";
  };
};

/** Canonical failure envelope for `agents:stream_pull_response` (logical JSON before wire encode). */
type AgentsStreamPullErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode?: number;
    retryAfterMs?: number;
  };
  rateLimit?: {
    remainingCredits: number;
    limit: number;
    scope: "user" | "anon";
  };
};

describe("socket consumer agents:command wire contracts", () => {
  it("documents agents:command wire migration metadata from agent_bridge_parity", () => {
    expect(agentsCommandWireMigration.inboundEvent).toBe("agents:command");
    expect(agentsCommandWireMigration.responseEvent).toBe("agents:command_response");
    expect(agentsCommandWireMigration.streamEvents).toEqual([
      socketEvents.agentsCommandStreamChunk,
      socketEvents.agentsCommandStreamComplete,
    ]);
    expect(agentsCommandWireMigration.defaultOutboundWireFormat).toBe("payload_frame");
    expect(agentsCommandWireMigration.compatModeEnv).toBe("SOCKET_AGENTS_COMMAND_COMPAT_MODE");
    expect(agentsCommandWireMigration.inboundAcceptsDuringTransition).toEqual([
      "payload_frame",
      "plain_json",
    ]);
    expect(agentsCommandWireMigration.reason.length).toBeGreaterThan(0);
    expect(agentsCommandWireMigration.removeWhen.length).toBeGreaterThan(0);
    expect(agentsCommandPlainJsonWireException).toBe(agentsCommandWireMigration);
  });

  it("documents agents:command_response success as PayloadFrame on the wire by default", () => {
    const logical: AgentsCommandSuccessResponse = {
      success: true,
      requestId: "req-1",
      response: {
        type: "single",
        success: true,
        item: { id: "req-1", result: { ok: true } },
      },
      streamId: "stream-req-1",
      retryAfterSeconds: 2,
    };

    const wire = buildAgentsCommandResponseForWire(logical);
    expect(socketEvents.agentsCommandResponse).toBe("agents:command_response");
    expect(isPayloadFrameEnvelope(wire)).toBe(true);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual(logical);
      expect(decoded.value.frame.requestId).toBe("req-1");
    }
  });

  it("documents agents:command_response failure as PayloadFrame on the wire by default", () => {
    const logical: AgentsCommandErrorResponse = {
      success: false,
      requestId: "req-1",
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Agent unavailable",
        statusCode: 503,
        retryAfterMs: 1500,
      },
    };

    const wire = buildAgentsCommandResponseForWire(logical);
    expect(isPayloadFrameEnvelope(wire)).toBe(true);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual(logical);
    }
  });

  it("documents legacy plain JSON inbound remains accepted during transition", () => {
    const inbound = {
      agentId: "agent-1",
      command: { jsonrpc: "2.0", id: "req-1", method: "sql.execute", params: { sql: "SELECT 1" } },
    };
    expect(isPayloadFrameEnvelope(inbound)).toBe(false);

    const framedInbound = encodePayloadFrame(inbound, { requestId: "req-1", omitTraceId: true });
    expect(isPayloadFrameEnvelope(framedInbound)).toBe(true);
  });

  it("documents agents:command_stream_chunk as PayloadFrame passthrough of agent rpc:chunk body", () => {
    const logical: AgentsCommandStreamChunkPayload = {
      stream_id: "stream-req-1",
      request_id: "req-1",
      chunk_index: 0,
      rows: [{ id: 1, name: "alpha" }],
    };

    const wire = buildAgentsCommandStreamEventForWire(logical);
    expect(socketEvents.agentsCommandStreamChunk).toBe("agents:command_stream_chunk");
    expect(isPayloadFrameEnvelope(wire)).toBe(true);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual(logical);
    }
  });

  it("documents agents:command_stream_complete as PayloadFrame passthrough of agent rpc:complete body", () => {
    const logical: AgentsCommandStreamCompletePayload = {
      stream_id: "stream-req-1",
      request_id: "req-1",
      total_rows: 2,
    };

    const wire = buildAgentsCommandStreamEventForWire(logical);
    expect(socketEvents.agentsCommandStreamComplete).toBe("agents:command_stream_complete");
    expect(isPayloadFrameEnvelope(wire)).toBe(true);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual(logical);
    }
  });
});

describe("socket consumer agents:stream_pull wire contracts", () => {
  it("documents agents:stream_pull wire migration metadata from agent_bridge_parity", () => {
    expect(agentsStreamPullWireMigration.inboundEvent).toBe("agents:stream_pull");
    expect(agentsStreamPullWireMigration.responseEvent).toBe("agents:stream_pull_response");
    expect(agentsStreamPullWireMigration.streamEvents).toEqual([]);
    expect(agentsStreamPullWireMigration.defaultOutboundWireFormat).toBe("payload_frame");
    expect(agentsStreamPullWireMigration.compatModeEnv).toBe(
      "SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE",
    );
    expect(agentsStreamPullWireMigration.inboundAcceptsDuringTransition).toEqual([
      "payload_frame",
      "plain_json",
    ]);
    expect(agentsStreamPullWireMigration.reason.length).toBeGreaterThan(0);
    expect(agentsStreamPullWireMigration.removeWhen.length).toBeGreaterThan(0);
    expect(agentsStreamPullPlainJsonWireException).toBe(agentsStreamPullWireMigration);
  });

  it("documents agents:stream_pull_response success as PayloadFrame on the wire by default", () => {
    const logical: AgentsStreamPullSuccessResponse = {
      success: true,
      requestId: "req-1",
      streamId: "stream-req-1",
      windowSize: 16,
      rateLimit: {
        remainingCredits: 100,
        limit: 256,
        scope: "user",
      },
    };

    const wire = buildAgentsStreamPullResponseForWire(logical);
    expect(socketEvents.agentsStreamPullResponse).toBe("agents:stream_pull_response");
    expect(isPayloadFrameEnvelope(wire)).toBe(true);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual(logical);
      expect(decoded.value.frame.requestId).toBe("req-1");
      expect(decoded.value.frame.cmp).toBe("none");
    }
  });

  it("documents agents:stream_pull_response failure as PayloadFrame on the wire by default", () => {
    const logical: AgentsStreamPullErrorResponse = {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Stream route not found",
        statusCode: 404,
      },
    };

    const wire = buildAgentsStreamPullResponseForWire(logical);
    expect(isPayloadFrameEnvelope(wire)).toBe(true);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual(logical);
    }
  });

  it("documents legacy plain JSON inbound remains accepted during transition", () => {
    const inbound = { requestId: "req-1", windowSize: 8 };
    expect(isPayloadFrameEnvelope(inbound)).toBe(false);

    const framedInbound = encodePayloadFrame(inbound, { requestId: "req-1", omitTraceId: true });
    expect(isPayloadFrameEnvelope(framedInbound)).toBe(true);
  });
});
