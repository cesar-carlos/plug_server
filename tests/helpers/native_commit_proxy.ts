import { createServer, connect, type Socket } from "node:net";

/** Private loopback fixture: holds native commit confirmation in transit. */
export async function createNativeCommitProxy(targetPort: number): Promise<{
  port: number;
  arm: () => void;
  waitForCommitTraffic: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let armed = false;
  let requestSeen = false;
  let responseSeen = false;
  let closed = false;
  let resolveTraffic: (() => void) | undefined;
  let rejectTraffic: ((error: Error) => void) | undefined;
  const traffic = new Promise<void>((resolve, reject) => {
    resolveTraffic = resolve;
    rejectTraffic = reject;
  });
  // Attach a handler immediately, even if the controller has not armed yet.
  void traffic.catch(() => undefined);
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", (error) => {
        rejectTraffic?.(error);
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (bytes: Buffer) => {
      if (armed) requestSeen = true;
      if (!upstream.write(bytes)) client.pause();
    });
    upstream.on("drain", () => client.resume());
    upstream.on("data", (bytes: Buffer) => {
      if (armed) {
        responseSeen = true;
        upstream.pause();
        if (requestSeen && responseSeen) resolveTraffic?.();
        return; // Deliberately do not deliver the native confirmation.
      }
      if (!client.write(bytes)) upstream.pause();
    });
    client.on("drain", () => {
      if (!armed) upstream.resume();
    });
    client.once("end", () => upstream.end());
    upstream.once("end", () => client.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Private ODBC proxy unavailable");
  return {
    port: address.port,
    arm: (): void => {
      armed = true;
    },
    waitForCommitTraffic: (): Promise<void> => traffic,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
