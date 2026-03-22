import type { Span } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";

import { env } from "../config/env";

const tracer = trace.getTracer("plug_server.bridge_latency", "1.0.0");

export const startBridgeLatencySpan = (channel: string): Span | null => {
  if (!env.bridgeLatencyTraceOtelEnabled) {
    return null;
  }
  return tracer.startSpan("bridge.command", {
    attributes: { "bridge.channel": channel },
  });
};

export const endBridgeLatencySpan = (
  span: Span | null,
  outcome: string,
  attrs?: Record<string, string | number>,
): void => {
  if (!span) {
    return;
  }
  span.setAttribute("bridge.outcome", outcome);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      span.setAttribute(`bridge.${k}`, v);
    }
  }
  span.end();
};

export const bridgeLatencySpanAddEvent = (span: Span | null, name: string): void => {
  if (!span) {
    return;
  }
  span.addEvent(name);
};
