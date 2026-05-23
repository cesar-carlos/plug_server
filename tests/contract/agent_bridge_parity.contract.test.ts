import { describe, expect, it } from "vitest";

import {
  agentsCommandPlainJsonWireException,
  agentsCommandWireMigration,
  agentsStreamPullPlainJsonWireException,
  agentsStreamPullWireMigration,
  bridgeParityFeatureRows,
  bridgeParityMethodRows,
  bridgeParityMethods,
  bridgeSocketRestApiParityScope,
} from "../../src/shared/constants/agent_bridge_parity";
import {
  agentCommandBodySchema,
  supportedAgentRpcMethods,
} from "../../src/shared/validators/agent_command";

const sampleCommandByMethod = {
  "agent.getHealth": {
    jsonrpc: "2.0",
    id: "health-1",
    method: "agent.getHealth",
    params: { client_token: "token" },
  },
  "agent.getProfile": {
    jsonrpc: "2.0",
    id: "profile-1",
    method: "agent.getProfile",
    params: { client_token: "token" },
  },
  "agent.action.run": {
    jsonrpc: "2.0",
    id: "action-run-1",
    method: "agent.action.run",
    params: {
      action_id: "action-1",
      idempotency_key: "idem-run-1",
      trigger_id: "remote-trigger-1",
      client_token: "token",
    },
  },
  "agent.action.validateRun": {
    jsonrpc: "2.0",
    id: "action-validate-1",
    method: "agent.action.validateRun",
    params: {
      action_id: "action-1",
      idempotency_key: "idem-validate-1",
      requested_by: "hub-user",
      client_token: "token",
    },
  },
  "agent.action.cancel": {
    jsonrpc: "2.0",
    id: "action-cancel-1",
    method: "agent.action.cancel",
    params: {
      execution_id: "exec-1",
      trace_id: "trace-1",
      client_token: "token",
    },
  },
  "agent.action.getExecution": {
    jsonrpc: "2.0",
    id: "action-get-1",
    method: "agent.action.getExecution",
    params: {
      execution_id: "exec-1",
      include_output: true,
      stdout_offset: 0,
      stderr_offset: 32,
      max_output_bytes: 4096,
      client_token: "token",
    },
  },
  "client_token.getPolicy": {
    jsonrpc: "2.0",
    id: "policy-1",
    method: "client_token.getPolicy",
    params: { client_token: "token" },
  },
  "rpc.discover": {
    jsonrpc: "2.0",
    id: "discover-1",
    method: "rpc.discover",
    params: {},
  },
  "sql.bulkInsert": {
    jsonrpc: "2.0",
    id: "bulk-1",
    method: "sql.bulkInsert",
    params: {
      table: "target_table",
      columns: [
        { name: "id", type: "i64" },
        { name: "name", type: "text" },
      ],
      rows: [
        [1, "Ada"],
        [2, "Linus"],
      ],
      client_token: "token",
    },
  },
  "sql.cancel": {
    jsonrpc: "2.0",
    id: "cancel-1",
    method: "sql.cancel",
    params: { request_id: "request-1" },
  },
  "sql.execute": {
    jsonrpc: "2.0",
    id: "sql-1",
    method: "sql.execute",
    params: { sql: "SELECT 1", client_token: "token" },
  },
  "sql.executeBatch": {
    jsonrpc: "2.0",
    id: "batch-1",
    method: "sql.executeBatch",
    params: {
      commands: [{ sql: "SELECT 1" }, { sql: "SELECT 2" }],
      client_token: "token",
    },
  },
} as const;

describe("agent bridge parity contract", () => {
  it("keeps the official parity method matrix aligned with the validator allow-list", () => {
    expect([...bridgeParityMethods].sort()).toEqual([...supportedAgentRpcMethods].sort());
    expect(bridgeParityMethodRows).toHaveLength(supportedAgentRpcMethods.length);
    for (const row of bridgeParityMethodRows) {
      expect(row.rest).toBe(true);
      expect(row.agentsCommand).toBe(true);
      expect(row.relay).toBe(true);
    }
  });

  it.each(bridgeParityMethods)(
    "accepts %s through the REST/agents:command bridge schema",
    (method) => {
      const parsed = agentCommandBodySchema.safeParse({
        agentId: "agent-1",
        command: sampleCommandByMethod[method],
      });

      expect(parsed.success).toBe(true);
    },
  );

  it("documents that Socket parity is scoped to the command bridge, not the full REST API", () => {
    expect(bridgeSocketRestApiParityScope.duplicatesFullRestApi).toBe(false);
    expect(bridgeSocketRestApiParityScope.socketScope).toBe("agent_command_bridge");
    expect(bridgeSocketRestApiParityScope.restOwns).toContain("auth");
    expect(bridgeSocketRestApiParityScope.restOwns).toContain("metrics");
  });

  it("marks relay batch and notification support as intentionally absent", () => {
    expect(bridgeParityFeatureRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          feature: "json_rpc_batch",
          rest: true,
          agentsCommand: true,
          relay: false,
        }),
        expect.objectContaining({
          feature: "json_rpc_notification",
          rest: true,
          agentsCommand: true,
          relay: false,
        }),
      ]),
    );
  });

  it("documents agents:command wire migration with PayloadFrame outbound by default", () => {
    expect(agentsCommandWireMigration.inboundEvent).toBe("agents:command");
    expect(agentsCommandWireMigration.responseEvent).toBe("agents:command_response");
    expect(agentsCommandWireMigration.streamEvents).toEqual([
      "agents:command_stream_chunk",
      "agents:command_stream_complete",
    ]);
    expect(agentsCommandWireMigration.defaultOutboundWireFormat).toBe("payload_frame");
    expect(agentsCommandWireMigration.compatModeEnv).toBe("SOCKET_AGENTS_COMMAND_COMPAT_MODE");
    expect(agentsCommandWireMigration.reason.length).toBeGreaterThan(0);
    expect(agentsCommandWireMigration.removeWhen.length).toBeGreaterThan(0);
    expect(agentsCommandPlainJsonWireException).toBe(agentsCommandWireMigration);
  });

  it("documents agents:stream_pull wire migration with PayloadFrame outbound by default", () => {
    expect(agentsStreamPullWireMigration.inboundEvent).toBe("agents:stream_pull");
    expect(agentsStreamPullWireMigration.responseEvent).toBe("agents:stream_pull_response");
    expect(agentsStreamPullWireMigration.streamEvents).toEqual([]);
    expect(agentsStreamPullWireMigration.defaultOutboundWireFormat).toBe("payload_frame");
    expect(agentsStreamPullWireMigration.compatModeEnv).toBe("SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE");
    expect(agentsStreamPullWireMigration.reason.length).toBeGreaterThan(0);
    expect(agentsStreamPullWireMigration.removeWhen.length).toBeGreaterThan(0);
    expect(agentsStreamPullPlainJsonWireException).toBe(agentsStreamPullWireMigration);
  });
});
