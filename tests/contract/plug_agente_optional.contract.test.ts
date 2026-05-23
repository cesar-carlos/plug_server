import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentCommandBodySchema,
  bridgeCommandSchema,
  supportedAgentRpcMethods,
} from "../../src/shared/validators/agent_command";
import { validateAgentInboundContract } from "../../src/presentation/socket/hub/agent_inbound_contract_validation";
import { withBridgeMeta } from "../../src/presentation/socket/hub/rpc_bridge_command_helpers";
import { HUB_TRANSPORT_EXTENSIONS } from "../../src/shared/constants/agent_transport_contract";
import { env } from "../../src/shared/config/env";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { resetSocketAgentMetrics } from "../../src/shared/metrics/socket_agent.metrics";
import {
  createPlugAgenteAjv,
  getPlugAgenteContractPaths,
  PLUG_AGENTE_SCHEMA_FILES,
} from "../helpers/plug_agente_contract";

const plugAgentePaths = getPlugAgenteContractPaths();
const openRpcPath = plugAgentePaths?.openRpcPath ?? "";
const schemasDir = plugAgentePaths?.schemasDir ?? "";

const contractDescribe = plugAgentePaths !== null ? describe : describe.skip;
const originalInboundValidationMode = env.socketAgentInboundContractValidation;

function assertZodAcceptsCommand(command: unknown): void {
  const asBody = { agentId: "contract-test-agent", command };
  const bodyParsed = agentCommandBodySchema.safeParse(asBody);
  expect(
    bodyParsed.success,
    JSON.stringify(bodyParsed.success ? null : bodyParsed.error.issues),
  ).toBe(true);

  const bridgeParsed = bridgeCommandSchema.safeParse(command);
  expect(
    bridgeParsed.success,
    JSON.stringify(bridgeParsed.success ? null : bridgeParsed.error.issues),
  ).toBe(true);
}

function readOpenRpcMajorMinor(version: string): string {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  expect(Number.isFinite(major)).toBe(true);
  expect(Number.isFinite(minor)).toBe(true);
  return `${major}.${minor}`;
}

