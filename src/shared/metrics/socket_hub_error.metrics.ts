/**
 * Counters for Engine.IO and namespace-level Socket.IO hub errors.
 * Exposed via GET /metrics through `getSocketMetricsSnapshot`.
 */

export type SocketEngineConnectionErrorCode = "unsupported_protocol" | "bad_request" | "unknown";

export type SocketNamespaceErrorSource = "adapter" | "socket";

const engineConnectionErrors: Record<SocketEngineConnectionErrorCode, number> = {
  unsupported_protocol: 0,
  bad_request: 0,
  unknown: 0,
};

const namespaceAdapterErrors: Record<string, number> = {};
const namespaceSocketErrors: Record<string, number> = {};

export const noteSocketEngineConnectionError = (code: SocketEngineConnectionErrorCode): void => {
  engineConnectionErrors[code] += 1;
};

export const noteSocketNamespaceAdapterError = (namespace: string): void => {
  namespaceAdapterErrors[namespace] = (namespaceAdapterErrors[namespace] ?? 0) + 1;
};

export const noteSocketNamespaceSocketError = (namespace: string): void => {
  namespaceSocketErrors[namespace] = (namespaceSocketErrors[namespace] ?? 0) + 1;
};

export const getSocketHubErrorMetricsSnapshot = (): {
  readonly engineConnectionErrors: typeof engineConnectionErrors;
  readonly namespaceAdapterErrors: typeof namespaceAdapterErrors;
  readonly namespaceSocketErrors: typeof namespaceSocketErrors;
} => ({
  engineConnectionErrors: { ...engineConnectionErrors },
  namespaceAdapterErrors: { ...namespaceAdapterErrors },
  namespaceSocketErrors: { ...namespaceSocketErrors },
});

export const resetSocketHubErrorMetrics = (): void => {
  engineConnectionErrors.unsupported_protocol = 0;
  engineConnectionErrors.bad_request = 0;
  engineConnectionErrors.unknown = 0;
  for (const key of Object.keys(namespaceAdapterErrors)) {
    delete namespaceAdapterErrors[key];
  }
  for (const key of Object.keys(namespaceSocketErrors)) {
    delete namespaceSocketErrors[key];
  }
};
