/**
 * Minimal `/consumers` client for hub → agent command paths (same entry as real consumers).
 */

import { io as ioClient, type Socket as IoSocket } from "socket.io-client";
import {
  decodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../../src/shared/utils/payload_frame";

export const connectConsumerSocket = (baseUrl: string, accessToken: string): Promise<IoSocket> => {
  return new Promise<IoSocket>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token: accessToken },
      transports: ["websocket"],
    });
    socket.on("connection:ready", (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        reject(new Error(`Failed to decode connection:ready: ${decoded.error.message}`));
        return;
      }
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      socket.disconnect();
      reject(err);
    });
  });
};

export const decodeConsumerSocketPayload = <T>(rawPayload: unknown): T => {
  if (!isPayloadFrameEnvelope(rawPayload)) {
    return rawPayload as T;
  }

  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    throw new Error(`Failed to decode consumer PayloadFrame: ${decoded.error.message}`);
  }
  return decoded.value.data as T;
};
