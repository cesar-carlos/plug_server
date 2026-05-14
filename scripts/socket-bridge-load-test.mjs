#!/usr/bin/env node
"use strict";

/**
 * Lightweight Socket bridge load probe. It assumes a running plug_server and a
 * reachable real agent for the chosen AGENT_ID. It intentionally avoids creating
 * users or mutating server state; pass tokens through env.
 *
 * Required:
 * - HUB_URL=http://localhost:3000
 * - CONSUMER_TOKEN=<user/client access token>
 * - AGENT_ID=<registered agent id> (agents-command/relay only)
 *
 * Optional:
 * - CONSUMERS=50
 * - REQUESTS_PER_CONSUMER=20
 * - CONCURRENCY=10
 * - MODE=agents-command|relay|custom-event
 * - CUSTOM_EVENT_NAME=client:custom.load.test
 * - IDEMPOTENCY_MODE=none|unique|shared
 */

import { io } from "socket.io-client";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[socket-load] Missing ${name}`);
    process.exit(2);
  }
  return value;
};

const hubUrl = process.env.HUB_URL?.trim() || "http://localhost:3000";
const token = required("CONSUMER_TOKEN");
const consumers = Number.parseInt(process.env.CONSUMERS || "50", 10);
const requestsPerConsumer = Number.parseInt(process.env.REQUESTS_PER_CONSUMER || "20", 10);
const concurrency = Number.parseInt(process.env.CONCURRENCY || "10", 10);
const mode = ["agents-command", "relay", "custom-event"].includes(process.env.MODE)
  ? process.env.MODE
  : "agents-command";
const agentId = mode === "custom-event" ? process.env.AGENT_ID?.trim() || "" : required("AGENT_ID");
const customEventName =
  process.env.CUSTOM_EVENT_NAME?.trim() || `client:custom.load.${randomUUID()}`;
const idempotencyMode = ["none", "unique", "shared"].includes(process.env.IDEMPOTENCY_MODE)
  ? process.env.IDEMPOTENCY_MODE
  : "none";

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
};

const waitForEvent = (socket, event, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off("connect_error", onError);
    };
    const onEvent = (payload) => {
      cleanup();
      resolve(payload);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once(event, onEvent);
    socket.once("connect_error", onError);
  });

const waitForAckByRequestId = (socket, event, requestId, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event} requestId=${requestId}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off("connect_error", onError);
    };
    const onEvent = (payload) => {
      if (payload?.requestId !== requestId) return;
      cleanup();
      resolve(payload);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on(event, onEvent);
    socket.once("connect_error", onError);
  });

const connectConsumer = async () => {
  const socket = io(`${hubUrl}/consumers`, {
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
  });
  await waitForEvent(socket, "connection:ready");
  return socket;
};

const runAgentsCommand = async (socket) => {
  const requestId = randomUUID();
  const started = performance.now();
  const responsePromise = waitForEvent(socket, "agents:command_response", 30000);
  socket.emit("agents:command", {
    agentId,
    command: {
      jsonrpc: "2.0",
      id: requestId,
      method: "rpc.discover",
      params: {},
    },
    timeoutMs: 30000,
  });
  const payload = await responsePromise;
  return {
    ok: payload?.success === true,
    elapsedMs: performance.now() - started,
    code: payload?.error?.code,
  };
};

const runRelay = async (socket) => {
  const startPromise = waitForEvent(socket, "relay:conversation.started", 30000);
  socket.emit("relay:conversation.start", { agentId });
  const startedConversation = await startPromise;
  if (!startedConversation?.success) {
    return { ok: false, elapsedMs: 0, code: startedConversation?.error?.code };
  }

  const requestId = randomUUID();
  const command = {
    jsonrpc: "2.0",
    id: requestId,
    method: "rpc.discover",
    params: {},
  };
  const encoded = Buffer.from(JSON.stringify(command), "utf8");
  const frame = {
    schemaVersion: "1.0",
    enc: "json",
    cmp: "none",
    contentType: "application/json",
    originalSize: encoded.length,
    compressedSize: encoded.length,
    payload: Array.from(encoded),
    requestId,
  };
  const started = performance.now();
  const acceptedPromise = waitForEvent(socket, "relay:rpc.accepted", 30000);
  const responsePromise = waitForEvent(socket, "relay:rpc.response", 30000);
  socket.emit("relay:rpc.request", {
    conversationId: startedConversation.conversationId,
    frame,
  });
  const accepted = await acceptedPromise;
  if (!accepted?.success) {
    return { ok: false, elapsedMs: performance.now() - started, code: accepted?.error?.code };
  }
  const response = await responsePromise;
  socket.emit("relay:conversation.end", { conversationId: startedConversation.conversationId });
  return {
    ok: response !== undefined,
    elapsedMs: performance.now() - started,
    code: response?.error?.code,
  };
};

const subscribeCustomEvent = async (socket) => {
  const requestId = randomUUID();
  const ackPromise = waitForAckByRequestId(socket, "socket:event.subscribed", requestId, 10000);
  socket.emit("socket:event.subscribe", { requestId, eventName: customEventName });
  const ack = await ackPromise;
  if (!ack?.success) {
    throw new Error(`custom event subscribe failed: ${ack?.error?.code || "UNKNOWN"}`);
  }
};

const runCustomEventPublish = async (socket) => {
  const requestId = randomUUID();
  const started = performance.now();
  const responsePromise = waitForAckByRequestId(socket, "socket:event.published", requestId, 30000);
  socket.emit("socket:event.publish", {
    requestId,
    eventName: customEventName,
    payload:
      idempotencyMode === "shared"
        ? { mode: "load", shared: true }
        : {
            requestId,
            sentAt: new Date().toISOString(),
            mode: "load",
          },
    ...(idempotencyMode === "unique"
      ? { idempotencyKey: `load-${requestId}` }
      : idempotencyMode === "shared"
        ? { idempotencyKey: "load-shared-idempotency-key" }
        : {}),
  });
  const payload = await responsePromise;
  return {
    ok: payload?.success === true,
    elapsedMs: performance.now() - started,
    code: payload?.error?.code,
  };
};

const runPool = async (items, workerCount, worker) => {
  let index = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await worker(item);
      }
    }),
  );
};

const main = async () => {
  console.log(
    `[socket-load] mode=${mode} consumers=${consumers} requestsPerConsumer=${requestsPerConsumer} concurrency=${concurrency}`,
  );

  const sockets = await Promise.all(Array.from({ length: consumers }, connectConsumer));
  if (mode === "custom-event") {
    console.log(
      `[socket-load] subscribing ${sockets.length} sockets to ${customEventName} idempotency=${idempotencyMode}`,
    );
    await Promise.all(sockets.map(subscribeCustomEvent));
  }
  const jobs = sockets.flatMap((socket) => Array.from({ length: requestsPerConsumer }, () => socket));
  const latencies = [];
  const failures = new Map();

  await runPool(jobs, concurrency, async (socket) => {
    const result =
      mode === "relay"
        ? await runRelay(socket)
        : mode === "custom-event"
          ? await runCustomEventPublish(socket)
          : await runAgentsCommand(socket);
    if (result.ok) {
      latencies.push(result.elapsedMs);
    } else {
      const code = result.code || "UNKNOWN";
      failures.set(code, (failures.get(code) || 0) + 1);
    }
  });

  for (const socket of sockets) {
    socket.disconnect();
  }

  const total = jobs.length;
  const failed = Array.from(failures.values()).reduce((sum, value) => sum + value, 0);
  console.log(
    JSON.stringify(
      {
        total,
        succeeded: total - failed,
        failed,
        failures: Object.fromEntries(failures),
        ...(mode === "custom-event" ? { eventName: customEventName, idempotencyMode } : {}),
        latencyMs: {
          p50: Math.round(percentile(latencies, 50)),
          p95: Math.round(percentile(latencies, 95)),
          p99: Math.round(percentile(latencies, 99)),
          max: Math.round(Math.max(0, ...latencies)),
        },
      },
      null,
      2,
    ),
  );

  process.exit(failed === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
