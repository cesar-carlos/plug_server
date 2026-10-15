import { resetBridgeCommandReplayGuard } from "../../../../../src/application/agent_commands/bridge_command_replay_guard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SQL_OPERATION_TRANSPORT } from "../../../../../src/shared/constants/sql_operation_transport";
import { bridgeSingleCommandSchema } from "../../../../../src/shared/validators/agent_command";
import { createDispatchRpcCommandToAgent } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_command";
import { createRpcBridgeRelayDispatch } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay";
import { cleanupPendingRequestsForAgentSocket } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_lifecycle";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import {
  getRestPendingRequestByCorrelationId,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import {
  resetRelayRequestRegistry,
  getRelayRequestRoute,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetRestAgentDispatchQueue } from "../../../../../src/presentation/socket/hub/relay/rest_agent_dispatch_queue";
import { resetRelayIdempotencyStore } from "../../../../../src/presentation/socket/hub/registries/relay_idempotency_store";
import { resetRelayStreamFlowState } from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";
import { resetRelayOutboundQueueState } from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";
import {
  decodePayloadFrame,
  encodePayloadFrame,
} from "../../../../../src/shared/utils/payload_frame";
import { isAckRetryEligibleCommand } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_command_helpers";
import { overrideEnv } from "../../../../helpers/override_env";
import { env } from "../../../../../src/shared/config/env";

const reference = {
  contractVersion: 1,
  operationId: "11111111-1111-4111-8111-111111111111",
  fingerprint: "a".repeat(64),
  sourcePhysicalId: "b".repeat(64),
  database: "fixture",
  client_token: "token",
};
const command = (
  method = "sql.operation.execute",
): ReturnType<typeof bridgeSingleCommandSchema.parse> =>
  bridgeSingleCommandSchema.parse({
    id: "operation",
    method,
    params:
      method === "sql.operation.execute"
        ? {
            ...reference,
            timeoutMs: 1000,
            maxAffectedRows: 1,
            steps: [
              {
                id: "write",
                effect: "update",
                sql: "UPDATE fixture SET value=:value WHERE id=:id",
                params: {},
                outputs: {},
                affectedRows: { min: 1, max: 1 },
              },
            ],
          }
        : reference,
  });
