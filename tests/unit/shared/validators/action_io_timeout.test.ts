import { describe, expect, it } from "vitest";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
import { computeBridgeWaitTimeoutMs } from "../../../../src/application/agent_commands/command_transformers";
const read = bridgeSingleCommandSchema.parse({
  id: "read",
  method: "agent.action.readIo",
  params: { execution_id: "e", after_sequence: 0, max_bytes: 65536, wait_ms: 20000 },
});
describe("I/O bridge wait ceiling", () => {
  it("caps oversized waits and preserves shorter caller limits", () => {
    expect(computeBridgeWaitTimeoutMs(read, 120000)).toBe(30000);
    expect(computeBridgeWaitTimeoutMs(read, 10000)).toBe(10000);
    expect(computeBridgeWaitTimeoutMs(read)).toBe(30000);
  });
  it("does not let SQL in a mixed read batch enlarge the I/O ceiling", () => {
    const sql = bridgeSingleCommandSchema.parse({
      id: "sql",
      method: "sql.execute",
      params: { sql: "SELECT 1", options: { timeout_ms: 120000 } },
    });
    expect(computeBridgeWaitTimeoutMs([read, sql], 300000)).toBe(30000);
    expect(computeBridgeWaitTimeoutMs(sql)).toBeGreaterThan(30000);
  });
});
