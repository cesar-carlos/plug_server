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
 * - MODE=rest|agents-command|relay|custom-event
 * - RPC_METHOD=rpc.discover|sql.execute|sql.executeBatch|sql.bulkInsert
 * - PREFER_DB_STREAMING=true|false
 * - BATCH_PARALLELISM=1|2|4|8
 * - BULK_INSERT_TABLE=<table> BULK_INSERT_ROW_COUNT=1000
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
const mode = ["rest", "agents-command", "relay", "custom-event"].includes(process.env.MODE)
  ? process.env.MODE
  : "agents-command";
const agentId = mode === "custom-event" ? process.env.AGENT_ID?.trim() || "" : required("AGENT_ID");
const rpcMethod = [
  "rpc.discover",
  "sql.execute",
  "sql.executeBatch",
  "sql.bulkInsert",
].includes(process.env.RPC_METHOD)
  ? process.env.RPC_METHOD
  : "rpc.discover";
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

const parseBool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const parseJsonEnv = (name, fallback) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
};

const maybeClientToken = () => {
  const value = process.env.AGENT_CLIENT_TOKEN?.trim();
  return value ? { client_token: value } : {};
};

const buildBulkInsertRows = (columns, rowCount) =>
  Array.from({ length: rowCount }, (_, index) =>
    columns.map((column) => {
      if (column.type === "i32" || column.type === "i64") return index + 1;
      if (column.type === "decimal") return `${index + 1}.00`;
      if (column.type === "timestamp") return new Date(1_700_000_000_000 + index).toISOString();
      if (column.type === "binary") return Buffer.from(`row-${index + 1}`).toString("base64");
      return `load-row-${index + 1}`;
    }),
  );

const buildBridgeCommand = () => {
  const id = randomUUID();
  if (rpcMethod === "sql.execute") {
    const options = {
      ...(parseBool(process.env.PREFER_DB_STREAMING)
        ? { prefer_db_streaming: true }
        : {}),
      ...(process.env.SQL_MAX_ROWS ? { max_rows: Number.parseInt(process.env.SQL_MAX_ROWS, 10) } : {}),
      ...(process.env.SQL_PAGE && process.env.SQL_PAGE_SIZE
        ? {
            page: Number.parseInt(process.env.SQL_PAGE, 10),
            page_size: Number.parseInt(process.env.SQL_PAGE_SIZE, 10),
          }
        : {}),
    };
    return {
      requestId: id,
      command: {
        jsonrpc: "2.0",
        id,
        api_version: "2.10",
        method: "sql.execute",
        params: {
          sql: process.env.SQL_TEXT || "SELECT 1",
          ...maybeClientToken(),
          ...(Object.keys(options).length > 0 ? { options } : {}),
        },
      },
    };
  }

  if (rpcMethod === "sql.executeBatch") {
    const batchItems = Number.parseInt(process.env.BATCH_ITEMS || "4", 10);
    const options = {
      ...(process.env.BATCH_PARALLELISM
        ? {
            max_parallel_read_only_batch_items: Number.parseInt(
              process.env.BATCH_PARALLELISM,
              10,
            ),
          }
        : {}),
      ...(process.env.SQL_MAX_ROWS ? { max_rows: Number.parseInt(process.env.SQL_MAX_ROWS, 10) } : {}),
    };
    return {
      requestId: id,
      command: {
        jsonrpc: "2.0",
        id,
        api_version: "2.10",
        method: "sql.executeBatch",
        params: {
          commands: Array.from({ length: batchItems }, (_, index) => ({
            sql: process.env.BATCH_SQL_TEXT || "SELECT 1",
            execution_order: index,
          })),
          ...maybeClientToken(),
          ...(Object.keys(options).length > 0 ? { options } : {}),
        },
      },
    };
  }

  if (rpcMethod === "sql.bulkInsert") {
    const table = process.env.BULK_INSERT_TABLE?.trim();
    if (!table) {
      throw new Error("BULK_INSERT_TABLE is required when RPC_METHOD=sql.bulkInsert");
    }
    const columns = parseJsonEnv("BULK_INSERT_COLUMNS_JSON", [
      { name: "id", type: "i64" },
      { name: "payload", type: "text" },
    ]);
    const rowCount = Number.parseInt(process.env.BULK_INSERT_ROW_COUNT || "1000", 10);
    return {
      requestId: id,
      command: {
        jsonrpc: "2.0",
        id,
        api_version: "2.10",
        method: "sql.bulkInsert",
        params: {
          table,
          columns,
          rows: buildBulkInsertRows(columns, rowCount),
          ...maybeClientToken(),
        },
      },
    };
  }

  return {
    requestId: id,
    command: {
      jsonrpc: "2.0",
      id,
      api_version: "2.10",
      method: "rpc.discover",
      params: {},
    },
  };
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
  const { command } = buildBridgeCommand();
  const started = performance.now();
  const responsePromise = waitForEvent(socket, "agents:command_response", 30000);
  socket.emit("agents:command", {
    agentId,
    command,
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

  const { requestId, command } = buildBridgeCommand();
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

const runRestBridge = async () => {
  const { command } = buildBridgeCommand();
  const started = performance.now();
  const response = await fetch(`${hubUrl}/api/v1/agents/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agentId,
      command,
      timeoutMs: 30000,
    }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return {
    ok: response.ok,
    elapsedMs: performance.now() - started,
    code: payload?.code || payload?.response?.item?.error?.data?.code || response.status,
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
    `[socket-load] mode=${mode} rpcMethod=${rpcMethod} consumers=${consumers} requestsPerConsumer=${requestsPerConsumer} concurrency=${concurrency}`,
  );

  const sockets =
    mode === "rest" ? [] : await Promise.all(Array.from({ length: consumers }, connectConsumer));
  if (mode === "custom-event") {
    console.log(
      `[socket-load] subscribing ${sockets.length} sockets to ${customEventName} idempotency=${idempotencyMode}`,
    );
    await Promise.all(sockets.map(subscribeCustomEvent));
  }
  const jobs =
    mode === "rest"
      ? Array.from({ length: consumers * requestsPerConsumer }, () => null)
      : sockets.flatMap((socket) => Array.from({ length: requestsPerConsumer }, () => socket));
  const latencies = [];
  const failures = new Map();

  await runPool(jobs, concurrency, async (socket) => {
    const result =
      mode === "rest"
        ? await runRestBridge()
        : mode === "relay"
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
