import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortPendingConsumerCommands,
  registerConsumerCommandAbortController,
  resetConsumerCommandAbortRegistry,
} from "../../../../../src/presentation/socket/consumers/consumer_command_abort_registry";

describe("consumer_command_abort_registry", () => {
  afterEach(() => {
    resetConsumerCommandAbortRegistry();
  });

  it("aborts all registered controllers for a socket and clears the registry", () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const abortA = vi.spyOn(controllerA, "abort");
    const abortB = vi.spyOn(controllerB, "abort");

    registerConsumerCommandAbortController("socket-1", controllerA);
    registerConsumerCommandAbortController("socket-1", controllerB);

    const abortedCount = abortPendingConsumerCommands("socket-1", "Consumer socket disconnected");

    expect(abortedCount).toBe(2);
    expect(abortA).toHaveBeenCalledWith("Consumer socket disconnected");
    expect(abortB).toHaveBeenCalledWith("Consumer socket disconnected");
    expect(abortPendingConsumerCommands("socket-1")).toBe(0);
  });

  it("unregisters a controller when the returned cleanup runs", () => {
    const controller = new AbortController();
    const unregister = registerConsumerCommandAbortController("socket-2", controller);

    unregister();

    expect(abortPendingConsumerCommands("socket-2")).toBe(0);
  });
});
