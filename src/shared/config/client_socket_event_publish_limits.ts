/**
 * Shared sizing math for `POST /client/me/socket-events` (JSON + Socket `socket:event.publish`)
 * so REST limits, Engine.IO buffer, and Express JSON limits stay aligned.
 */

/** UTF-8 envelope upper bound for one publish (logical payload + base64 attachment budget + JSON overhead). */
export const clientSocketEventPublishEnvelopeUtf8UpperBound = (
  payloadJsonMaxBytes: number,
  totalFilesMaxBytes: number,
): number => {
  const attachmentB64Budget = Math.min(
    6 * 1024 * 1024,
    Math.ceil((totalFilesMaxBytes * 4) / 3) + 512 * 1024,
  );
  return payloadJsonMaxBytes + attachmentB64Budget + 64 * 1024;
};

/** Max raw UTF-8 for `socket:event.publish` before Zod (capped by Engine.IO packet size). */
export const socketEventPublishRawJsonUpperBound = (
  payloadJsonMaxBytes: number,
  totalFilesMaxBytes: number,
  socketIoMaxHttpBufferBytes: number,
): number =>
  Math.min(
    socketIoMaxHttpBufferBytes,
    Math.max(
      256 * 1024,
      clientSocketEventPublishEnvelopeUtf8UpperBound(payloadJsonMaxBytes, totalFilesMaxBytes),
    ),
  );

/** Minimum safe Express `json({ limit })` for JSON-only client socket-event publishes (~5% headroom). */
export const restSocketEventHttpJsonBodyMinBytes = (
  payloadJsonMaxBytes: number,
  totalFilesMaxBytes: number,
): number =>
  Math.ceil(clientSocketEventPublishEnvelopeUtf8UpperBound(payloadJsonMaxBytes, totalFilesMaxBytes) * 1.05);

/** Whole MiB string for Express / body-parser (`"12mb"`). */
export const formatExpressJsonBodyLimitMb = (minBytes: number): string => {
  const mib = Math.ceil(minBytes / (1024 * 1024));
  return `${Math.max(1, mib)}mb`;
};

export const defaultRestSocketEventHttpJsonBodyLimit = (
  payloadJsonMaxBytes: number,
  totalFilesMaxBytes: number,
): string =>
  formatExpressJsonBodyLimitMb(
    Math.ceil(clientSocketEventPublishEnvelopeUtf8UpperBound(payloadJsonMaxBytes, totalFilesMaxBytes) * 1.1),
  );
