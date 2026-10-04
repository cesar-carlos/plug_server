import { describe, expect, it } from "vitest";

import { env } from "../../../src/shared/config/env";
import { overrideEnv } from "../../helpers/override_env";

describe("overrideEnv", () => {
  it("should write a readonly env field and restore the previous value", () => {
    const previous = env.socketAgentAckRetryEnabled;
    const next = !previous;

    overrideEnv("socketAgentAckRetryEnabled", next);
    expect(env.socketAgentAckRetryEnabled).toBe(next);

    overrideEnv("socketAgentAckRetryEnabled", previous);
    expect(env.socketAgentAckRetryEnabled).toBe(previous);
  });
});
