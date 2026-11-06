import { createServer } from "node:http";
import { instance } from "gcp-metadata";
import { expect, it, vi } from "vitest";

it("should preserve GCP metadata requests with the patched gaxios dependency", async () => {
  const requests: Array<{ url: string | undefined; flavor: string | string[] | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, flavor: request.headers["metadata-flavor"] });
    response.writeHead(200, { "metadata-flavor": "Google", "content-type": "application/json" });
    response.end(JSON.stringify({ id: "isolated-instance" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    vi.stubEnv("GCE_METADATA_HOST", `127.0.0.1:${address.port}`);
    vi.stubEnv("GCE_METADATA_IP", "");
    expect(await instance<{ id: string }>("id")).toEqual({ id: "isolated-instance" });
    expect(requests).toEqual([{ url: "/computeMetadata/v1/instance/id", flavor: "Google" }]);
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
