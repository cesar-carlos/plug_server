import { describe, expect, it } from "vitest";
import {
  isValidActionIoResponse,
  isValidActionIoResult,
} from "../../../../src/shared/validators/action_io_result";
const receipt = {
  execution_id: "e",
  message_id: "m",
  sequence: 0,
  state: "accepted",
  confirmed_bytes: 0,
  next_input_sequence: 1,
  stdin_state: "open",
};
const page = {
  execution_id: "e",
  events: [],
  next_sequence: 0,
  terminal: false,
  output_complete: false,
};
describe("method-specific I/O results", () => {
  it("rejects overlapping or missing bytes within a stream while allowing interleaving and resumed offsets", () => {
    const events = [
      { sequence: 4, type: "output", stream: "stdout", offset: 20, data_base64: "AP8=" },
      { sequence: 5, type: "output", stream: "stderr", offset: 8, data_base64: "AA==" },
      { sequence: 6, type: "output", stream: "stdout", offset: 22, data_base64: "" },
    ];
    expect(
      isValidActionIoResult("agent.action.readIo", { ...page, events, next_sequence: 6 }),
    ).toBe(true);
    for (const offset of [21, 23, Number.MAX_SAFE_INTEGER]) {
      expect(
        isValidActionIoResult("agent.action.readIo", {
          ...page,
          events: [...events.slice(0, 2), { ...events[2], offset }],
          next_sequence: 6,
        }),
      ).toBe(false);
    }
    expect(
      isValidActionIoResult("agent.action.readIo", {
        ...page,
        events: [{ ...events[0], offset: Number.MAX_SAFE_INTEGER }],
        next_sequence: 4,
      }),
    ).toBe(false);
  });
  it("refuses cross-method results", () => {
    expect(isValidActionIoResult("agent.action.sendInput", receipt)).toBe(true);
    expect(isValidActionIoResult("agent.action.readIo", page)).toBe(true);
    expect(isValidActionIoResult("agent.action.sendInput", page)).toBe(false);
    expect(isValidActionIoResult("agent.action.readIo", receipt)).toBe(false);
  });
  it("preserves unknown delivery and empty output", () => {
    expect(
      isValidActionIoResult("agent.action.getInputStatus", {
        ...receipt,
        state: "unknown",
        confirmed_bytes: null,
      }),
    ).toBe(true);
    expect(
      isValidActionIoResult("agent.action.findExecution", {
        found: false,
        execution_id: null,
        reason: "not_found_in_retention_window",
      }),
    ).toBe(true);
  });
  it("rejects excessive decoded pages and incorrect cursors", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      sequence: i + 1,
      type: "output",
      stream: "stdout",
      offset: i * 65536,
      data_base64: Buffer.alloc(65536).toString("base64"),
    }));
    expect(
      isValidActionIoResult("agent.action.readIo", { ...page, events, next_sequence: 5 }),
    ).toBe(false);
    expect(
      isValidActionIoResult("agent.action.readIo", {
        ...page,
        events: events.slice(0, 4),
        next_sequence: 4,
      }),
    ).toBe(true);
    expect(
      isValidActionIoResult("agent.action.readIo", {
        ...page,
        events: events.slice(0, 1),
        next_sequence: 2,
      }),
    ).toBe(false);
  });
});

it("counts JSON-RPC metadata in the complete I/O response budget", () => {
  const method = "agent.action.getInputStatus";
  const response = { jsonrpc: "2.0", id: "", result: receipt };
  const available = 512 * 1024 - Buffer.byteLength(JSON.stringify(response));
  expect(isValidActionIoResponse(method, { ...response, id: "x".repeat(available) })).toBe(true);
  expect(isValidActionIoResponse(method, { ...response, id: "x".repeat(available + 1) })).toBe(
    false,
  );
});

it("applies the same complete-response budget to I/O errors", () => {
  const response = {
    jsonrpc: "2.0",
    id: "e",
    error: { code: -32000, message: "x".repeat(512 * 1024) },
  };
  expect(isValidActionIoResponse("agent.action.readIo", response)).toBe(false);
});
