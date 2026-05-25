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
 * - MODE=rest|agents-command|relay|relay-stream|custom-event
 * - RPC_METHOD=rpc.discover|sql.execute|sql.executeBatch|sql.bulkInsert
 * - PREFER_DB_STREAMING=true|false
 * - STREAM_PULL_WINDOW=256
 * - STREAM_MAX_PULLS=1000
 * - STREAM_EXPECT_ROWS=<optional exact row count>
 * - BATCH_PARALLELISM=1|2|4|8
 * - BULK_INSERT_TABLE=<table> BULK_INSERT_ROW_COUNT=1000
 * - CUSTOM_EVENT_NAME=client:custom.load.test
 * - IDEMPOTENCY_MODE=none|unique|shared
 */

import { io } from "socket.io-client";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";

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
const mode = ["rest", "agents-command", "relay", "relay-stream", "custom-event"].includes(
  process.env.MODE,
)
  ? process.env.MODE
  : "agents-command";
const agentId = mode === "custom-event" ? process.env.AGENT_ID?.trim() || "" : required("AGENT_ID");
const rpcMethod = ["rpc.discover", "sql.execute", "sql.executeBatch", "sql.bulkInsert"].includes(
  process.env.RPC_METHOD,
)
  ? process.env.RPC_METHOD
  : "rpc.discover";
const customEventName =
  process.env.CUSTOM_EVENT_NAME?.trim() || `client:custom.load.${randomUUID()}`;
const idempotencyMode = ["none", "unique", "shared"].includes(process.env.IDEMPOTENCY_MODE)
  ? process.env.IDEMPOTENCY_MODE
  : "none";
const streamPullWindow = Number.parseInt(process.env.STREAM_PULL_WINDOW || "256", 10);
const streamMaxPulls = Number.parseInt(process.env.STREAM_MAX_PULLS || "1000", 10);
const streamExpectRowsRaw = process.env.STREAM_EXPECT_ROWS?.trim();
const streamExpectRows = streamExpectRowsRaw ? Number.parseInt(streamExpectRowsRaw, 10) : undefined;

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

const encodePayloadFrame = (data, requestId) => {
  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  return {
    schemaVersion: "1.0",
    enc: "json",
    cmp: "none",
    contentType: "application/json",
    originalSize: encoded.length,
    compressedSize: encoded.length,
    payload: Array.from(encoded),
    requestId,
  };
};

const toPayloadBuffer = (payload) => {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (Array.isArray(payload)) return Buffer.from(payload);
  if (typeof payload === "string") return Buffer.from(payload, "base64");
  if (
    payload &&
    typeof payload === "object" &&
    payload.type === "Buffer" &&
    Array.isArray(payload.data)
  ) {
    return Buffer.from(payload.data);
  }
  throw new Error("PayloadFrame payload is not binary-like");
};

const decodePayloadFrameData = (frame) => {
  if (!frame || typeof frame !== "object") {
    throw new Error("PayloadFrame envelope must be an object");
  }
  const binaryPayload = toPayloadBuffer(frame.payload);
  const decodedBytes =
    frame.cmp === "gzip" ? gunzipSync(binaryPayload) : Buffer.from(binaryPayload);
  return {
    data: JSON.parse(decodedBytes.toString("utf8")),
    originalSize:
      Number.isInteger(frame.originalSize) && frame.originalSize >= 0
        ? frame.originalSize
        : decodedBytes.length,
    compressedSize:
      Number.isInteger(frame.compressedSize) && frame.compressedSize >= 0
        ? frame.compressedSize
        : binaryPayload.length,
    compression: frame.cmp === "gzip" ? "gzip" : "none",
  };
};

const pickString = (value) => (typeof value === "string" && value.length > 0 ? value : undefined);

const extractStreamId = (payload) => {
  if (!payload || typeof payload !== "object") return undefined;
  const result = payload.result && typeof payload.result === "object" ? payload.result : undefined;
  return (
    pickString(result?.stream_id) ||
    pickString(result?.streamId) ||
    pickString(payload.stream_id) ||
    pickString(payload.streamId)
  );
};

const extractJsonRpcId = (payload) => {
  if (!payload || typeof payload !== "object") return undefined;
  return typeof payload.id === "string" ? payload.id : undefined;
};

const countChunkRows = (payload) => {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.rows)) return 0;
  return payload.rows.length;
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
      ...(parseBool(process.env.PREFER_DB_STREAMING) ? { prefer_db_streaming: true } : {}),
      ...(process.env.SQL_MAX_ROWS
        ? { max_rows: Number.parseInt(process.env.SQL_MAX_ROWS, 10) }
        : {}),
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
            max_parallel_read_only_batch_items: Number.parseInt(process.env.BATCH_PARALLELISM, 10),
          }
        : {}),
      ...(process.env.SQL_MAX_ROWS
        ? { max_rows: Number.parseInt(process.env.SQL_MAX_ROWS, 10) }
        : {}),
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

