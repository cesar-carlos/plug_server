import { createServer } from "node:http";
import express from "express";
import { expect, it } from "vitest";
import { restBenchConditionalRequest } from "../../performance/rest_api_bench_http";
import { sendJsonWithWeakETag } from "../../../src/presentation/http/helpers/weak_etag";

it("should measure a 304 with native fetch instead of forcing a no-cache 200", async () => {
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
    const initial = await fetch(url);
    const etag = initial.headers.get("etag");
    expect(initial.status).toBe(200);
    await initial.json();
    if (!etag) throw new Error("Missing response validator");
    const conditional = await fetch(url, restBenchConditionalRequest(etag));
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
