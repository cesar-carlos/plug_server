import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodePayloadFrame,
  encodePayloadFrame,
  isPayloadFrameEnvelope,
  PAYLOAD_FRAME_SCHEMA_VERSION,
} from "../../src/shared/utils/payload_frame";
import { env } from "../../src/shared/config/env";
import { createPlugAgenteAjv, getPlugAgenteContractPaths } from "../helpers/plug_agente_contract";

interface AgentInboundCatalog {
  readonly hmacTestKey: string;
  readonly hmacKeyId: string;
  readonly frames: Record<string, unknown>;
}

const catalog = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "tests/fixtures/socket/agent_inbound_catalog.json"),
    "utf8",
  ),
) as AgentInboundCatalog;

describe("socket agent inbound fixtures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encodes none and gzip PayloadFrames for every catalog body", () => {
    for (const [name, body] of Object.entries(catalog.frames)) {
      const none = encodePayloadFrame(body, {
        requestId: `fixture-${name}`,
        compressionThreshold: Number.POSITIVE_INFINITY,
      });
      expect(none.schemaVersion).toBe(PAYLOAD_FRAME_SCHEMA_VERSION);
      expect(none.cmp).toBe("none");
      expect(isPayloadFrameEnvelope(none)).toBe(true);
      const decodedNone = decodePayloadFrame(none);
      expect(decodedNone.ok).toBe(true);

      const gzip = encodePayloadFrame(body, {
        requestId: `fixture-${name}`,
        compressionThreshold: 1,
        compressionPolicy: "always_gzip",
      });
      expect(isPayloadFrameEnvelope(gzip)).toBe(true);
      const decodedGzip = decodePayloadFrame(gzip);
      expect(decodedGzip.ok).toBe(true);
    }
  });

  it("signs and verifies the canonical HMAC-SHA256 frame with the fixture key", () => {
    vi.spyOn(env, "payloadSigningKey", "get").mockReturnValue(catalog.hmacTestKey);
    vi.spyOn(env, "payloadSigningKeyId", "get").mockReturnValue(catalog.hmacKeyId);
    vi.spyOn(env, "payloadSigningPreviousKeys", "get").mockReturnValue({});
    vi.spyOn(env, "payloadSignOutbound", "get").mockReturnValue(true);
    const frame = encodePayloadFrame(catalog.frames.unaryResponse, {
      requestId: "fixture-hmac",
      compressionThreshold: Number.POSITIVE_INFINITY,
    });
    expect(frame.signature?.key_id).toBe(catalog.hmacKeyId);
    expect(decodePayloadFrame(frame).ok).toBe(true);
    const tampered = { ...frame, requestId: "different-request-id" };
    expect(decodePayloadFrame(tampered).ok).toBe(false);
  });

  const agentContract = getPlugAgenteContractPaths();
  const contractTest = agentContract === null ? it.skip : it;
  contractTest("matches the agent's source JSON Schemas", () => {
    if (agentContract === null) {
      return;
    }
    const ajv = createPlugAgenteAjv(agentContract.schemasDir);
    const schemaByFixture: Record<string, string> = {
      agentRegister: "agent.register",
      takeoverRegister: "agent.register",
      agentCapabilities: "agent.capabilities",
      agentReady: "agent.ready",
      unaryResponse: "rpc.response",
      retryResponse: "rpc.response",
      streamOpen: "rpc.response",
      streamChunk: "rpc.stream.chunk",
      streamComplete: "rpc.stream.complete",
      terminalError: "rpc.stream.complete",
    };
    for (const [fixtureName, schemaName] of Object.entries(schemaByFixture)) {
      const schema = ajv.getSchema(`https://plugagente.dev/schemas/${schemaName}.v1.json`);
      expect(schema, schemaName).toBeDefined();
      expect(
        schema?.(catalog.frames[fixtureName]),
        `${fixtureName}: ${ajv.errorsText(schema?.errors)}`,
      ).toBe(true);
    }
  });

  it("treats invalidFrameBody as a non-envelope object", () => {
    expect(isPayloadFrameEnvelope(catalog.frames.invalidFrameBody)).toBe(false);
  });

  it("keeps the oversize fixture larger than the documented 64 KiB default threshold", () => {
    const hint = catalog.frames.oversizeHint as { declaredOriginalSize: number };
    expect(hint.declaredOriginalSize).toBeGreaterThan(64 * 1024);
  });
});
