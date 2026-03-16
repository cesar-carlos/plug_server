type JsonRpcId = string | number | null;

interface NormalizedRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface NormalizedRpcItem {
  readonly id: JsonRpcId;
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: NormalizedRpcError;
}

interface NormalizedRpcSingleResponse {
  readonly type: "single";
  readonly success: boolean;
  readonly item: NormalizedRpcItem;
}

interface NormalizedRpcBatchResponse {
  readonly type: "batch";
  readonly success: boolean;
  readonly items: readonly NormalizedRpcItem[];
}

interface NormalizedRpcRawResponse {
  readonly type: "raw";
  readonly success: false;
  readonly payload: unknown;
}

export type NormalizedAgentRpcResponse =
  | NormalizedRpcSingleResponse
  | NormalizedRpcBatchResponse
  | NormalizedRpcRawResponse;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const toJsonRpcId = (value: unknown): JsonRpcId => {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value === null) {
    return null;
  }

  return null;
};

const normalizeRpcError = (value: unknown): NormalizedRpcError => {
  if (!isRecord(value)) {
    return {
      code: -32603,
      message: "Invalid RPC error payload",
    };
  }

  const code = typeof value.code === "number" ? value.code : -32603;
  const message =
    typeof value.message === "string" && value.message.trim() !== ""
      ? value.message
      : "Unknown RPC error";

  return {
    code,
    message,
    ...(value.data !== undefined ? { data: value.data } : {}),
  };
};

const normalizeRpcItem = (payload: unknown): NormalizedRpcItem | null => {
  if (!isRecord(payload)) {
    return null;
  }

  const id = toJsonRpcId(payload.id);
  const hasError = payload.error !== undefined;
  const hasResult = payload.result !== undefined;

  if (hasError) {
    return {
      id,
      success: false,
      error: normalizeRpcError(payload.error),
    };
  }

  if (hasResult) {
    return {
      id,
      success: true,
      result: payload.result,
    };
  }

  return {
    id,
    success: false,
    error: {
      code: -32603,
      message: "RPC response missing both result and error",
    },
  };
};

export const normalizeAgentRpcResponse = (payload: unknown): NormalizedAgentRpcResponse => {
  if (Array.isArray(payload)) {
    const items = payload
      .map((item) => normalizeRpcItem(item))
      .filter((item): item is NormalizedRpcItem => item !== null);

    if (items.length === 0) {
      return {
        type: "raw",
        success: false,
        payload,
      };
    }

    return {
      type: "batch",
      success: items.every((item) => item.success),
      items,
    };
  }

  const singleItem = normalizeRpcItem(payload);
  if (singleItem) {
    return {
      type: "single",
      success: singleItem.success,
      item: singleItem,
    };
  }

  return {
    type: "raw",
    success: false,
    payload,
  };
};
