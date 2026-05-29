import type { BridgeCommand, PayloadFrameCompression } from "../../shared/validators/agent_command";

export interface BridgeForwardDispatchSuccessResult {
  readonly requestId: string;
  readonly response: unknown;
}

export interface BridgeForwardDispatchNotificationResult {
  readonly requestId: string;
  readonly notification: true;
  readonly acceptedCommands: number;
}

export type BridgeForwardDispatchResult =
  | BridgeForwardDispatchSuccessResult
  | BridgeForwardDispatchNotificationResult;

export interface BridgeForwardCommandEnvelope {
  readonly kind: "bridge_forward_command";
  readonly correlationId: string;
  readonly agentId: string;
  readonly command: BridgeCommand;
  readonly timeoutMs?: number | undefined;
  readonly payloadFrameCompression?: PayloadFrameCompression | undefined;
}

export type BridgeForwardReplyPayload =
  | {
      readonly kind: "success";
      readonly result: BridgeForwardDispatchResult;
    }
  | {
      readonly kind: "agent_disconnected";
      readonly agentId: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly statusCode?: number | undefined;
      readonly code?: string | undefined;
    };
