import { describe, expect, it } from "vitest";

import {
  applyPaginationToCommand,
  normalizeCommandForAgent,
} from "../../../../src/application/agent_commands/command_transformers";

describe("command_transformers", () => {
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
});
