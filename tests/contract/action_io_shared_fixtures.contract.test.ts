import { validateAgentInboundContract } from "../../src/presentation/socket/hub/handshake/agent_inbound_contract_validation";
import { env } from "../../src/shared/config/env";
import { overrideEnv } from "../helpers/override_env";
import { supportsActionIo } from "../../src/shared/constants/action_io_transport";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeSingleCommandSchema } from "../../src/shared/validators/agent_command";
import {
  isValidActionIoResult,
  isValidActionIoResponse,
} from "../../src/shared/validators/action_io_result";

interface FixtureCase {
  name: string;
  kind: "params" | "result" | "capability" | "error";
  method: string;
  payload: unknown;
  valid: boolean;
}
const fixtures = JSON.parse(
  readFileSync(join(process.cwd(), "contracts/action_io_shared_fixtures.json"), "utf8"),
) as {
  format: string;
  cases: FixtureCase[];
};
describe("shared agent/hub I/O fixtures", () => {
  it("uses the versioned shared fixture format", () => {
    expect(fixtures.format).toBe("action-io-shared-fixtures-v1");
  });
  it.each(fixtures.cases)("$name", (item) => {
    if (item.kind === "capability") {
      expect(supportsActionIo(item.payload)).toBe(item.valid);
      return;
    }
    if (item.kind === "error") {
      const original = env.socketAgentInboundContractValidation;
      overrideEnv("socketAgentInboundContractValidation", "strict");
      try {
        const envelope = validateAgentInboundContract({
          eventName: "rpc:response",
          socketId: "fixture",
          payload: item.payload,
        });
        expect(envelope.ok && isValidActionIoResponse(item.method, item.payload)).toBe(item.valid);
      } finally {
        overrideEnv("socketAgentInboundContractValidation", original);
      }
      return;
    }
    const valid =
      item.kind === "params"
        ? bridgeSingleCommandSchema.safeParse({
            id: "fixture",
            method: item.method,
            params: item.payload,
          }).success
        : isValidActionIoResult(item.method, item.payload);
    expect(valid).toBe(item.valid);
  });
});
