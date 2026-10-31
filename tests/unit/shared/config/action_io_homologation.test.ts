import { afterEach, expect, it } from "vitest";
import { env } from "../../../../src/shared/config/env";
import { overrideEnv } from "../../../helpers/override_env";
import { buildHubServerCapabilities } from "../../../../src/shared/constants/agent_transport_contract";
import { ACTION_IO_TRANSPORT } from "../../../../src/shared/constants/action_io_transport";
import { assertActionIoTransport } from "../../../../src/application/agent_commands/action_io_transport_guard";
const originalEnabled = env.enableActionIoHomologation;
const originalNodeEnv = env.nodeEnv;
afterEach(() => {
  overrideEnv("enableActionIoHomologation", originalEnabled);
  overrideEnv("nodeEnv", originalNodeEnv);
});
const command = {
  method: "agent.action.readIo",
  params: { execution_id: "e", after_sequence: 0, max_bytes: 65536, wait_ms: 0 },
};
const peer = {
  protocols: ["jsonrpc-v2"],
  encodings: ["json"],
  compressions: ["none"],
  limits: {
    max_payload_bytes: 524288,
    max_decoded_payload_bytes: 524288,
    max_compressed_payload_bytes: 524288,
  },
  extensions: {
    binaryPayload: true,
    transportFrame: "payload-frame/1.0",
    agentActions: { enabled: true, version: 1, io: ACTION_IO_TRANSPORT },
  },
};
it("does not advertise or dispatch I/O without explicit opt-in", () => {
  overrideEnv("enableActionIoHomologation", false);
  expect(buildHubServerCapabilities().extensions).not.toHaveProperty("agentActions");
  expect(() => assertActionIoTransport(command, peer)).toThrow();
});
it("advertises the exact agreement in an opted-in isolated test and rechecks disabling", () => {
  overrideEnv("nodeEnv", "test");
  overrideEnv("enableActionIoHomologation", true);
  expect(buildHubServerCapabilities().extensions.agentActions).toEqual({
    enabled: true,
    version: 1,
    catalogVersion: 1,
    io: ACTION_IO_TRANSPORT,
  });
  expect(() => assertActionIoTransport(command, peer)).not.toThrow();
  expect(() => assertActionIoTransport(command, null)).toThrow();
  overrideEnv("enableActionIoHomologation", false);
  expect(() => assertActionIoTransport(command, peer)).toThrow();
});
it("does not activate production even with the homologation flag", () => {
  overrideEnv("nodeEnv", "production");
  overrideEnv("enableActionIoHomologation", true);
  expect(buildHubServerCapabilities().extensions).not.toHaveProperty("agentActions");
  expect(() => assertActionIoTransport(command, peer)).toThrow();
});
