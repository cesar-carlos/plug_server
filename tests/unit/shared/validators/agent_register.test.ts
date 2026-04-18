import { describe, expect, it } from "vitest";

import { agentRegisterPayloadSchema } from "../../../../src/shared/validators/agent_register";

describe("agentRegisterPayloadSchema (plug_agente agent.register.schema.json alignment)", () => {
  const baseCapabilities = {
    protocols: ["jsonrpc-v2"],
    encodings: ["json"],
    compressions: ["gzip", "none"],
    extensions: { binaryPayload: true },
    limits: { max_rows: 50_000 },
  };

  it("accepts a fully populated payload", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "agent-uuid-123",
      timestamp: "2026-04-18T12:00:00.000Z",
      capabilities: baseCapabilities,
      profile: { name: "Agente A", payload: { foo: "bar" } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agentId).toBe("agent-uuid-123");
      expect(parsed.data.profile).toEqual({ name: "Agente A", payload: { foo: "bar" } });
    }
  });

  it("trims agentId whitespace", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "   agent-trim   ",
      capabilities: baseCapabilities,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agentId).toBe("agent-trim");
    }
  });

  it("accepts payloads without optional `timestamp` (back-compat)", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "agent-no-ts",
      capabilities: baseCapabilities,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects non-ISO `timestamp`", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "agent-bad-ts",
      timestamp: "not-a-date",
      capabilities: baseCapabilities,
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults missing `extensions` and `limits` to empty objects", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "agent-minimal-caps",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capabilities.extensions).toEqual({});
      expect(parsed.data.capabilities.limits).toEqual({});
    }
  });

  it("rejects empty `protocols` / `encodings` / `compressions`", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "agent-empty-caps",
      capabilities: {
        protocols: [],
        encodings: ["json"],
        compressions: ["none"],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing `agentId`", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      capabilities: baseCapabilities,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty `agentId` after trim", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "   ",
      capabilities: baseCapabilities,
    });
    expect(parsed.success).toBe(false);
  });

  it("preserves unknown root keys (passthrough)", () => {
    const parsed = agentRegisterPayloadSchema.safeParse({
      agentId: "agent-unknown",
      capabilities: baseCapabilities,
      futureField: { v: 1 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).futureField).toEqual({ v: 1 });
    }
  });
});
