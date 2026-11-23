import { createServer } from "node:http";
import { createHook } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import express from "express";
import { expect, it } from "vitest";
import {
  restBenchConditionalRequest,
  restBenchRequest,
} from "../../performance/rest_api_bench_http";
import { sendJsonWithWeakETag } from "../../../src/presentation/http/helpers/weak_etag";

it("releases request deadlines after completed HTTP responses instead of accumulating timers", async () => {
  const pending = new Set<number>();
  let allocated = 0;
  const hook = createHook({
    init(id, type, _trigger, resource: object) {
      if (type === "Timeout" && Reflect.get(resource, "_idleTimeout") === 30000) {
        allocated++;
        pending.add(id);
      }
    },
    destroy(id) {
      pending.delete(id);
    },
  });
  const server = createServer((request, response) =>
    response.end(request.url === "/invalid" ? "invalid-json" : '{"ok":true}'),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hook.enable();
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    for (let index = 0; index < 32; index++) {
      await restBenchRequest(`http://127.0.0.1:${address.port}`, {});
    }
    await nextTurn();
    await nextTurn();
    await expect(
      restBenchRequest(`http://127.0.0.1:${address.port}/invalid`, {}),
    ).rejects.toThrow();
    await expect(
      restBenchRequest(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    await nextTurn();
    await nextTurn();
    expect(allocated).toBe(34);
    expect(pending.size).toBe(0);
  } finally {
    hook.disable();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("aborts a stalled HTTP response at its deadline and closes its socket", async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"incomplete":');
  });
  server.on("connection", (socket) => socket.once("close", closed));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    await expect(restBenchRequest(`http://127.0.0.1:${address.port}`, {}, 100)).rejects.toThrow();
    await disconnected;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("preserves JSON, ETag and conditional 304 responses in the load generator", async () => {
  const app = express();
  app.set("etag", false);
  app.get("/catalog", (request, response) => {
    sendJsonWithWeakETag(request, response, { agents: [] });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const url = `http://127.0.0.1:${address.port}/catalog`;
    const initial = await restBenchRequest(url, {});
    const etag = initial.etag;
    expect(initial.status).toBe(200);
    expect(initial.data).toEqual({ agents: [] });
    if (!etag) throw new Error("Missing response validator");
    const conditional = await restBenchRequest(url, restBenchConditionalRequest(etag));
    expect(conditional.status).toBe(304);
    expect(conditional.data).toBeNull();
    expect(conditional.etag).toBe(etag);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("preserves POST headers and body and rejects invalid JSON or aborted requests", async () => {
  const app = express();
  app.use(express.json());
  app.post("/echo", (request, response) => {
    response.status(202).json({ body: request.body, auth: request.headers.authorization });
  });
  app.get("/invalid", (_request, response) => response.end("invalid-json"));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const url = `http://127.0.0.1:${address.port}`;
    await expect(
      restBenchRequest(`${url}/echo`, {
        method: "POST",
        headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      }),
    ).resolves.toEqual({
      status: 202,
      data: { body: { value: 1 }, auth: "Bearer fixture" },
      etag: expect.any(String),
    });
    await expect(restBenchRequest(`${url}/invalid`, {})).rejects.toThrow();
    await expect(
      restBenchRequest(`${url}/echo`, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
