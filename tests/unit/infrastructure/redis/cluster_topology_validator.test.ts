import { describe, expect, it, vi } from "vitest";

import { validateRedisClusterTopology } from "../../../../src/infrastructure/redis/cluster_topology_validator";

interface ClientStub {
  readonly sendCommand: ReturnType<typeof vi.fn>;
}

const buildClient = (
  setup: (sendCommand: ReturnType<typeof vi.fn>) => void,
): ClientStub & { readonly sendCommand: ReturnType<typeof vi.fn> } => {
  const sendCommand = vi.fn();
  setup(sendCommand);
  return { sendCommand } as unknown as ClientStub & {
    readonly sendCommand: ReturnType<typeof vi.fn>;
  };
};

describe("validateRedisClusterTopology", () => {
  it("returns immediately on standalone Redis (cluster_enabled:0)", async () => {
    const client = buildClient((send) => {
      send.mockImplementation(async (args: string[]) => {
        if (args[0] === "CLUSTER" && args[1] === "INFO") {
          return "cluster_enabled:0\r\ncluster_state:ok\r\n";
        }
        return undefined;
      });
    });

    await expect(
      validateRedisClusterTopology({
        client: client as never,
        logName: "test_module",
        sampleKeys: ["plug:{plug}:a", "plug:{plug}:b"],
      }),
    ).resolves.toBeUndefined();

    // Only CLUSTER INFO is called; no CLUSTER KEYSLOT for standalone.
    const commandsCalled = client.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
    expect(commandsCalled).toEqual([["CLUSTER", "INFO"]]);
  });

  it("logs OK when cluster_enabled=1 and all sample keys land on the same slot", async () => {
    const client = buildClient((send) => {
      send.mockImplementation(async (args: string[]) => {
        if (args[0] === "CLUSTER" && args[1] === "INFO") {
          return "cluster_enabled:1\r\ncluster_state:ok\r\n";
        }
        if (args[0] === "CLUSTER" && args[1] === "KEYSLOT") {
          return 1234; // every key returns the same slot
        }
        return undefined;
      });
    });

    await expect(
      validateRedisClusterTopology({
        client: client as never,
        logName: "test_module",
        sampleKeys: ["plug:{plug}:a", "plug:{plug}:b", "plug:{plug}:c"],
      }),
    ).resolves.toBeUndefined();

    const keyslotCalls = client.sendCommand.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[])[1] === "KEYSLOT",
    );
    expect(keyslotCalls).toHaveLength(3);
  });

  it("does not throw when cluster_enabled=1 but sample keys land on different slots", async () => {
    let counter = 0;
    const client = buildClient((send) => {
      send.mockImplementation(async (args: string[]) => {
        if (args[0] === "CLUSTER" && args[1] === "INFO") {
          return "cluster_enabled:1\r\ncluster_state:ok\r\n";
        }
        if (args[0] === "CLUSTER" && args[1] === "KEYSLOT") {
          counter += 1;
          return counter; // each key → distinct slot
        }
        return undefined;
      });
    });

    await expect(
      validateRedisClusterTopology({
        client: client as never,
        logName: "test_module",
        sampleKeys: ["plug:no-tag:a", "plug:no-tag:b"],
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows CLUSTER INFO unsupported errors (managed services)", async () => {
    const client = buildClient((send) => {
      send.mockRejectedValue(new Error("ERR This instance has cluster support disabled"));
    });

    await expect(
      validateRedisClusterTopology({
        client: client as never,
        logName: "test_module",
        sampleKeys: ["plug:{plug}:a", "plug:{plug}:b"],
      }),
    ).resolves.toBeUndefined();
  });

  it("returns early when fewer than 2 sample keys are provided", async () => {
    const client = buildClient((send) => {
      send.mockResolvedValue("cluster_enabled:1\r\n");
    });

    await validateRedisClusterTopology({
      client: client as never,
      logName: "test_module",
      sampleKeys: ["plug:{plug}:only-one"],
    });

    // CLUSTER INFO is called but no CLUSTER KEYSLOT.
    const keyslotCalls = client.sendCommand.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[])[1] === "KEYSLOT",
    );
    expect(keyslotCalls).toHaveLength(0);
  });

  it("does not throw when CLUSTER INFO returns a non-string", async () => {
    const client = buildClient((send) => {
      send.mockResolvedValue(12345);
    });

    await expect(
      validateRedisClusterTopology({
        client: client as never,
        logName: "test_module",
        sampleKeys: ["plug:{plug}:a", "plug:{plug}:b"],
      }),
    ).resolves.toBeUndefined();
  });
});
