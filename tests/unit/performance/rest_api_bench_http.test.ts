import { createServer } from "node:http";
import express from "express";
import { expect, it } from "vitest";
import {
  restBenchConditionalRequest,
  restBenchRequest,
} from "../../performance/rest_api_bench_http";
import { sendJsonWithWeakETag } from "../../../src/presentation/http/helpers/weak_etag";

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
