import type { Server } from "socket.io";
import { describe, expect, it } from "vitest";
import { getSocketMetricsSnapshot } from "../../src/socket_metrics_snapshot";
import { createSocketServerState, socketServerStates } from "../../src/socket_state";

describe("consumer preparation hub metrics", () => {
  it("aggregates gauges across hubs without exposing socket IDs or payloads", async () => {
    const firstHub = {} as Server;
    const secondHub = {} as Server;
    const first = createSocketServerState(
      firstHub,
      {} as ReturnType<Server["of"]>,
      {} as ReturnType<Server["of"]>,
    );
    const second = createSocketServerState(
      secondHub,
      {} as ReturnType<Server["of"]>,
      {} as ReturnType<Server["of"]>,
    );
    socketServerStates.set(firstHub, first);
    socketServerStates.set(secondHub, second);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const jobs = Array.from({ length: 5 }, () =>
      first.consumerPreparation.run("private-socket", { payload: Buffer.alloc(10) }, () => gate),
    );
    jobs.push(second.consumerPreparation.run("other-private-socket", null, () => gate));
    try {
      const metrics = getSocketMetricsSnapshot().consumerPreparation;
      expect(metrics).toMatchObject({ active: 5, waiting: 1, waitingBytes: 10 });
      expect(JSON.stringify(metrics)).not.toContain("private-socket");
      first.consumerPreparation.cancelSocket("private-socket");
      expect(getSocketMetricsSnapshot().consumerPreparation).toMatchObject({
        active: 5,
        waiting: 0,
        waitingBytes: 0,
      });
      finish();
      await Promise.all(jobs);
      expect(getSocketMetricsSnapshot().consumerPreparation).toMatchObject({
        active: 0,
        waiting: 0,
        waitingBytes: 0,
      });
    } finally {
      finish();
      await Promise.all(jobs);
      socketServerStates.delete(firstHub);
      socketServerStates.delete(secondHub);
    }
  });
});
