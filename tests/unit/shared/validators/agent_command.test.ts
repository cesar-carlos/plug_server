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

  it("should accept single command with id omitted (bridge assigns UUID before dispatch)", () => {
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

  it("should accept JSON-RPC batch with explicit null id notification and string ids", () => {
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
          id: null,
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
        api_version: "2.5",
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

  it("should accept execution_mode preserve", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q-preserve",
        params: {
          sql: "SELECT * FROM users LIMIT 10",
          client_token: "token-value",
          options: {
            execution_mode: "preserve",
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("should accept preserve_sql (legacy alias)", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q-preserve-sql",
        params: {
          sql: "SELECT 1",
          client_token: "token-value",
          options: {
            preserve_sql: true,
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("should reject execution_mode preserve combined with pagination", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: {
          sql: "SELECT * FROM users",
          client_token: "token-value",
          options: {
            execution_mode: "preserve",
            page: 1,
            page_size: 100,
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("cannot be combined with `page`, `page_size` or `cursor`"),
        ),
      ).toBe(true);
    }
  });

  it("should reject top-level pagination combined with execution_mode preserve", () => {
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
          client_token: "token-value",
          options: {
            execution_mode: "preserve",
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("`pagination` cannot be combined with `options.execution_mode=preserve`"),
        ),
      ).toBe(true);
    }
  });

  it("should reject execution_mode managed combined with preserve_sql true", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: {
          sql: "SELECT 1",
          client_token: "token-value",
          options: {
            execution_mode: "managed",
            preserve_sql: true,
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("`execution_mode: managed` cannot be combined with `preserve_sql: true`"),
        ),
      ).toBe(true);
    }
  });

  it("should reject timeout_ms exceeding AGENT_TIMEOUT_MS_LIMIT", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: {
          sql: "SELECT 1",
          client_token: "token-value",
          options: { timeout_ms: 400_000 },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("should reject page_size exceeding AGENT_PAGE_SIZE_LIMIT", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: {
          sql: "SELECT 1",
          client_token: "token-value",
          options: { page: 1, page_size: 60_000 },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("should reject max_rows exceeding AGENT_MAX_ROWS_LIMIT", () => {
    const parsed = agentCommandBodySchema.safeParse({
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: {
          sql: "SELECT 1",
          client_token: "token-value",
          options: { max_rows: 2_000_000 },
        },
      },
    });

    expect(parsed.success).toBe(false);
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
