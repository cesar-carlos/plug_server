import bytes from "bytes";

import { env } from "./env";
import {
  clientSocketEventPublishEnvelopeUtf8UpperBound,
  restSocketEventHttpJsonBodyMinBytes,
} from "./client_socket_event_publish_limits";
import { logger } from "../utils/logger";

/**
 * Warns when `REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT` is too small for configured
 * `REST_SOCKET_EVENT_*` payload + attachment ceilings (JSON-only REST publish).
 */
export const logEnvRestSocketEventHints = (): void => {
  const floor = restSocketEventHttpJsonBodyMinBytes(
    env.restSocketEventPayloadJsonMaxBytes,
    env.restSocketEventTotalFilesMaxBytes,
  );
  const parsed = bytes.parse(env.restSocketEventHttpJsonBodyLimit);
  if (parsed !== null && parsed < floor) {
    logger.warn("rest_socket_event_http_json_body_limit_tight", {
      message:
        "REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT is smaller than ~105% of the worst-case publish envelope; JSON POST /api/v1/client/me/socket-events may fail before application validation.",
      configuredLimit: env.restSocketEventHttpJsonBodyLimit,
      parsedBytes: parsed,
      recommendedMinBytes: floor,
      envelopeUpperBoundBytes: clientSocketEventPublishEnvelopeUtf8UpperBound(
        env.restSocketEventPayloadJsonMaxBytes,
        env.restSocketEventTotalFilesMaxBytes,
      ),
    });
  }
};
