import { describe, expect, it } from "vitest";

import { agentCommandBodySchema } from "../../../../src/shared/validators/agent_command";

describe("agentCommandBodySchema", () => {
  it("should accept sql.execute without token carrier for optional-agent-auth mode", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q-without-token",
        params: {
          sql: "SELECT 1",
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("should accept single notification without id", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        params: {
          sql: "SELECT 1",
          client_token: "token-value",
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.command)).toBe(false);
      if (!Array.isArray(parsed.data.command)) {
        expect("id" in parsed.data.command).toBe(false);
      }
    }
  });

  it("should accept JSON-RPC batch with mixed notifications and request ids", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: [
        {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "q1",
          params: {
            sql: "SELECT 1",
            client_token: "token-value",
          },
        },
        {
          jsonrpc: "2.0",
          method: "sql.execute",
          params: {
            sql: "INSERT INTO logs (msg) VALUES ('ok')",
            client_token: "token-value",
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("should reject batch with duplicate ids", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: [
        {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "dup-id",
          params: {
            sql: "SELECT 1",
            client_token: "token-value",
          },
        },
        {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "dup-id",
          params: {
            sql: "SELECT 2",
            client_token: "token-value",
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("Batch ids must be unique"))).toBe(true);
    }
  });

  it("should reject top-level pagination for batch commands", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      pagination: {
        page: 1,
        pageSize: 100,
      },
      command: [
        {
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "q1",
          params: {
            sql: "SELECT 1",
            client_token: "token-value",
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("should reject multi_result combined with named params", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: {
          sql: "SELECT * FROM users",
          params: { id: 1 },
          client_token: "token-value",
          options: {
            multi_result: true,
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("should reject top-level pagination combined with options.multi_result", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      pagination: {
        page: 1,
        pageSize: 100,
      },
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: {
          sql: "SELECT 1",
          options: {
            multi_result: true,
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("`pagination` cannot be combined with `options.multi_result=true`"),
        ),
      ).toBe(true);
    }
  });

  it("should accept api_version/meta extensions in command envelope", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q-meta",
        api_version: "2.4",
        meta: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
          tracestate: "vendor=value",
        },
        params: {
          sql: "SELECT 1",
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("should reject invalid api_version/meta envelope types", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q-invalid-meta",
        api_version: 24,
        meta: "not-an-object",
        params: {
          sql: "SELECT 1",
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
