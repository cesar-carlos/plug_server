export const restBenchConditionalRequest = (etag: string): RequestInit => ({
  // Native fetch otherwise adds Cache-Control: no-cache for a conditional request,
  // which correctly makes Express return 200 instead of the 304 this scenario measures.
  cache: "no-cache",
  headers: { "If-None-Match": etag },
});
import { request } from "node:http";

/** Keep the load generator independent of fetch's Windows loopback scheduling. */
export const restBenchRequest = (
  url: string,
  init: RequestInit,
): Promise<{ status: number; data: unknown; etag: string | null }> =>
  new Promise((resolve, reject) => {
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      reject(new Error("REST benchmark requires a string request body"));
      return;
    }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          try {
            const status = response.statusCode ?? 0;
            resolve({
              status,
              data: status === 304 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")),
              etag: response.headers.etag ?? null,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once("error", reject);
    req.end(init.body ?? undefined);
  });
