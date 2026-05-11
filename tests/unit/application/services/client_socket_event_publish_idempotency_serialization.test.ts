import { describe, expect, it, vi } from "vitest";

import {
  getClientSocketEventPublishIdempotencySerializationTrackedKeyCount,
  resetClientSocketEventPublishIdempotencySerializationQueues,
  runWithClientSocketEventPublishIdempotencySerialization,
} from "../../../../src/application/services/client_socket_event_publish_idempotency_serialization";
import * as socketConsumerMetrics from "../../../../src/shared/metrics/socket_consumer.metrics";

describe("runWithClientSocketEventPublishIdempotencySerialization", () => {
  it("runs tasks for the same key strictly one after another", async () => {
    resetClientSocketEventPublishIdempotencySerializationQueues();
    let depth = 0;
    let maxDepth = 0;
    const run = async (label: string): Promise<string> =>
      runWithClientSocketEventPublishIdempotencySerialization("c", "k", async () => {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        await new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        });
        depth -= 1;
        return label;
      });

    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect(maxDepth).toBe(1);
    expect(new Set([a, b])).toEqual(new Set(["a", "b"]));
    expect(getClientSocketEventPublishIdempotencySerializationTrackedKeyCount()).toBe(0);
  });

  it("drops the map entry when the chain for a key finishes", async () => {
    resetClientSocketEventPublishIdempotencySerializationQueues();
    expect(getClientSocketEventPublishIdempotencySerializationTrackedKeyCount()).toBe(0);
    await runWithClientSocketEventPublishIdempotencySerialization("client", "idem-1", async () => "done");
    expect(getClientSocketEventPublishIdempotencySerializationTrackedKeyCount()).toBe(0);
  });

  it("rejects with 503 when distinct keys exceed maxTrackedKeys (and records metric)", async () => {
    resetClientSocketEventPublishIdempotencySerializationQueues();
    const spy = vi.spyOn(
      socketConsumerMetrics,
      "noteClientSocketEventPublishIdempotencySerializationCapRejected",
    );

    let release!: () => void;
    const wall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = async (): Promise<number> => {
      await wall;
      return 1;
    };

    const maxTrackedKeys = 2;
    const first = runWithClientSocketEventPublishIdempotencySerialization(
      "c",
      "k1",
      hang,
      { maxTrackedKeys },
    );
    const second = runWithClientSocketEventPublishIdempotencySerialization(
      "c",
      "k2",
      hang,
      { maxTrackedKeys },
    );

    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(getClientSocketEventPublishIdempotencySerializationTrackedKeyCount()).toBe(2);

    await expect(
      runWithClientSocketEventPublishIdempotencySerialization("c", "k3", async () => 99, {
        maxTrackedKeys,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      details: { retry_after_ms: expect.any(Number) },
    });
    expect(spy).toHaveBeenCalledTimes(1);

    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeInstanceOf(Promise);
    release();
    await Promise.all([first, second]);
    expect(getClientSocketEventPublishIdempotencySerializationTrackedKeyCount()).toBe(0);

    spy.mockRestore();
  });
});
