/**
 * Legacy `app:error` wire shape used across hub namespaces.
 *
 * This event family intentionally differs from the canonical ack envelope
 * (`{ success: false, requestId, error: { code, message, details? } }`).
 * Clients must treat `app:error` as a transport/session signal, not as an
 * operation acknowledgement.
 */
export type LegacySocketAppErrorPayload = {
  readonly code: string;
  readonly message: string;
  readonly statusCode?: number;
};

export const buildLegacySocketAppErrorPayload = (
  code: string,
  message: string,
  statusCode?: number,
): LegacySocketAppErrorPayload => ({
  code,
  message,
  ...(typeof statusCode === "number" ? { statusCode } : {}),
});
