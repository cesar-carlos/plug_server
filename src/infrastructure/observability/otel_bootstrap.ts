import type { NodeSDK } from "@opentelemetry/sdk-node";
import type * as AutoInstrumentationsNode from "@opentelemetry/auto-instrumentations-node";
import type * as ExporterTraceOtlpHttp from "@opentelemetry/exporter-trace-otlp-http";
import type * as Resources from "@opentelemetry/resources";
import type * as SdkNode from "@opentelemetry/sdk-node";
import type * as SdkTraceBase from "@opentelemetry/sdk-trace-base";
import type * as SemanticConventions from "@opentelemetry/semantic-conventions";

import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

let sdkInstance: NodeSDK | undefined;

/**
 * Initializes the OpenTelemetry NodeSDK with auto-instrumentation for HTTP,
 * Express, and Prisma. The SDK is constructed and started **only** when
 * `OTEL_TRACES_ENABLED=true`; otherwise this is a no-op (and the heavy
 * `@opentelemetry/sdk-node` module never reaches the require cache).
 *
 * Tail-based sampling stays out of scope; the SDK applies a parent-based
 * trace ratio sampler so most requests are dropped at root span creation,
 * keeping the local hot path cheap.
 *
 * Must be called **before** importing any module that performs work we want
 * traced (e.g. `createApp`). The `server.ts` bootstrap respects this ordering.
 */
export const initOpenTelemetry = async (): Promise<void> => {
  if (!env.otelTracesEnabled) {
    return;
  }
  if (sdkInstance !== undefined) {
    return;
  }

  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { NodeSDK } = require("@opentelemetry/sdk-node") as typeof SdkNode;
    const { getNodeAutoInstrumentations } =
      require("@opentelemetry/auto-instrumentations-node") as typeof AutoInstrumentationsNode;
    const { OTLPTraceExporter } =
      require("@opentelemetry/exporter-trace-otlp-http") as typeof ExporterTraceOtlpHttp;
    const { ParentBasedSampler, TraceIdRatioBasedSampler } =
      require("@opentelemetry/sdk-trace-base") as typeof SdkTraceBase;
    const { resourceFromAttributes } =
      require("@opentelemetry/resources") as typeof Resources;
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
      require("@opentelemetry/semantic-conventions") as typeof SemanticConventions;
    const pkg = require("../../../package.json") as { version?: string };
    /* eslint-enable @typescript-eslint/no-require-imports */

    sdkInstance = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: env.otelServiceName,
        [ATTR_SERVICE_VERSION]: pkg.version ?? "0.0.0",
      }),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(env.otelTracesSamplerArg),
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${env.otelExporterOtlpEndpoint.replace(/\/+$/, "")}/v1/traces`,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          /**
           * Disable filesystem instrumentation: extremely noisy in Node apps
           * because every `fs.readFile` becomes a span. The HTTP, Express,
           * Prisma, redis and ioredis instrumentations stay enabled and cover
           * the request → controller → DB / cache path we care about.
           */
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });
    sdkInstance.start();
    logger.info("otel_tracing_enabled", {
      endpoint: env.otelExporterOtlpEndpoint,
      sampler: env.otelTracesSamplerArg,
      serviceName: env.otelServiceName,
    });
  } catch (error: unknown) {
    logger.error("otel_tracing_init_failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    sdkInstance = undefined;
  }
};

/**
 * Flushes pending spans during graceful shutdown so in-flight traces are not
 * lost when the process exits.
 */
export const shutdownOpenTelemetry = async (): Promise<void> => {
  if (sdkInstance === undefined) {
    return;
  }
  try {
    await sdkInstance.shutdown();
  } catch (error: unknown) {
    logger.warn("otel_tracing_shutdown_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  sdkInstance = undefined;
};
