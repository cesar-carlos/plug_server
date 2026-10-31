import { describe, expect, it } from "vitest";
import {
  ACTION_IO_BLOCK_BYTES,
  actionIoBlockSchema,
  actionIoConfigurationSchema,
  actionIoReadParamsSchema,
  actionIoSendInputParamsSchema,
} from "../../../../src/shared/validators/action_io";

describe("faithful action I/O boundaries", () => {
  it("accepts only canonical padding bits for every possible final sextet", () => {
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/") {
      for (const value of [`Z${c}==`, `Zm${c}=`]) {
        const canonical = Buffer.from(value, "base64").toString("base64") === value;
        expect(actionIoBlockSchema.safeParse(value).success).toBe(canonical);
      }
    }
  });
  it("preserves every byte and accepts the decoded limit", () => {
    const bytes = Buffer.from(Array.from({ length: ACTION_IO_BLOCK_BYTES }, (_, i) => i % 256));
    const value = bytes.toString("base64");
    expect(actionIoBlockSchema.parse(value)).toBe(value);
    expect(
      actionIoBlockSchema.safeParse(Buffer.alloc(ACTION_IO_BLOCK_BYTES + 1).toString("base64"))
        .success,
    ).toBe(false);
  });
  it.each(["Zg", "Zh==", "Zm9=", " Zg==", "Zg==\n", "____", "===="])(
    "refuses noncanonical base64 %j",
    (value) => {
      expect(actionIoBlockSchema.safeParse(value).success).toBe(false);
    },
  );
  it("distinguishes missing initial input from an empty block", () => {
    const config = { version: 1, mode: "faithful", close_input: false };
    expect(actionIoConfigurationSchema.parse(config)).not.toHaveProperty("initial_input_base64");
    expect(
      actionIoConfigurationSchema.parse({ ...config, initial_input_base64: "" }),
    ).toHaveProperty("initial_input_base64", "");
    expect(
      actionIoSendInputParamsSchema.parse({
        execution_id: "e",
        message_id: "m",
        sequence: 0,
        data_base64: "",
      }).data_base64,
    ).toBe("");
  });
  it("refuses extra execution instructions and unsafe sequences", () => {
    const input = { execution_id: "e", message_id: "m", sequence: 0, data_base64: "" };
    expect(actionIoSendInputParamsSchema.safeParse({ ...input, command: "ignored?" }).success).toBe(
      false,
    );
    expect(
      actionIoSendInputParamsSchema.safeParse({ ...input, sequence: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false);
  });
  it("requires a page large enough for one block and bounds the wait", () => {
    const page = {
      execution_id: "e",
      after_sequence: 0,
      max_bytes: ACTION_IO_BLOCK_BYTES,
      wait_ms: 20000,
    };
    expect(actionIoReadParamsSchema.safeParse(page).success).toBe(true);
    expect(
      actionIoReadParamsSchema.safeParse({ ...page, max_bytes: ACTION_IO_BLOCK_BYTES - 1 }).success,
    ).toBe(false);
    expect(actionIoReadParamsSchema.safeParse({ ...page, wait_ms: 20001 }).success).toBe(false);
  });
});
