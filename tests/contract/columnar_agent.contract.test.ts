import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPlugAgenteContractPaths, createPlugAgenteAjv } from "../helpers/plug_agente_contract";
import { normalizeColumnarSqlChunk } from "../../src/infrastructure/codecs/sql_stream_chunk_codec";
import { validateAgentInboundContract } from "../../src/presentation/socket/hub/handshake/agent_inbound_contract_validation";

const agent = getPlugAgenteContractPaths();
(agent ? describe : describe.skip)("Dart-produced columnar contract", () => {
  it("matches the agent schema and yields the same row maps for hub consumers", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/fixtures/socket/columnar_codec_fixture.json"),
        "utf8",
      ),
    ) as {
      chunk: Record<string, unknown>;
      expected_rows: unknown[];
    };
    const schema = JSON.parse(
      readFileSync(join(agent!.schemasDir, "rpc.stream.chunk.schema.json"), "utf8"),
    );
    const encoderFixture = join(agent!.root, "test/fixtures/rpc/columnar_codec_fixture.json");
    // Legacy supported tags predate this fixture; current checkouts must
    // produce the same representation as the hub's mirrored contract input.
    if (existsSync(encoderFixture)) {
      expect(JSON.parse(readFileSync(encoderFixture, "utf8"))).toEqual(fixture);
    }
    expect(createPlugAgenteAjv(agent!.schemasDir).validate(schema.$id, fixture.chunk)).toBe(true);
    expect(
      validateAgentInboundContract({
        eventName: "rpc:chunk",
        socketId: "fixture-agent",
        payload: fixture.chunk,
      }).ok,
    ).toBe(true);
    expect(
      normalizeColumnarSqlChunk(fixture.chunk, { maxRows: 50000, maxBytes: 10 * 1024 * 1024 })!
        .payload.rows,
    ).toEqual(fixture.expected_rows);
  });
});
