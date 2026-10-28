import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as OtelApi from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireFromTest = createRequire(resolve("package.json"));
const config = vi.hoisted(() => ({
  otelTracesEnabled: false,
  otelServiceName: "otel-bootstrap-test",
  otelTracesSamplerArg: 1,
  otelExporterOtlpEndpoint: "",
}));
const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock("../../../../src/shared/config/env", () => ({ env: config }));
vi.mock("../../../../src/shared/utils/logger", () => ({ logger: log }));

import {
  initOpenTelemetry,
  shutdownOpenTelemetry,
} from "../../../../src/infrastructure/observability/otel_bootstrap";

describe("OpenTelemetry bootstrap", () => {
  afterEach(async () => {
    await shutdownOpenTelemetry();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("does not load the SDK when tracing is disabled", async () => {
    await initOpenTelemetry();
    expect(
      requireFromTest.cache[requireFromTest.resolve("@opentelemetry/sdk-node")],
    ).toBeUndefined();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("exports and flushes a sampled span using SDK 3 without loading the incompatible SDK 2", async () => {
    vi.stubEnv("OTEL_NODE_RESOURCE_DETECTORS", "none");
    vi.stubEnv("OTEL_LOGS_EXPORTER", "none");
    vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
    const requests: { url: string | undefined; body: string }[] = [];
    const collector = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ url: request.url, body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    try {
      const address = collector.address();
      if (!address || typeof address === "string") throw new Error("Missing collector port");
      config.otelExporterOtlpEndpoint = `http://127.0.0.1:${address.port}/`;
      config.otelTracesEnabled = true;
      await initOpenTelemetry();
      await initOpenTelemetry();
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledOnce();
      const { trace } = requireFromTest("@opentelemetry/api") as typeof OtelApi;
      const span = trace.getTracer("bootstrap-regression").startSpan("sdk3-export");
      expect(span.isRecording()).toBe(true);
      span.end();
      await shutdownOpenTelemetry();
      expect(log.warn).not.toHaveBeenCalled();
      expect(
        requests.some(({ url, body }) => url === "/v1/traces" && body.includes("sdk3-export")),
      ).toBe(true);
      expect(Object.keys(requireFromTest.cache).some((path) => /sdk-trace-base/.test(path))).toBe(
        false,
      );
    } finally {
      config.otelTracesEnabled = false;
      await shutdownOpenTelemetry();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);
});
