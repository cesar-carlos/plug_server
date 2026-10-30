import { describe, expect, it } from "vitest";
import {
  ACTION_IO_TRANSPORT,
  supportsActionIo,
} from "../../../../src/shared/constants/action_io_transport";

describe("action I/O v1 negotiation", () => {
  it("accepts the complete fixed agreement", () => {
    expect(supportsActionIo({ ...ACTION_IO_TRANSPORT })).toBe(true);
  });
  it.each(Object.keys(ACTION_IO_TRANSPORT))("rejects a missing or changed %s", (key) => {
    const missing: Record<string, unknown> = { ...ACTION_IO_TRANSPORT };
    delete missing[key];
    expect(supportsActionIo(missing)).toBe(false);
    expect(supportsActionIo({ ...ACTION_IO_TRANSPORT, [key]: null })).toBe(false);
  });
  it("refuses absent, partial, extended and type-coerced agreements", () => {
    for (const value of [
      undefined,
      null,
      [],
      1,
      { version: 1 },
      { ...ACTION_IO_TRANSPORT, version: "1" },
      { ...ACTION_IO_TRANSPORT, extra: true },
    ]) {
      expect(supportsActionIo(value)).toBe(false);
    }
  });
});