const register = (
  sqlOperations: unknown,
  socketId = "socket",
  structural: Record<string, unknown> = {},
): void => {
  agentRegistry.registerAgentSession({
    agentId: "agent",
    socketId,
    userId: "user",
    policy: "legacy_silent_takeover",
    isPeerConnected: () => false,
    capabilities: {
      protocols: ["jsonrpc-v2"],
      encodings: ["json"],
      compressions: ["none"],
      extensions: { sqlOperations, ...structural },
    },
  });
  agentRegistry.touch("agent", { markProtocolReady: true, socketId });
};
const relay = (
  emit = vi.fn(),
  consumer = vi.fn(),
): {
  emit: typeof emit;
  consumer: typeof consumer;
  dispatch: ReturnType<typeof createRpcBridgeRelayDispatch>["dispatchRelayRpcToAgent"];
} => {
  conversationRegistry.create({
    conversationId: "conversation",
    consumerSocketId: "consumer",
    agentSocketId: "socket",
    agentId: "agent",
  });
  return {
    emit,
    consumer,
    dispatch: createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit }),
      emitToConsumer: consumer,
      prepareAgentStreamPull: () => {
        throw new Error("Operations cannot stream");
      },
    }).dispatchRelayRpcToAgent,
  };
};
const ackConfig = [
  env.socketAgentAckRetryEnabled,
  env.socketAgentAckTimeoutMs,
  env.socketAgentAckMaxRetries,
] as const;
afterEach(() => {
  resetBridgeCommandReplayGuard();
  agentRegistry.clear();
  conversationRegistry.clear();
  resetRestPendingRequestsStore();
  resetRestAgentDispatchQueue(serviceUnavailable("test reset"));
  resetRelayRequestRegistry();
  resetRelayIdempotencyStore();
  resetRelayStreamFlowState();
  resetRelayOutboundQueueState();
  overrideEnv("socketAgentAckRetryEnabled", ackConfig[0]);
  overrideEnv("socketAgentAckTimeoutMs", ackConfig[1]);
  overrideEnv("socketAgentAckMaxRetries", ackConfig[2]);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SQL operation bridge negotiation and transport", () => {
  const structural = { sourceIdentity: 1, sourceSchema: 1, sourceConstraints: 1 };
  const structuralCommand = (): ReturnType<typeof bridgeSingleCommandSchema.parse> =>
    bridgeSingleCommandSchema.parse({
      ...command(),
      params: {
        ...command().params,
        expectedSource: { version: 1, dialect: "postgres", identityHash: "a".repeat(64) },
        expectedStructure: {
          version: 1,
          resources: [
            {
              resource: { schema: "public", name: "fixture", type: "table" },
              columns: [{ name: "id", nativeType: "int4", nullable: false, size: 32, scale: 0 }],
            },
          ],
        },
      },
    });
  it("refuses structural operations in REST and relay before emission on old peers", async () => {
    const old = { ...SQL_OPERATION_TRANSPORT, structureGuard: undefined };
    register(old, "socket", structural);
    const emit = vi.fn();
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit }),
    });
    for (const input of [structuralCommand(), [structuralCommand()]])
      await expect(dispatch({ agentId: "agent", command: input })).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
      });
    await expect(
      relay(emit).dispatch({
        conversationId: "conversation",
        consumerSocketId: "consumer",
        rawFramePayload: encodePayloadFrame(structuralCommand()),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(emit).not.toHaveBeenCalled();
  });
  it("preserves the structural plan exactly and rechecks the guard after async encoding", async () => {
    register(SQL_OPERATION_TRANSPORT, "socket", structural);
    const input = structuralCommand();
    const response = { jsonrpc: "2.0", id: input.id, result: { state: "cancelada" } };
    const emit = vi.fn((_event: string, wire: unknown) => {
      const decoded = decodePayloadFrame(wire);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.value.data).toMatchObject(input);
      getRestPendingRequestByCorrelationId("operation")!.resolve(response);
    });
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit }),
    });
    expect(await dispatch({ agentId: "agent", command: input })).toMatchObject({ response });
    expect(emit).toHaveBeenCalledTimes(1);
    emit.mockClear();
    const pending = dispatch({ agentId: "agent", command: { ...input, id: "new-operation" } });
    register({ ...SQL_OPERATION_TRANSPORT, structureGuard: undefined }, "socket", structural);
    await expect(pending).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(emit).not.toHaveBeenCalled();
  });
  it.each(["sql.operation.execute", "sql.operation.get", "sql.operation.cancel"])(
    "refuses %s in REST, mixed batches and relay when agent is old",
    async (method) => {
      register(undefined);
      const emit = vi.fn();
      const dispatch = createDispatchRpcCommandToAgent({
        hasRegisteredAgentSocketBridge: () => true,
        findAgentSocketById: () => ({ emit }),
      });
      for (const input of [
        command(method),
        [
          bridgeSingleCommandSchema.parse({ method: "agent.getHealth", id: "read", params: {} }),
          command(method),
        ],
      ]) {
        await expect(dispatch({ agentId: "agent", command: input })).rejects.toMatchObject({
          code: "CAPABILITY_UNAVAILABLE",
          details: { retryable: false },
        });
      }
      const r = relay(emit);
      await expect(
        r.dispatch({
          conversationId: "conversation",
          consumerSocketId: "consumer",
          rawFramePayload: encodePayloadFrame(command(method)),
        }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it.each(["sql.operation.execute", "sql.operation.get", "sql.operation.cancel"])(
    "preserves %s payload and receipts without enabling acknowledgement retries",
    async (method) => {
      register(SQL_OPERATION_TRANSPORT);
      const input = command(method);
      expect(isAckRetryEligibleCommand(input)).toBe(false);
      expect(isAckRetryEligibleCommand([input])).toBe(false);
      const response = {
        jsonrpc: "2.0",
        id: input.id,
        result: {
          operationId: reference.operationId,
          fingerprint: reference.fingerprint,
          executionId: "execution",
          state: "resultado_desconhecido",
          directlyAffectedRows: null,
          updatedAt: "2026-10-10T10:00:00.000Z",
        },
      };
      const emit = vi.fn((_event: string, wire: unknown) => {
        const decoded = decodePayloadFrame(wire);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(decoded.value.data).toMatchObject(input);
        getRestPendingRequestByCorrelationId("operation")!.resolve(response);
      });
      const dispatch = createDispatchRpcCommandToAgent({
        hasRegisteredAgentSocketBridge: () => true,
        findAgentSocketById: () => ({ emit }),
      });
      expect(await dispatch({ agentId: "agent", command: input })).toMatchObject({ response });
      expect(emit).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects plans above negotiated limits instead of silently clamping", async () => {
    register({ ...SQL_OPERATION_TRANSPORT, timeoutMs: 500 });
    const emit = vi.fn();
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit }),
    });
    await expect(dispatch({ agentId: "agent", command: command() })).rejects.toMatchObject({
      code: "SQL_OPERATION_NEGOTIATED_LIMIT",
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("rechecks the authenticated agent session after asynchronous encoding", async () => {
    register(SQL_OPERATION_TRANSPORT);
    const emit = vi.fn();
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit }),
    });
    const run = dispatch({ agentId: "agent", command: command() });
    register(undefined, "replacement");
    await expect(run).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("reports unknown delivery after dispatch disconnect, never an automatic retry", async () => {
    register(SQL_OPERATION_TRANSPORT);
    const emit = vi.fn(() => cleanupPendingRequestsForAgentSocket("socket"));
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit }),
    });
    await expect(dispatch({ agentId: "agent", command: command() })).rejects.toMatchObject({
      code: "SQL_OPERATION_OUTCOME_UNKNOWN",
      details: { retryable: false, outcome_unknown: true },
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("relay preserves the plan and never resends an unacknowledged write on timeout", async () => {
    vi.useFakeTimers();
    overrideEnv("socketAgentAckRetryEnabled", true);
    overrideEnv("socketAgentAckTimeoutMs", 1);
    overrideEnv("socketAgentAckMaxRetries", 3);
    register(SQL_OPERATION_TRANSPORT);
    const r = relay();
    const receipt = await r.dispatch({
      conversationId: "conversation",
      consumerSocketId: "consumer",
      rawFramePayload: encodePayloadFrame(command()),
      timeoutMs: 10,
    });
    const wire = decodePayloadFrame(r.emit.mock.calls[0]![1]);
    expect(wire.ok).toBe(true);
    if (wire.ok)
      expect(wire.value.data).toMatchObject({ method: command().method, params: command().params });
    expect(getRelayRequestRoute(receipt.requestId)).toBeDefined();
    await vi.advanceTimersByTimeAsync(6000);
    expect(r.emit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(r.consumer).toHaveBeenCalled());
    const error = decodePayloadFrame(r.consumer.mock.calls[0]![2]);
    expect(error.ok).toBe(true);
    if (error.ok)
      expect(error.value.data).toMatchObject({
        id: "operation",
        error: {
          data: { code: "SQL_OPERATION_OUTCOME_UNKNOWN", retryable: false, outcome_unknown: true },
        },
      });
  });
});
