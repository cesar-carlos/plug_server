import { describe, expect, it } from "vitest";

import {
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
  "client_token.getPolicy": {
    jsonrpc: "2.0",
    id: "policy-1",
    method: "client_token.getPolicy",
    params: { client_token: "token" },
  },
  "observer.list": {
    jsonrpc: "2.0",
    id: "observer-list-1",
    method: "observer.list",
    params: { client_token: "token" },
  },
  "observer.register": {
    jsonrpc: "2.0",
    id: "observer-register-1",
    method: "observer.register",
    params: {
      sql: "SELECT 1",
      client_token: "token",
      interval_seconds: 30,
      condition: { type: "rows_present" },
    },
  },
  "observer.unregister": {
    jsonrpc: "2.0",
    id: "observer-unregister-1",
    method: "observer.unregister",
    params: { observer_id: "observer-1" },
  },
  "rpc.discover": {
    jsonrpc: "2.0",
    id: "discover-1",
    method: "rpc.discover",
    params: {},
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
});
