import type { PayloadFrameEnvelope } from "../../../../shared/utils/payload_frame";
import { jsonUtf8ByteLengthOrNull } from "../../../../shared/validators/custom_socket_event";

export interface StreamChunkMetadata {
  readonly originalSizeBytes: number;
  readonly compressedSizeBytes?: number;
  readonly compression?: PayloadFrameEnvelope["cmp"];
}

export const streamChunkMetadataFromPayloadFrame = (
  frame: Pick<PayloadFrameEnvelope, "originalSize" | "compressedSize" | "cmp">,
): StreamChunkMetadata => ({
  originalSizeBytes: frame.originalSize,
  compressedSizeBytes: frame.compressedSize,
  compression: frame.cmp,
});

const normalizeByteLength = (value: number | undefined): number | null => {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.ceil(value);
};

export const resolveStreamChunkOriginalSizeBytes = (
  payload: Record<string, unknown>,
  metadata: StreamChunkMetadata | undefined,
  fallbackBytes: number,
): number => {
  const metadataBytes = normalizeByteLength(metadata?.originalSizeBytes);
  if (metadataBytes !== null) {
    return metadataBytes;
  }
  return jsonUtf8ByteLengthOrNull(payload) ?? fallbackBytes;
};
