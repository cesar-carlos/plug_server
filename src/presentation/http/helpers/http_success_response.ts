/**
 * Canonical success envelope for new JSON endpoints (`{ success, data, meta?, requestId? }`).
 * Legacy auth and similar routes keep their flat shapes; see contract tests.
 */
export interface HttpSuccessEnvelopeBody<T> {
  readonly success: true;
  readonly data: T;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
}

export const buildHttpSuccessResponseBody = <T>(input: {
  readonly data: T;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly requestId?: string | undefined;
}): HttpSuccessEnvelopeBody<T> => ({
  success: true,
  data: input.data,
  ...(input.meta !== undefined ? { meta: input.meta } : {}),
  ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
});

/**
 * Attaches `requestId` to a flat JSON body without wrapping it in the canonical envelope.
 * Use on minimal utility endpoints (ping, health) where changing the top-level shape would
 * break existing clients.
 */
export const attachHttpRequestId = <T extends Record<string, unknown>>(
  payload: T,
  requestId: string | undefined,
): T & { readonly requestId?: string } => {
  if (requestId === undefined) {
    return payload;
  }
  return { ...payload, requestId };
};
