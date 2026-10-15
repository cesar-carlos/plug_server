import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPlugAgenteContractPaths, createPlugAgenteAjv } from "../helpers/plug_agente_contract";
import { normalizeColumnarSqlChunk } from "../../src/infrastructure/codecs/sql_stream_chunk_codec";
import { validateAgentInboundContract } from "../../src/presentation/socket/hub/handshake/agent_inbound_contract_validation";

const agent = getPlugAgenteContractPaths();
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/socket/columnar_codec_fixture.json"), "utf8"),
) as { chunk: Record<string, unknown>; expected_rows: Record<string, unknown>[] };
const rowChunk = {
  stream_id: fixture.chunk.stream_id,
  request_id: fixture.chunk.request_id,
  chunk_index: fixture.chunk.chunk_index,
  rows: fixture.expected_rows,
};
interface StreamChunkSchema {
  readonly $id: string;
  readonly properties: Record<string, unknown>;
  readonly additionalProperties: boolean;
}

const readSchema = (): StreamChunkSchema =>
  JSON.parse(
    readFileSync(join(agent!.schemasDir, "rpc.stream.chunk.schema.json"), "utf8"),
  ) as StreamChunkSchema;

(agent ? describe : describe.skip)("Dart-produced columnar contract", () => {
  it("accepts the row-map wire representation emitted by legacy and current agents", () => {
    const schema = readSchema();
    expect(createPlugAgenteAjv(agent!.schemasDir).validate(schema.$id, rowChunk)).toBe(true);
    expect(
      validateAgentInboundContract({
        eventName: "rpc:chunk",
        socketId: "fixture-agent",
        payload: rowChunk,
      }).ok,
    ).toBe(true);
    expect(
      normalizeColumnarSqlChunk(rowChunk, { maxRows: 50000, maxBytes: 10 * 1024 * 1024 }),
    ).toBeNull();
  });

  it("accepts columnar only when declared by the checked-out agent contract", () => {
    const schema = readSchema();
    const ajv = createPlugAgenteAjv(agent!.schemasDir);
    const encoderFixture = join(agent!.root, "test/fixtures/rpc/columnar_codec_fixture.json");
    // v1.8.6 declares columnar but predates the checked-in encoder fixture.
    // Fixture availability cannot determine an installed agent's wire capabilities.
    if (existsSync(encoderFixture)) {
      expect(JSON.parse(readFileSync(encoderFixture, "utf8"))).toEqual(fixture);
      expect(schema.properties).toHaveProperty("columnar");
    }
    if (Object.hasOwn(schema.properties, "columnar")) {
      expect(ajv.validate(schema.$id, fixture.chunk)).toBe(true);
    } else {
      expect(schema.properties).not.toHaveProperty("columnar");
      expect(schema.additionalProperties).toBe(false);
      expect(ajv.validate(schema.$id, fixture.chunk)).toBe(false);
      expect(ajv.errors).toContainEqual(
        expect.objectContaining({
          keyword: "additionalProperties",
          params: { additionalProperty: "columnar" },
        }),
      );
    }
  });

  it("normalizes the current Dart fixture to the exact legacy row-map payload", () => {
    expect(
      validateAgentInboundContract({
        eventName: "rpc:chunk",
        socketId: "fixture-agent",
        payload: fixture.chunk,
      }).ok,
    ).toBe(true);
    expect(
      normalizeColumnarSqlChunk(fixture.chunk, { maxRows: 50000, maxBytes: 10 * 1024 * 1024 })!
        .payload,
    ).toEqual(rowChunk);
  });

  it("continues rejecting missing fields, invalid indices and unknown properties", () => {
    const schema = readSchema();
    const ajv = createPlugAgenteAjv(agent!.schemasDir);
    for (const field of ["stream_id", "request_id", "chunk_index", "rows"]) {
      const incomplete: Record<string, unknown> = { ...rowChunk };
      delete incomplete[field];
      expect(ajv.validate(schema.$id, incomplete)).toBe(false);
    }
    for (const invalid of [
      { ...rowChunk, chunk_index: -1 },
      { ...rowChunk, rows: [1] },
      { ...rowChunk, unexpected: true },
    ]) {
      expect(ajv.validate(schema.$id, invalid)).toBe(false);
    }
  });
});
