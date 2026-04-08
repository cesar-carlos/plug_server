import type { Agent } from "../entities/agent.entity";

export interface AgentProfileCommitInput {
  readonly mode: "create" | "update";
  readonly previousProfileVersion: number;
  readonly nextAgent: Agent;
  readonly source: string;
  readonly actorUserId?: string;
  readonly requestId?: string;
  readonly idempotencyKey?: string;
  readonly dedupeKey?: string;
  readonly patchFingerprint: string;
  readonly changedFields: readonly string[];
  readonly snapshotJson: Record<string, unknown>;
}

export type AgentProfileCommitResult =
  | { readonly status: "committed"; readonly agent: Agent }
  | { readonly status: "idempotent"; readonly agent: Agent }
  | { readonly status: "conflict"; readonly message: string };
