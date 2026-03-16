import { describe, it, expect } from "vitest";
import { z } from "zod";

import { validateSocketPayload } from "../../../../src/shared/validators/socket.validator";

const messageSchema = z.object({
  roomId: z.string().min(1),
  text: z.string().min(1),
});

describe("validateSocketPayload", () => {
  it("should return ok with typed data for a valid payload", () => {
    const payload = { roomId: "room-1", text: "hello" };
    const result = validateSocketPayload(messageSchema, payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(payload);
    }
  });

  it("should return error with SOCKET_VALIDATION_ERROR code for an invalid payload", () => {
    const result = validateSocketPayload(messageSchema, { roomId: "", text: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOCKET_VALIDATION_ERROR");
      expect(result.error.statusCode).toBe(400);
    }
  });

  it("should include normalized issues in the error details", () => {
    const result = validateSocketPayload(messageSchema, { roomId: "ok", text: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = result.error.details as Array<{ field: string; message: string }>;
      expect(details.some((d) => d.field === "text")).toBe(true);
    }
  });

  it("should return error when payload is not an object", () => {
    const result = validateSocketPayload(messageSchema, null);

    expect(result.ok).toBe(false);
  });

  it("should return error when a required field is missing", () => {
    const result = validateSocketPayload(messageSchema, { roomId: "room-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = result.error.details as Array<{ field: string; message: string }>;
      expect(details.some((d) => d.field === "text")).toBe(true);
    }
  });
});
