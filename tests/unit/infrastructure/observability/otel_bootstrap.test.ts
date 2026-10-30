import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as OtelApi from "@opentelemetry/api";
import type * as OtelSdk from "@opentelemetry/sdk-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    config.otelTracesEnabled = false;
    config.otelTracesSamplerArg = 1;
    config.otelExporterOtlpEndpoint = "http://127.0.0.1:1";
    vi.stubEnv("OTEL_NODE_RESOURCE_DETECTORS", "none");
    vi.stubEnv("OTEL_LOGS_EXPORTER", "none");
    vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TIMEOUT", "100");
  });
  afterEach(async () => {
    await shutdownOpenTelemetry();
    const api = requireFromTest("@opentelemetry/api") as typeof OtelApi;
    api.trace.disable();
    api.context.disable();
    api.propagation.disable();
    api.diag.disable();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("can initialize again after an SDK startup failure", async () => {
    const { NodeSDK } = requireFromTest("@opentelemetry/sdk-node") as typeof OtelSdk;
    const start = vi.spyOn(NodeSDK.prototype, "start").mockImplementationOnce(() => {
      throw new Error("startup unavailable");
    });
    config.otelTracesEnabled = true;
    await initOpenTelemetry();
    expect(log.error).toHaveBeenCalledWith(
      "otel_tracing_init_failed",
      expect.objectContaining({ message: "startup unavailable" }),
    );
    await initOpenTelemetry();
    expect(start).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledOnce();
    // This first enabled test also performs the cold load of all auto-instrumentations.
  }, 30_000);

  it("clears the SDK after a failed shutdown and allows later initialization", async () => {
    const { NodeSDK } = requireFromTest("@opentelemetry/sdk-node") as typeof OtelSdk;
    const originalShutdown = NodeSDK.prototype.shutdown;
    vi.spyOn(NodeSDK.prototype, "shutdown").mockImplementationOnce(async function (
      this: OtelSdk.NodeSDK,
    ) {
      await originalShutdown.call(this);
      throw new Error("shutdown unavailable");
    });
    config.otelTracesEnabled = true;
    await initOpenTelemetry();
    await shutdownOpenTelemetry();
    expect(log.warn).toHaveBeenCalledWith("otel_tracing_shutdown_failed", {
      message: "shutdown unavailable",
    });
    await shutdownOpenTelemetry();
    expect(log.warn).toHaveBeenCalledOnce();
    await initOpenTelemetry();
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it("drops root spans at zero sampling and preserves a sampled remote parent", async () => {
    config.otelTracesEnabled = true;
    config.otelTracesSamplerArg = 0;
    await initOpenTelemetry();
    const api = requireFromTest("@opentelemetry/api") as typeof OtelApi;
    const tracer = api.trace.getTracer("sampling-regression");
    const root = tracer.startSpan("unsampled-root");
    expect(root.isRecording()).toBe(false);
    root.end();
    const parent = api.trace.setSpanContext(api.ROOT_CONTEXT, {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: api.TraceFlags.SAMPLED,
      isRemote: true,
    });
    const child = tracer.startSpan("sampled-child", {}, parent);
    expect(child.isRecording()).toBe(true);
    child.end();
  });

  it("reports an unreachable collector without rejecting graceful shutdown", async () => {
    const api = requireFromTest("@opentelemetry/api") as typeof OtelApi;
    const diagnostic = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    };
    api.diag.setLogger(diagnostic, api.DiagLogLevel.ERROR);
    config.otelTracesEnabled = true;
    await initOpenTelemetry();
    api.trace.getTracer("collector-regression").startSpan("failed-export").end();
    await expect(shutdownOpenTelemetry()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "otel_tracing_shutdown_failed",
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it("does not load the SDK when tracing is disabled", async () => {
    const sdkPath = requireFromTest.resolve("@opentelemetry/sdk-node");
    const cachedSdk = requireFromTest.cache[sdkPath];
    await initOpenTelemetry();
    expect(requireFromTest.cache[sdkPath]).toBe(cachedSdk);
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
