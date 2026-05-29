import { describe, expect, it } from "vitest";

import {
  resolveAgentRegisterProfileSnapshot,
  resolveRequiresExplicitProtocolReadyAck,
} from "../../../../../src/presentation/socket/hub/agent_register_payload";

type Capabilities = Parameters<typeof resolveRequiresExplicitProtocolReadyAck>[0];

const capabilities = (overrides: Record<string, unknown>): Capabilities =>
  ({ protocols: ["jsonrpc-v2"], encodings: ["json"], compressions: ["none"], ...overrides }) as Capabilities;

describe("resolveRequiresExplicitProtocolReadyAck", () => {
  it("returns true for the top-level camelCase flag", () => {
    expect(resolveRequiresExplicitProtocolReadyAck(capabilities({ protocolReadyAck: true }))).toBe(
      true,
    );
  });

  it("returns true for the top-level snake_case flag", () => {
    expect(
      resolveRequiresExplicitProtocolReadyAck(capabilities({ protocol_ready_ack: true })),
    ).toBe(true);
  });

  it("returns true for the camelCase flag inside extensions", () => {
    expect(
      resolveRequiresExplicitProtocolReadyAck(
        capabilities({ extensions: { protocolReadyAck: true } }),
      ),
    ).toBe(true);
  });

  it("returns true for the snake_case flag inside extensions", () => {
    expect(
      resolveRequiresExplicitProtocolReadyAck(
        capabilities({ extensions: { protocol_ready_ack: true } }),
      ),
    ).toBe(true);
  });

  it("returns false when no flag is set", () => {
    expect(resolveRequiresExplicitProtocolReadyAck(capabilities({}))).toBe(false);
  });

  it("returns false when extensions is not a record", () => {
    expect(resolveRequiresExplicitProtocolReadyAck(capabilities({ extensions: "nope" }))).toBe(
      false,
    );
  });

  it("requires strict boolean true (truthy values do not count)", () => {
    expect(resolveRequiresExplicitProtocolReadyAck(capabilities({ protocolReadyAck: 1 }))).toBe(
      false,
    );
  });
});

describe("resolveAgentRegisterProfileSnapshot", () => {
  const validUpdatedAt = "2026-05-25T13:00:00.000Z";

  it("builds a snapshot when profile, version and timestamp are all present and valid", () => {
    const snapshot = resolveAgentRegisterProfileSnapshot({
      profile: { name: "Agent X" },
      profile_version: 7,
      profile_updated_at: validUpdatedAt,
    });
    expect(snapshot).toBeDefined();
    expect(snapshot?.profile).toEqual({ name: "Agent X" });
    expect(snapshot?.profileVersion).toBe(7);
    expect(snapshot?.profileUpdatedAt.toISOString()).toBe(validUpdatedAt);
  });

  it("returns undefined when profile is missing", () => {
    expect(
      resolveAgentRegisterProfileSnapshot({
        profile: undefined,
        profile_version: 7,
        profile_updated_at: validUpdatedAt,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when version is missing", () => {
    expect(
      resolveAgentRegisterProfileSnapshot({
        profile: { name: "x" },
        profile_version: undefined,
        profile_updated_at: validUpdatedAt,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the timestamp is missing", () => {
    expect(
      resolveAgentRegisterProfileSnapshot({
        profile: { name: "x" },
        profile_version: 7,
        profile_updated_at: undefined,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the timestamp is not a valid date", () => {
    expect(
      resolveAgentRegisterProfileSnapshot({
        profile: { name: "x" },
        profile_version: 7,
        profile_updated_at: "not-a-date",
      }),
    ).toBeUndefined();
  });
});