const waitForRelayAcceptedByClientRequestId = (socket, clientRequestId, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`timeout waiting for relay:rpc.accepted clientRequestId=${clientRequestId}`),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("relay:rpc.accepted", onEvent);
      socket.off("connect_error", onError);
    };
    const onEvent = (payload) => {
      if (payload?.success === true && payload.clientRequestId !== clientRequestId) return;
      cleanup();
      resolve(payload);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on("relay:rpc.accepted", onEvent);
    socket.once("connect_error", onError);
  });

const waitForStreamProgress = (state, previousChunks, expectedWindow, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    let quietTimer;
    const finish = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for relay stream progress"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
      state.progressListeners.delete(onProgress);
    };
    const onProgress = () => {
      if (state.complete || state.chunks >= previousChunks + expectedWindow) {
        finish();
        return;
      }
      if (state.chunks > previousChunks) {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 50);
      }
    };
    state.progressListeners.add(onProgress);
    onProgress();
  });

const createDecodedPayloadFrameCollector = (socket, event) => {
  const frames = [];
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const onEvent = (rawPayload) => {
    try {
      const decoded = decodePayloadFrameData(rawPayload);
      frames.push({ decoded, payload: decoded.data });
      notify();
    } catch {
      // Ignore malformed frames in the load probe and let timeouts/failures surface.
    }
  };
  socket.on(event, onEvent);
  return {
    waitFor(predicate, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const findMatch = () => frames.find(predicate);
        const existing = findMatch();
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timeout waiting for ${event}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(check);
        };
        const check = () => {
          const match = findMatch();
          if (!match) return;
          cleanup();
          resolve(match);
        };
        listeners.add(check);
      });
    },
    close() {
      socket.off(event, onEvent);
      listeners.clear();
    },
  };
};

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
  const frame = encodePayloadFrame(command, requestId);
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

