import { describe, expect, it } from "vitest";

import {
  applyPaginationToCommand,
  computeBridgeWaitTimeoutMs,
  ensureJsonRpcIdsForBridge,
  extractSqlStatementTimeoutMs,
  normalizeCommandForAgent,
} from "../../../../src/application/agent_commands/command_transformers";

describe("command_transformers", () => {
  describe("ensureJsonRpcIdsForBridge", () => {
    it("should inject UUID when single command id is omitted", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        params: { sql: "SELECT 1" },
      };

      const result = ensureJsonRpcIdsForBridge(command);

      if (!Array.isArray(result)) {
        expect(typeof result.id).toBe("string");
        expect(result.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      }
    });

    it("should not replace explicit id or null", () => {
      const withId = ensureJsonRpcIdsForBridge({
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "client-1",
        params: { sql: "SELECT 1" },
      });
      if (!Array.isArray(withId)) {
        expect(withId.id).toBe("client-1");
      }

      const withNull = ensureJsonRpcIdsForBridge({
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: null,
        params: { sql: "SELECT 1" },
      });
      if (!Array.isArray(withNull)) {
        expect(withNull.id).toBeNull();
      }
    });

    it("should inject UUID only for batch items with omitted id", () => {
      const command = [
        {
          jsonrpc: "2.0" as const,
          method: "sql.execute" as const,
          id: "q1",
          params: { sql: "SELECT 1" },
        },
        {
          jsonrpc: "2.0" as const,
          method: "sql.execute" as const,
          params: { sql: "SELECT 2" },
        },
      ];

      const result = ensureJsonRpcIdsForBridge(command) as typeof command;

      expect(result[0].id).toBe("q1");
      expect(typeof result[1].id).toBe("string");
      expect(result[1].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("should assign unique UUIDs for every batch item with omitted id", () => {
      const command = Array.from({ length: 8 }, (_, index) => ({
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        params: { sql: `SELECT ${index}` },
      }));

      const result = ensureJsonRpcIdsForBridge(command) as Array<{ id: string }>;

      const ids = result.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      }
    });
  });

  describe("normalizeCommandForAgent", () => {
    it("should convert preserve_sql to execution_mode preserve and remove preserve_sql", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "req-1",
        params: {
          sql: "SELECT 1",
          client_token: "token",
          options: { preserve_sql: true },
        },
      };

      const result = normalizeCommandForAgent(command);

      expect(result.params.options).toEqual({ execution_mode: "preserve" });
      expect((result.params.options as Record<string, unknown>).preserve_sql).toBeUndefined();
    });

    it("should leave execution_mode preserve unchanged", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "req-2",
        params: {
          sql: "SELECT 1",
          options: { execution_mode: "preserve" },
        },
      };

      const result = normalizeCommandForAgent(command);

      expect(result.params.options).toEqual({ execution_mode: "preserve" });
    });

    it("should leave command without options unchanged", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "req-3",
        params: { sql: "SELECT 1" },
      };

      const result = normalizeCommandForAgent(command);

      expect(result).toEqual(command);
    });

    it("should normalize preserve_sql in batch items", () => {
      const command = [
        {
          jsonrpc: "2.0" as const,
          method: "sql.execute" as const,
          id: "q1",
          params: {
            sql: "SELECT 1",
            options: { preserve_sql: true },
          },
        },
      ];

      const result = normalizeCommandForAgent(command);

      expect(Array.isArray(result)).toBe(true);
      expect((result as typeof command)[0].params.options).toEqual({
        execution_mode: "preserve",
      });
    });
  });

  describe("applyPaginationToCommand", () => {
    it("should inject page and page_size from pagination", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "req-1",
        params: {
          sql: "SELECT * FROM users",
          client_token: "token",
        },
      };

      const result = applyPaginationToCommand(command, {
        page: 2,
        pageSize: 50,
      });

      expect(result.params.options).toEqual({
        page: 2,
        page_size: 50,
      });
    });

    it("should replace page/page_size with cursor when body.pagination has cursor", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "req-2",
        params: {
          sql: "SELECT * FROM users",
          options: { page: 1, page_size: 10 },
        },
      };

      const result = applyPaginationToCommand(command, {
        cursor: "eyJ2IjoyfQ",
      });

      expect(result.params.options).toEqual({
        cursor: "eyJ2IjoyfQ",
      });
    });

    it("should give pagination precedence over existing options", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "req-3",
        params: {
          sql: "SELECT 1",
          options: { page: 1, page_size: 10 },
        },
      };

      const result = applyPaginationToCommand(command, {
        page: 3,
        pageSize: 25,
      });

      expect(result.params.options).toEqual({
        page: 3,
        page_size: 25,
      });
    });

    it("should return command unchanged when pagination is undefined", () => {
      const command = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "req-4",
        params: { sql: "SELECT 1" },
      };

      const result = applyPaginationToCommand(command, undefined);

      expect(result).toEqual(command);
    });

    it("should return command unchanged for batch", () => {
      const command = [
        {
          jsonrpc: "2.0" as const,
          method: "sql.execute" as const,
          id: "q1",
          params: { sql: "SELECT 1" },
        },
      ];

      const result = applyPaginationToCommand(command, {
        page: 1,
        pageSize: 10,
      });

      expect(result).toEqual(command);
    });
  });

  describe("extractSqlStatementTimeoutMs / computeBridgeWaitTimeoutMs", () => {
    it("should read timeout from sql.execute options", () => {
      const cmd = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "a",
        params: { sql: "SELECT 1", options: { timeout_ms: 120_000 } },
      };
      expect(extractSqlStatementTimeoutMs(cmd)).toBe(120_000);
      expect(computeBridgeWaitTimeoutMs(cmd, 15_000)).toBe(125_000);
    });

    it("should use max timeout in batch", () => {
      const batch = [
        {
          jsonrpc: "2.0" as const,
          method: "sql.execute" as const,
          id: "a",
          params: { sql: "SELECT 1", options: { timeout_ms: 10_000 } },
        },
        {
          jsonrpc: "2.0" as const,
          method: "sql.executeBatch" as const,
          id: "b",
          params: {
            commands: [{ sql: "SELECT 1" }],
            options: { timeout_ms: 200_000 },
          },
        },
      ];
      expect(extractSqlStatementTimeoutMs(batch)).toBe(200_000);
    });

    it("should cap bridge wait at ceiling", () => {
      const cmd = {
        jsonrpc: "2.0" as const,
        method: "sql.execute" as const,
        id: "a",
        params: { sql: "SELECT 1", options: { timeout_ms: 300_000 } },
      };
      expect(computeBridgeWaitTimeoutMs(cmd, 500_000)).toBe(360_000);
    });
  });
});
