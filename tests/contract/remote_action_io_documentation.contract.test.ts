import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { supportsActionIo } from "../../src/shared/constants/action_io_transport";
import { bridgeSingleCommandSchema } from "../../src/shared/validators/agent_command";
import { captureActionIoExpectation } from "../../src/shared/validators/action_io_response_expectation";
import { isValidActionIoResponse } from "../../src/shared/validators/action_io_result";

const root = join(process.cwd(), "docs/plug_agente");
const schema = JSON.parse(readFileSync(join(root, "drafts/action_io_v1.schema.json"), "utf8"));
const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addFormat(
  "date-time",
  (value: string) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
);
const validate = ajv.compile(schema);
const guide = readFileSync(join(root, "remote_action_io_examples.md"), "utf8").split(
  "## 2. Binary bridge",
)[1]!;
const examples = [...guide.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) =>
  JSON.parse(match[1]!),
);
const failures: Array<{ name: string; payload: unknown }> = JSON.parse(
  readFileSync(join(root, "drafts/action_io_failure_examples.json"), "utf8"),
);

describe("action I/O documentation fixtures", () => {
  it("uses the complete runtime capability and correlates example responses to their requests", () => {
    const requests = new Map(examples.filter((item) => item.method).map((item) => [item.id, item]));
    for (const example of examples) {
      if (example.io) expect(supportsActionIo(example.io)).toBe(true);
      if (example.method) expect(bridgeSingleCommandSchema.safeParse(example).success).toBe(true);
      if (example.result) {
        const request = requests.get(example.id);
        expect(request, `Missing request for ${example.id}`).toBeDefined();
        expect(
          isValidActionIoResponse(request.method, example, captureActionIoExpectation(request)),
          `Invalid runtime response for ${example.id}`,
        ).toBe(true);
      }
    }
  });
  it("keeps every guide example valid against the draft schema", () => {
    expect(examples.length).toBeGreaterThanOrEqual(15);
    for (const example of examples) {
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each(failures)("validates $name", ({ payload }) => {
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("preserves legacy run fields and accepts terminal duplicates", () => {
    const validateRun = ajv.compile({ $ref: "urn:plug:draft:action-io:1#/$defs/runResult" });
    const queued = examples.find((value) => value.id === "run-2" && value.result)?.result;
    expect(queued).toBeDefined();
    const terminal = {
      ...queued,
      status: "succeeded",
      flags: { ...queued.flags, terminal: true },
      io: { ...queued.io, process_state: "finished", capture_state: "complete" },
    };
    expect(validateRun(terminal), JSON.stringify(validateRun.errors)).toBe(true);
    expect(validateRun({ execution_id: "e", status: "queued", io: queued.io })).toBe(false);
    const validateDryRun = ajv.compile({
      $ref: "urn:plug:draft:action-io:1#/$defs/validateResult",
    });
    expect(
      validateDryRun({
        valid: true,
        action_id: "a",
        action_type: "executable",
        would_replay_existing_execution: true,
        existing_execution_id: "e",
      }),
    ).toBe(true);
    expect(validateDryRun({ valid: true, would_replay: true })).toBe(false);
  });

  const input = (data_base64: string, sequence = 0): unknown => ({
    jsonrpc: "2.0",
    id: "test",
    method: "agent.action.sendInput",
    params: { execution_id: "execution", message_id: "message", sequence, data_base64 },
  });

  it("accepts empty and binary input but rejects malformed base64 and negative sequences", () => {
    expect(validate(input(""))).toBe(true);
    expect(validate(input("AP+A"))).toBe(true);
    expect(validate(input("%%%"))).toBe(false);
    expect(validate(input("AP+A", -1))).toBe(false);
    expect(validate(input("a".repeat(87388)))).toBe(false);
  });

  it("rejects unknown request fields and overlong reads", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: "test",
        method: "agent.action.readIo",
        params: { execution_id: "e", after_sequence: 0, max_bytes: 262145, wait_ms: 20000 },
      }),
    ).toBe(false);
    expect(
      validate({
        jsonrpc: "2.0",
        id: "test",
        method: "agent.action.closeInput",
        params: { execution_id: "e", message_id: "m", sequence: 0, command: "unexpected" },
      }),
    ).toBe(false);
  });

  it("does not accept a read result as an input acknowledgement", () => {
    const validateSend = ajv.compile({
      $ref: "urn:plug:draft:action-io:1#/$defs/sendResult",
    });
    expect(
      validateSend({
        execution_id: "e",
        events: [],
        next_sequence: 0,
        terminal: false,
        output_complete: false,
      }),
    ).toBe(false);
  });
});