function readHubPlugProfileMajorMinor(profile: string): string {
  const match = /^plug-jsonrpc-profile\/(\d+\.\d+)$/u.exec(profile);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

contractDescribe("plug_agente contract (OpenRPC + JSON Schema vs hub Zod)", () => {
  it("exposes expected OpenRPC methods and a parsable semver-like version", () => {
    const raw = readFileSync(openRpcPath, "utf8");
    const doc = JSON.parse(raw) as {
      methods?: { name: string }[];
      info?: { version?: string };
    };
    const names = [...new Set((doc.methods ?? []).map((m) => m.name))].sort();
    expect(names).toEqual([...supportedAgentRpcMethods].sort());

    const version = doc.info?.version;
    expect(version).toBe("2.11.2");
    expect(readHubPlugProfileMajorMinor(HUB_TRANSPORT_EXTENSIONS.plugProfile)).toBe(
      readOpenRpcMajorMinor(String(version)),
    );
  });

  it("includes all published schema files under docs/communication/schemas", () => {
    for (const name of PLUG_AGENTE_SCHEMA_FILES) {
      const p = join(schemasDir, name);
      expect(existsSync(p), `missing schema ${name}`).toBe(true);
    }
  });

  it("keeps hub inbound validation aligned with published response and stream schemas", () => {
    const ajv = createPlugAgenteAjv(schemasDir);
    const validateRpcResponse = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.response.v1.json",
    );
    const validateBatchResponse = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.batch.response.v1.json",
    );
    const validateChunk = ajv.getSchema("https://plugagente.dev/schemas/rpc.stream.chunk.v1.json");
    const validateComplete = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.stream.complete.v1.json",
    );

    expect(validateRpcResponse).toBeDefined();
    expect(validateBatchResponse).toBeDefined();
    expect(validateChunk).toBeDefined();
    expect(validateComplete).toBeDefined();

    const validResponse = {
      jsonrpc: "2.0",
      id: "schema-response",
      result: { rows: [], row_count: 0 },
      api_version: "2.11",
      meta: {
        trace_id: "trace-1",
        request_id: "schema-response",
        agent_id: "agent-1",
        timestamp: "2026-05-23T12:00:00.000Z",
      },
    };
    const validBatchResponse = [
      validResponse,
      { jsonrpc: "2.0", id: "schema-error", error: { code: -32000, message: "failed" } },
    ];
    const validChunk = {
      stream_id: "stream-1",
      request_id: "schema-response",
      chunk_index: 0,
      rows: [{ id: 1 }],
      total_chunks: 1,
      column_metadata: [{ name: "id" }],
    };
    const validComplete = {
      stream_id: "stream-1",
      request_id: "schema-response",
      total_rows: 1,
      affected_rows: 0,
      execution_id: "exec-1",
      started_at: "2026-05-23T12:00:00.000Z",
      finished_at: "2026-05-23T12:00:01.000Z",
    };

    env.socketAgentInboundContractValidation = "strict";
    try {
      expect(validateRpcResponse!(validResponse)).toBe(true);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcResponse,
          socketId: "agent-socket",
          payload: validResponse,
        }).ok,
      ).toBe(true);

      expect(validateBatchResponse!(validBatchResponse)).toBe(true);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcResponse,
          socketId: "agent-socket",
          payload: validBatchResponse,
        }).ok,
      ).toBe(true);

      expect(validateChunk!(validChunk)).toBe(true);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcChunk,
          socketId: "agent-socket",
          payload: validChunk,
        }).ok,
      ).toBe(true);

      expect(validateComplete!(validComplete)).toBe(true);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcComplete,
          socketId: "agent-socket",
          payload: validComplete,
        }).ok,
      ).toBe(true);

      const invalidResponseMeta = {
        ...validResponse,
        meta: { ...validResponse.meta, extra: "not-published" },
      };
      expect(validateRpcResponse!(invalidResponseMeta)).toBe(false);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcResponse,
          socketId: "agent-socket",
          payload: invalidResponseMeta,
        }).ok,
      ).toBe(false);

      const invalidBatchResponse = [
        {
          jsonrpc: "2.0",
          id: "schema-batch-invalid",
          result: {},
          error: { code: -32000, message: "failed" },
        },
      ];
      expect(validateBatchResponse!(invalidBatchResponse)).toBe(false);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcResponse,
          socketId: "agent-socket",
          payload: invalidBatchResponse,
        }).ok,
      ).toBe(false);

      const invalidChunk = { ...validChunk, extra: true };
      expect(validateChunk!(invalidChunk)).toBe(false);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcChunk,
          socketId: "agent-socket",
          payload: invalidChunk,
        }).ok,
      ).toBe(false);

      const invalidComplete = { ...validComplete, total_rows: -1 };
      expect(validateComplete!(invalidComplete)).toBe(false);
      expect(
        validateAgentInboundContract({
          eventName: socketEvents.rpcComplete,
          socketId: "agent-socket",
          payload: invalidComplete,
        }).ok,
      ).toBe(false);
    } finally {
      env.socketAgentInboundContractValidation = originalInboundValidationMode;
      resetSocketAgentMetrics();
    }
  });

  it("compiles JSON Schemas and accepts representative payloads; Zod accepts the same commands", () => {
    const ajv = createPlugAgenteAjv(schemasDir);

    const validateSqlExecuteParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.sql-execute.v1.json",
    );
    const validateSqlBatchParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.sql-execute-batch.v1.json",
    );
    const validateSqlBulkInsertParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.sql-bulk-insert.v1.json",
    );
    const validateSqlCancelParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.sql-cancel.v1.json",
    );
    const validateRpcRequest = ajv.getSchema("https://plugagente.dev/schemas/rpc.request.v1.json");
    const validatePayloadFrame = ajv.getSchema(
      "https://plugagente.dev/schemas/payload-frame.v1.json",
    );
    const validateSqlResult = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.result.sql-execute.v1.json",
    );
    const validateSqlBulkInsertResult = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.result.sql-bulk-insert.v1.json",
    );
    const validateAgentGetProfileParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.agent-get-profile.v1.json",
    );
    const validateAgentGetProfileResult = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.result.agent-get-profile.v1.json",
    );
    const validateAgentGetHealthParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.agent-get-health.v1.json",
    );
    const validateAgentGetHealthResult = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.result.agent-get-health.v1.json",
    );
    const validateAgentActionRunParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.agent-action-run.v1.json",
    );
    const validateAgentActionValidateRunParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.agent-action-validate-run.v1.json",
    );
    const validateAgentActionCancelParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.agent-action-cancel.v1.json",
    );
    const validateAgentActionGetExecutionParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.agent-action-get-execution.v1.json",
    );
    const validateClientTokenGetPolicyParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.client-token-get-policy.v1.json",
    );
    const validateClientTokenGetPolicyResult = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.result.client-token-get-policy.v1.json",
    );
    const validateBatchRequest = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.batch.request.v1.json",
    );
    const validateBatchResponse = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.batch.response.v1.json",
    );

    expect(validateSqlExecuteParams).toBeDefined();
    expect(validateSqlBatchParams).toBeDefined();
    expect(validateSqlBulkInsertParams).toBeDefined();
    expect(validateSqlCancelParams).toBeDefined();
    expect(validateRpcRequest).toBeDefined();
    expect(validatePayloadFrame).toBeDefined();
    expect(validateSqlResult).toBeDefined();
    expect(validateSqlBulkInsertResult).toBeDefined();
    expect(validateAgentGetProfileParams).toBeDefined();
    expect(validateAgentGetProfileResult).toBeDefined();
    expect(validateAgentGetHealthParams).toBeDefined();
    expect(validateAgentGetHealthResult).toBeDefined();
    expect(validateAgentActionRunParams).toBeDefined();
    expect(validateAgentActionValidateRunParams).toBeDefined();
    expect(validateAgentActionCancelParams).toBeDefined();
    expect(validateAgentActionGetExecutionParams).toBeDefined();
    expect(validateClientTokenGetPolicyParams).toBeDefined();
    expect(validateClientTokenGetPolicyResult).toBeDefined();
    expect(validateBatchRequest).toBeDefined();
    expect(validateBatchResponse).toBeDefined();

    const sqlParams = {
      sql: "SELECT 1",
      client_token: "a1b2c3d4",
      options: {
        timeout_ms: 30000,
        max_rows: 1000,
        execution_mode: "managed" as const,
        prefer_db_streaming: true,
      },
    };
    expect(validateSqlExecuteParams!(sqlParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "contract-sql-1",
      params: sqlParams,
    });

    const sqlParamsPreserve = {
      sql: "SELECT * FROM t LIMIT 1",
      client_token: "a1b2c3d4",
      options: { execution_mode: "preserve" as const },
    };
    expect(validateSqlExecuteParams!(sqlParamsPreserve)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "contract-sql-preserve",
      params: sqlParamsPreserve,
    });

    const batchParams = {
      client_token: "a1b2c3d4",
      commands: [{ sql: "SELECT 1", execution_order: 1 }, { sql: "SELECT 2" }],
      options: {
        transaction: false,
        timeout_ms: 10000,
        max_parallel_read_only_batch_items: 2,
      },
    };
    expect(validateSqlBatchParams!(batchParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.executeBatch",
      id: "contract-batch-1",
      params: batchParams,
    });

    const bulkInsertParams = {
      table: "dbo.bulk_target",
      columns: [
        { name: "id", type: "i64" },
        { name: "payload", type: "text", nullable: false, max_len: 255 },
      ],
      rows: [
        [1, "alpha"],
        [2, "beta"],
      ],
      client_token: "a1b2c3d4",
      idempotency_key: "contract-bulk-1",
      options: { timeout_ms: 10000 },
    };
    expect(validateSqlBulkInsertParams!(bulkInsertParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.bulkInsert",
      id: "contract-bulk-1",
      params: bulkInsertParams,
    });

    const cancelParams = { execution_id: "exec-1", request_id: "req-1" };
    expect(validateSqlCancelParams!(cancelParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.cancel",
      id: "contract-cancel-1",
      params: cancelParams,
    });

    const getProfileParams = { client_token: "a1b2c3d4" };
    expect(validateAgentGetProfileParams!(getProfileParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "agent.getProfile",
      id: "contract-profile-1",
      params: getProfileParams,
    });

    const getHealthParams = { client_token: "a1b2c3d4" };
    expect(validateAgentGetHealthParams!(getHealthParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "agent.getHealth",
      id: "contract-health-1",
      params: getHealthParams,
    });

    const getHealthResult = {
      status: "healthy",
      timestamp: "2026-05-08T12:00:00.000Z",
      version: "1.0.0",
      pool: { size: 4 },
      sql_queue: { enabled: false },
      queries: {
        total: 10,
        errors: 0,
        success_rate: 100,
        avg_latency_ms: 12,
        p95_latency_ms: 25,
        p99_latency_ms: 40,
      },
      uptime_seconds: 3600,
    };
    expect(validateAgentGetHealthResult!(getHealthResult)).toBe(true);

    const actionRunParams = {
      action_id: "action-1",
      idempotency_key: "idem-run-1",
      trigger_id: "remote-trigger-1",
      trace_id: "trace-run-1",
      requested_by: "hub-user",
      client_token: "a1b2c3d4",
    };
    expect(validateAgentActionRunParams!(actionRunParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "agent.action.run",
      id: "contract-action-run-1",
      params: actionRunParams,
    });

    const actionValidateRunParams = {
      action_id: "action-1",
      idempotency_key: "idem-validate-1",
      requested_by: "hub-user",
      clientToken: "a1b2c3d4",
    };
    expect(validateAgentActionValidateRunParams!(actionValidateRunParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "agent.action.validateRun",
      id: "contract-action-validate-1",
      params: actionValidateRunParams,
    });

    const actionCancelParams = {
      execution_id: "exec-action-1",
      trace_id: "trace-cancel-1",
      auth: "a1b2c3d4",
    };
    expect(validateAgentActionCancelParams!(actionCancelParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "agent.action.cancel",
      id: "contract-action-cancel-1",
      params: actionCancelParams,
    });

    const actionGetExecutionParams = {
      execution_id: "exec-action-1",
      include_output: true,
      stdout_offset: 0,
      stderr_offset: 32,
      max_output_bytes: 4096,
      client_token: "a1b2c3d4",
    };
    expect(validateAgentActionGetExecutionParams!(actionGetExecutionParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "agent.action.getExecution",
      id: "contract-action-get-1",
      params: actionGetExecutionParams,
    });

    const getPolicyParams = { client_token: "a1b2c3d4" };
    expect(validateClientTokenGetPolicyParams!(getPolicyParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "client_token.getPolicy",
      id: "contract-get-policy-1",
      params: getPolicyParams,
    });

    const getPolicyResult = {
      client_id: "client-1",
      payload: {},
      all_tables: false,
      all_views: false,
      global_permissions: {
        read: true,
        update: false,
        delete: false,
        ddl: false,
      },
      all_permissions: false,
      is_revoked: false,
      rules: [
        {
          resource_type: "table" as const,
          resource: "orders",
          effect: "allow" as const,
          read: true,
          update: false,
          delete: false,
          ddl: false,
        },
      ],
    };
    expect(validateClientTokenGetPolicyResult!(getPolicyResult)).toBe(true);

    const rpcReq = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "rpc-meta",
      api_version: "2.11",
      meta: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      params: { sql: "SELECT 1", client_token: "a1b2c3d4" },
    };
    expect(validateRpcRequest!(rpcReq)).toBe(true);
    assertZodAcceptsCommand(rpcReq);

    const rpcReqWithOutboundCompression = {
      ...rpcReq,
      meta: {
        ...rpcReq.meta,
        outbound_compression: "auto" as const,
      },
    };
    assertZodAcceptsCommand(rpcReqWithOutboundCompression);

    const hubForwardedRpcReq = withBridgeMeta(
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "rpc-meta-forwarded",
        params: { sql: "SELECT 1", client_token: "a1b2c3d4" },
        meta: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          outbound_compression: "auto",
          conversation_id: "conv-1",
          client_request_id: "client-1",
        },
      },
      {
        requestId: "rpc-meta-forwarded",
        agentId: "agent-contract",
        traceId: "trace-contract",
        timestamp: "2026-03-23T10:00:00.000Z",
      },
    );
    expect(validateRpcRequest!(hubForwardedRpcReq)).toBe(true);
    expect((hubForwardedRpcReq as { meta?: Record<string, unknown> }).meta).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      request_id: "rpc-meta-forwarded",
      agent_id: "agent-contract",
      timestamp: "2026-03-23T10:00:00.000Z",
      trace_id: "trace-contract",
    });

    const logicalJson = JSON.stringify({ ok: true });
    const payloadBytes = Array.from(Buffer.from(logicalJson, "utf8"));
    const frame = {
      schemaVersion: "1.0",
      enc: "json",
      cmp: "none",
      contentType: "application/json",
      originalSize: payloadBytes.length,
      compressedSize: payloadBytes.length,
      payload: payloadBytes,
      traceId: "trace-contract",
      requestId: "req-contract",
    };
    expect(validatePayloadFrame!(frame)).toBe(true);

    const sqlResult = {
      execution_id: "exec-contract",
      started_at: "2026-03-23T10:00:00.000Z",
      finished_at: "2026-03-23T10:00:01.000Z",
      rows: [{ "1": 1 }],
      row_count: 1,
      sql_handling_mode: "managed",
      max_rows_handling: "response_truncation",
      effective_max_rows: 50000,
    };
    expect(validateSqlResult!(sqlResult)).toBe(true);

    const batchRpc: unknown[] = [
      { jsonrpc: "2.0", method: "sql.execute", id: "b1", params: { sql: "SELECT 1" } },
      { jsonrpc: "2.0", method: "sql.execute", id: "b2", params: { sql: "SELECT 2" } },
    ];
    expect(validateBatchRequest!(batchRpc)).toBe(true);

    const batchRes: unknown[] = [
      {
        jsonrpc: "2.0",
        id: "b1",
        result: {
          execution_id: "e1",
          started_at: "2026-03-23T10:00:00.000Z",
          finished_at: "2026-03-23T10:00:00.001Z",
          rows: [],
          row_count: 0,
        },
      },
      {
        jsonrpc: "2.0",
        id: "b2",
        result: {
          execution_id: "e2",
          started_at: "2026-03-23T10:00:00.000Z",
          finished_at: "2026-03-23T10:00:00.001Z",
          rows: [],
          row_count: 0,
        },
      },
    ];
    expect(validateBatchResponse!(batchRes)).toBe(true);

    const profileResult = {
      agent_id: "agent-01",
      profile: {
        name: "Loja Plug",
        trade_name: "Plug Matriz",
        document: "11222333000181",
        document_type: "cnpj",
        mobile: "11999999999",
        email: "contato@plug.local",
        address: {
          street: "Rua A",
          number: "100",
          district: "Centro",
          postal_code: "01001000",
          city: "Sao Paulo",
          state: "SP",
        },
      },
      updated_at: "2026-03-23T10:00:01.000Z",
    };
    expect(validateAgentGetProfileResult!(profileResult)).toBe(true);
  });

  it("rejects invalid sql.execute options per plug_agente schema (preserve + page)", () => {
    const ajv = createPlugAgenteAjv(schemasDir);
    const validateSqlExecuteParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.sql-execute.v1.json",
    );
    const bad = {
      sql: "SELECT 1",
      options: { execution_mode: "preserve", page: 1, page_size: 10 },
    };
    expect(validateSqlExecuteParams!(bad)).toBe(false);

    const z = bridgeCommandSchema.safeParse({
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "bad-preserve-page",
      params: bad,
    });
    expect(z.success).toBe(false);
  });
});
