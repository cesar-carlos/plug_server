/**
 * Contract tests: valid payloads per plug_agente docs/communication/schemas.
 * Ensures our Zod schemas accept payloads that conform to the plug_agente contract.
 * Reference: plug_agente/docs/communication/socket_communication_standard.md
 */

import { describe, expect, it } from "vitest";

import { agentCommandBodySchema } from "../../../../src/shared/validators/agent_command";

describe("agent_command contract (plug_agente compatibility)", () => {
  it("should accept sql.execute with all optional params per plug_agente schema", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "req-123",
        params: {
          sql: "SELECT * FROM users WHERE id = :id",
          params: { id: 1 },
          client_token: "a1b2c3d4e5f6",
          options: {
            timeout_ms: 30000,
            max_rows: 50000,
            page: 1,
            page_size: 100,
          },
        },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept sql.execute with execution_mode preserve", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "req-preserve",
        params: {
          sql: "SELECT * FROM users LIMIT 10",
          client_token: "token",
          options: { execution_mode: "preserve" as const },
        },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept sql.execute with cursor keyset pagination", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "req-cursor",
        params: {
          sql: "SELECT * FROM users ORDER BY id",
          client_token: "token",
          options: {
            cursor: "eyJ2IjoyLCJwYWdlIjoyfQ",
          },
        },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept sql.executeBatch with execution_order per plug_agente schema", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.executeBatch",
        id: "batch-001",
        params: {
          commands: [
            { sql: "SELECT * FROM users", execution_order: 2 },
            { sql: "SELECT COUNT(*) FROM orders", execution_order: 1 },
            { sql: "SELECT * FROM products" },
          ],
          client_token: "token",
          options: { transaction: true, timeout_ms: 30000 },
        },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept sql.cancel with execution_id", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.cancel",
        id: "cancel-1",
        params: { execution_id: "exec-123" },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept rpc.discover", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "rpc.discover",
        id: "discover-1",
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept api_version and meta extensions", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "req-meta",
        api_version: "2.5",
        meta: {
          trace_id: "trace-abc",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          request_id: "req-meta",
          timestamp: "2026-03-19T10:00:00Z",
        },
        params: {
          sql: "SELECT 1",
          client_token: "token",
        },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept database override in params", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "req-db",
        params: {
          sql: "SELECT 1",
          client_token: "token",
          database: "custom_schema",
        },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("should accept multi_result option", () => {
    const payload = {
      agentId: "agent-01",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "req-multi",
        params: {
          sql: "SELECT * FROM users; SELECT COUNT(*) FROM orders",
          client_token: "token",
          options: { multi_result: true },
        },
      },
    };

    const parsed = agentCommandBodySchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });
});
