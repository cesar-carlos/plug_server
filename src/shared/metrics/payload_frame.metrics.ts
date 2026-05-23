export type PayloadFrameSignatureAcceptedKeyKind = "active" | "previous" | "single_key";

export type PayloadFrameSignatureRejectReason =
  | "empty_value"
  | "invalid_block"
  | "invalid_signature"
  | "missing_key_id"
  | "no_key_configured"
  | "unknown_key_id"
  | "unsupported_alg";

const accepted: Record<PayloadFrameSignatureAcceptedKeyKind, number> = {
  active: 0,
  previous: 0,
  single_key: 0,
};

const rejected: Record<PayloadFrameSignatureRejectReason, number> = {
  empty_value: 0,
  invalid_block: 0,
  invalid_signature: 0,
  missing_key_id: 0,
  no_key_configured: 0,
  unknown_key_id: 0,
  unsupported_alg: 0,
};

export const notePayloadFrameSignatureAccepted = (
  keyKind: PayloadFrameSignatureAcceptedKeyKind,
): void => {
  accepted[keyKind] += 1;
};

export const notePayloadFrameSignatureRejected = (
  reason: PayloadFrameSignatureRejectReason,
): void => {
  rejected[reason] += 1;
};

export const getPayloadFrameMetricsSnapshot = (): {
  readonly signatureAccepted: typeof accepted;
  readonly signatureRejected: typeof rejected;
} => ({
  signatureAccepted: { ...accepted },
  signatureRejected: { ...rejected },
});

export const resetPayloadFrameMetrics = (): void => {
  accepted.active = 0;
  accepted.previous = 0;
  accepted.single_key = 0;
  rejected.empty_value = 0;
  rejected.invalid_block = 0;
  rejected.invalid_signature = 0;
  rejected.missing_key_id = 0;
  rejected.no_key_configured = 0;
  rejected.unknown_key_id = 0;
  rejected.unsupported_alg = 0;
};