const runRelayStream = async (socket) => {
  if (!Number.isInteger(streamPullWindow) || streamPullWindow <= 0) {
    throw new Error("STREAM_PULL_WINDOW must be a positive integer");
  }
  if (!Number.isInteger(streamMaxPulls) || streamMaxPulls <= 0) {
    throw new Error("STREAM_MAX_PULLS must be a positive integer");
  }
  if (
    streamExpectRows !== undefined &&
    (!Number.isInteger(streamExpectRows) || streamExpectRows < 0)
  ) {
    throw new Error("STREAM_EXPECT_ROWS must be a non-negative integer when provided");
  }

  const startPromise = waitForEvent(socket, "relay:conversation.started", 30000);
  socket.emit("relay:conversation.start", { agentId });
  const startedConversation = await startPromise;
  if (!startedConversation?.success) {
    return { ok: false, elapsedMs: 0, code: startedConversation?.error?.code };
  }

  const { requestId: clientRequestId, command } = buildBridgeCommand();
  const state = {
    requestId: undefined,
    streamId: undefined,
    chunks: 0,
    rows: 0,
    bytesReceived: 0,
    compressedBytesReceived: 0,
    pullsSent: 0,
    complete: false,
    totalRows: undefined,
    chunkIntervalsMs: [],
    lastChunkAt: undefined,
    progressListeners: new Set(),
  };
  const notifyProgress = () => {
    for (const listener of state.progressListeners) {
      listener();
    }
  };
  const recordFrameBytes = (decoded) => {
    state.bytesReceived += decoded.originalSize;
    state.compressedBytesReceived += decoded.compressedSize;
  };
  const onChunk = (rawPayload) => {
    let decoded;
    try {
      decoded = decodePayloadFrameData(rawPayload);
    } catch {
      return;
    }
    const payload = decoded.data;
    if (!payload || typeof payload !== "object") return;
    if (!state.requestId || !state.streamId) return;
    if (payload.request_id !== state.requestId) return;
    if (payload.stream_id !== state.streamId) return;

    const now = performance.now();
    if (state.lastChunkAt !== undefined) {
      state.chunkIntervalsMs.push(now - state.lastChunkAt);
    }
    state.lastChunkAt = now;
    state.chunks += 1;
    state.rows += countChunkRows(payload);
    recordFrameBytes(decoded);
    notifyProgress();
  };
  const onComplete = (rawPayload) => {
    let decoded;
    try {
      decoded = decodePayloadFrameData(rawPayload);
    } catch {
      return;
    }
    const payload = decoded.data;
    if (!payload || typeof payload !== "object") return;
    if (!state.requestId || !state.streamId) return;
    if (payload.request_id !== state.requestId) return;
    if (payload.stream_id !== state.streamId) return;

    state.complete = true;
    if (Number.isFinite(payload.total_rows)) {
      state.totalRows = payload.total_rows;
    }
    recordFrameBytes(decoded);
    notifyProgress();
  };

  socket.on("relay:rpc.chunk", onChunk);
  socket.on("relay:rpc.complete", onComplete);

  const started = performance.now();
  const responseCollector = createDecodedPayloadFrameCollector(socket, "relay:rpc.response");
  try {
    const acceptedPromise = waitForRelayAcceptedByClientRequestId(socket, clientRequestId, 30000);
    socket.emit("relay:rpc.request", {
      conversationId: startedConversation.conversationId,
      frame: encodePayloadFrame(command, clientRequestId),
    });
    const accepted = await acceptedPromise;
    if (!accepted?.success) {
      return {
        ok: false,
        elapsedMs: performance.now() - started,
        code: accepted?.error?.code,
      };
    }

    state.requestId = accepted.requestId;
    const response = await responseCollector.waitFor(
      ({ payload }) => extractJsonRpcId(payload) === state.requestId,
      30000,
    );

    recordFrameBytes(response.decoded);
    if (response.payload?.error) {
      return {
        ok: false,
        elapsedMs: performance.now() - started,
        code: response.payload.error?.data?.code || response.payload.error?.code,
        stream: {
          chunks: state.chunks,
          rows: state.rows,
          bytesReceived: state.bytesReceived,
          compressedBytesReceived: state.compressedBytesReceived,
          pullsSent: state.pullsSent,
          chunkIntervalsMs: state.chunkIntervalsMs,
        },
      };
    }

    state.streamId = extractStreamId(response.payload);
    if (!state.streamId) {
      return {
        ok: false,
        elapsedMs: performance.now() - started,
        code: "STREAM_ID_MISSING",
      };
    }

    while (!state.complete && state.pullsSent < streamMaxPulls) {
      const previousChunks = state.chunks;
      const pullResponsePromise = waitForAckByRequestId(
        socket,
        "relay:rpc.stream.pull_response",
        state.requestId,
        30000,
      );
      socket.emit("relay:rpc.stream.pull", {
        conversationId: startedConversation.conversationId,
        frame: encodePayloadFrame(
          {
            request_id: state.requestId,
            stream_id: state.streamId,
            window_size: streamPullWindow,
          },
          state.requestId,
        ),
      });
      state.pullsSent += 1;
      const pullResponse = await pullResponsePromise;
      if (!pullResponse?.success) {
        return {
          ok: false,
          elapsedMs: performance.now() - started,
          code: pullResponse?.error?.code || "STREAM_PULL_FAILED",
          stream: {
            chunks: state.chunks,
            rows: state.rows,
            bytesReceived: state.bytesReceived,
            compressedBytesReceived: state.compressedBytesReceived,
            pullsSent: state.pullsSent,
            chunkIntervalsMs: state.chunkIntervalsMs,
          },
        };
      }
      await waitForStreamProgress(state, previousChunks, streamPullWindow, 30000);
    }

    const observedRows = state.totalRows ?? state.rows;
    const rowsMatch = streamExpectRows === undefined || observedRows === streamExpectRows;
    return {
      ok: state.complete && rowsMatch,
      elapsedMs: performance.now() - started,
      code: state.complete
        ? rowsMatch
          ? undefined
          : "STREAM_EXPECT_ROWS_MISMATCH"
        : "STREAM_INCOMPLETE",
      stream: {
        chunks: state.chunks,
        rows: state.rows,
        totalRows: state.totalRows,
        bytesReceived: state.bytesReceived,
        compressedBytesReceived: state.compressedBytesReceived,
        pullsSent: state.pullsSent,
        chunkIntervalsMs: state.chunkIntervalsMs,
      },
    };
  } finally {
    socket.off("relay:rpc.chunk", onChunk);
    socket.off("relay:rpc.complete", onComplete);
    responseCollector.close();
    socket.emit("relay:conversation.end", {
      conversationId: startedConversation.conversationId,
    });
  }
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
  const streamSummaries = [];

  await runPool(jobs, concurrency, async (socket) => {
    const result =
      mode === "rest"
        ? await runRestBridge()
        : mode === "relay"
          ? await runRelay(socket)
          : mode === "relay-stream"
            ? await runRelayStream(socket)
            : mode === "custom-event"
              ? await runCustomEventPublish(socket)
              : await runAgentsCommand(socket);
    if (result.stream) {
      streamSummaries.push(result.stream);
    }
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
  const streamChunkIntervals = streamSummaries.flatMap((summary) => summary.chunkIntervalsMs);
  console.log(
    JSON.stringify(
      {
        total,
        succeeded: total - failed,
        failed,
        failures: Object.fromEntries(failures),
        ...(mode === "custom-event" ? { eventName: customEventName, idempotencyMode } : {}),
        ...(mode === "relay-stream"
          ? {
              stream: {
                pullWindow: streamPullWindow,
                maxPulls: streamMaxPulls,
                ...(streamExpectRows !== undefined ? { expectRows: streamExpectRows } : {}),
                chunks: streamSummaries.reduce((sum, item) => sum + item.chunks, 0),
                rows: streamSummaries.reduce((sum, item) => sum + item.rows, 0),
                bytesReceived: streamSummaries.reduce((sum, item) => sum + item.bytesReceived, 0),
                compressedBytesReceived: streamSummaries.reduce(
                  (sum, item) => sum + item.compressedBytesReceived,
                  0,
                ),
                pullsSent: streamSummaries.reduce((sum, item) => sum + item.pullsSent, 0),
                chunkIntervalMs: {
                  p95: Math.round(percentile(streamChunkIntervals, 95)),
                  p99: Math.round(percentile(streamChunkIntervals, 99)),
                },
              },
            }
          : {}),
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
