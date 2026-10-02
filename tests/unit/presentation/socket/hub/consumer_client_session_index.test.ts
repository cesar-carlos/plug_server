import { describe, expect, it } from "vitest";
import { ConsumerClientSessionIndex } from "../../../../../src/presentation/socket/hub/registries/consumer_client_session_index";

describe("consumer client session index", () => {
  it("caches ordered membership across session changes and invalidates only client changes", () => {
    const index = new ConsumerClientSessionIndex();
    index.register("s-b", "b");
    index.register("s-a", "a");
    const clients = index.getSortedClientIds();
    expect(clients).toEqual(["a", "b"]);
    index.register("s-a2", "a");
    expect(index.getSortedClientIds()).toBe(clients);
    expect([...index.getSocketIds("a")]).toEqual(["s-a", "s-a2"]);
    index.remove("s-a");
    expect(index.getSortedClientIds()).toBe(clients);
    index.remove("s-a2");
    expect(index.getSortedClientIds()).toEqual(["b"]);
    index.register("s-b", "c");
    expect(index.getSortedClientIds()).toEqual(["c"]);
    expect([...index.getSocketIds("b")]).toEqual([]);
    index.clear();
    expect(index.getSortedClientIds()).toEqual([]);
  });

  it("isolates hubs even when their socket and client IDs coincide", () => {
    const first = new ConsumerClientSessionIndex();
    const second = new ConsumerClientSessionIndex();
    first.register("same", "client");
    second.register("same", "client");
    first.clear();
    expect(second.getSortedClientIds()).toEqual(["client"]);
  });
});
