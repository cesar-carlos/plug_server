import { env } from "../../shared/config/env";
import { AppError } from "../../shared/errors/app_error";
import {
  noteClientSocketEventPublishIdempotencySerializationCapRejected,
  noteCustomSocketEventPublishRejected,
} from "../../shared/metrics/socket_consumer.metrics";

/**
 * Serializes {@link executeClientSocketEventPublish} per `(clientId, idempotencyKey)` so concurrent
 * retries cannot double-emit before the in-memory idempotency entry is written.
 *
 * Each map value is the tail of the promise chain for that key. When the tail settles, the entry is
 * removed if it is still the active tail (so unique one-off keys do not grow the map forever).
 */
const serializationTails = new Map<string, Promise<unknown>>();

const buildSerializationKey = (clientId: string, idempotencyKey: string): string =>
  `${clientId}:${idempotencyKey}`;

/** For Prometheus gauge `plug_socket_custom_event_publish_idempotency_serialization_tracked_keys`. */
export const getClientSocketEventPublishIdempotencySerializationTrackedKeyCount = (): number =>
  serializationTails.size;

export type ClientSocketEventPublishIdempotencySerializationOptions = {
  /**
   * When set (e.g. in unit tests), overrides {@link env.restSocketEventIdempotencySerializationMaxKeys}.
   */
  readonly maxTrackedKeys?: number;
};

export const runWithClientSocketEventPublishIdempotencySerialization = async <T>(
  clientId: string,
  idempotencyKey: string,
  task: () => Promise<T>,
  options?: ClientSocketEventPublishIdempotencySerializationOptions,
): Promise<T> => {
  const key = buildSerializationKey(clientId, idempotencyKey);
  const maxTracked = options?.maxTrackedKeys ?? env.restSocketEventIdempotencySerializationMaxKeys;
  if (maxTracked > 0 && !serializationTails.has(key) && serializationTails.size >= maxTracked) {
    noteClientSocketEventPublishIdempotencySerializationCapRejected();
    noteCustomSocketEventPublishRejected();
    throw new AppError(
      "Too many concurrent distinct client socket event idempotency keys on this process; retry later or raise REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS",
      {
        statusCode: 503,
        code: "SERVICE_UNAVAILABLE",
        details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
      },
    );
  }

  const prev = serializationTails.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => task()) as Promise<T>;
  const tailMarker = next
    .finally(() => {
      if (serializationTails.get(key) === tailMarker) {
        serializationTails.delete(key);
      }
    })
    .catch(() => undefined);
  serializationTails.set(key, tailMarker);
  return next;
};

export const resetClientSocketEventPublishIdempotencySerializationQueues = (): void => {
  serializationTails.clear();
};
