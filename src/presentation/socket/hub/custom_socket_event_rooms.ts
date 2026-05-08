import { createHash } from "node:crypto";

export const buildCustomSocketEventRoom = (eventName: string): string => {
  const digest = createHash("sha256").update(eventName).digest("hex").slice(0, 32);
  return `consumer:custom-event:${digest}`;
};
