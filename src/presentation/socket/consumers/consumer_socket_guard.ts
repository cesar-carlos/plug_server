import type { Socket } from "socket.io";

import type { AgentAccessPrincipal } from "../../../application/services/agent_access.service";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import {
  assertJwtUserAccountActive,
  type SocketAccountSnapshot,
} from "../auth/ensure_socket_active_account";
import { joinConsumerClientAgentRoom } from "../hub/consumer_identity_rooms";

/**
 * Per-socket metadata from the last successful agent-access guard for a given agentId.
 * Stored on `socket.data.agentAccessSnapshots` after each DB-backed validation.
 */
export interface SocketAgentAccessSnapshot {
  readonly agentId: string;
  readonly principalId: string;
  readonly principalType: AgentAccessPrincipal["type"];
  readonly credentialsVersion: number | undefined;
  validatedAtMs: number;
}

type GuardSocket = Socket & {
  data: {
    user?: JwtAccessPayload;
    authSnapshot?: SocketAccountSnapshot;
    agentAccessSnapshots?: Map<string, SocketAgentAccessSnapshot>;
  };
};

/** Coalesces concurrent agent-access validations on the same socket+agent before snapshot is written. */
const inFlightAgentAccessBySocketAgent = new Map<string, Promise<AgentAccessPrincipal>>();

const inFlightAgentAccessKey = (socketId: string, agentId: string): string =>
  `${socketId}:${agentId}`;

export const resolveSocketActorRole = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.role === "string" && user.role.trim() !== "" ? user.role : null;

export const resolveConsumerAgentAccessPrincipal = (
  user: JwtAccessPayload | undefined,
): AgentAccessPrincipal | null => {
  if (typeof user?.sub !== "string" || user.sub.trim() === "") {
    return null;
  }

  return user.principal_type === "client"
    ? { type: "client", id: user.sub }
    : { type: "user", id: user.sub, ...(user.role !== undefined ? { role: user.role } : {}) };
};

const buildAgentAccessSnapshot = (
  user: JwtAccessPayload,
  agentId: string,
  principal: AgentAccessPrincipal,
): SocketAgentAccessSnapshot => ({
  agentId,
  principalId: principal.id,
  principalType: principal.type,
  credentialsVersion: user.credentials_version,
  validatedAtMs: Date.now(),
});

const tryGetCachedAgentAccess = (
  user: JwtAccessPayload,
  agentId: string,
  principal: AgentAccessPrincipal,
  socket: GuardSocket,
): AgentAccessPrincipal | null => {
  const ttlMs = env.socketConsumerAgentAccessSnapshotTtlMs;
  if (ttlMs <= 0) {
    return null;
  }

  const snap = socket.data.agentAccessSnapshots?.get(agentId);
  if (!snap) {
    return null;
  }

  const principalOk =
    snap.principalId === principal.id &&
    snap.principalType === principal.type &&
    snap.credentialsVersion === user.credentials_version;
  if (!principalOk || Date.now() - snap.validatedAtMs >= ttlMs) {
    return null;
  }

  return principal;
};

const recordAgentAccessSnapshot = (
  user: JwtAccessPayload,
  agentId: string,
  principal: AgentAccessPrincipal,
  socket: GuardSocket,
): void => {
  if (env.socketConsumerAgentAccessSnapshotTtlMs <= 0) {
    return;
  }

  const snapshots =
    socket.data.agentAccessSnapshots ?? (socket.data.agentAccessSnapshots = new Map());
  snapshots.set(agentId, buildAgentAccessSnapshot(user, agentId, principal));
};

type AgentAccessSnapshotHolder = {
  data: {
    agentAccessSnapshots?: Map<string, SocketAgentAccessSnapshot>;
  };
};

/** Clears the per-socket agent-access snapshot so the next guard revalidates against the DB. */
export const clearConsumerSocketAgentAccessSnapshot = (
  socket: AgentAccessSnapshotHolder,
  agentId: string,
): void => {
  socket.data.agentAccessSnapshots?.delete(agentId);
};

/** Clears all per-socket agent-access snapshots (e.g. when the user account is blocked). */
export const clearAllConsumerSocketAgentAccessSnapshots = (
  socket: AgentAccessSnapshotHolder,
): void => {
  socket.data.agentAccessSnapshots?.clear();
};

const validateAgentAccessAgainstDb = async (
  user: JwtAccessPayload,
  agentId: string,
  principal: AgentAccessPrincipal,
  socket?: GuardSocket,
): Promise<AgentAccessPrincipal> => {
  const accessResult = await container.agentAccessService.assertPrincipalAccess(principal, agentId);
  if (!accessResult.ok) {
    throw accessResult.error;
  }

  if (principal.type === "client" && socket) {
    await joinConsumerClientAgentRoom(socket, { clientId: principal.id, agentId });
  }

  if (socket) {
    recordAgentAccessSnapshot(user, agentId, principal, socket);
  }

  return principal;
};

/**
 * Per-event guard for consumer namespace operations. Validates that the JWT is
 * still tied to an active account (lightweight DB snapshot) AND that the principal
 * has access to the requested agent.
 */
export const assertConsumerSocketAgentAccess = async (
  user: JwtAccessPayload | undefined,
  agentId: string,
  socket?: GuardSocket,
): Promise<AgentAccessPrincipal> => {
  const validatedUser = await assertJwtUserAccountActive(user, socket, {
    recordConsumerBlockedMetric: true,
  });

  const principal = resolveConsumerAgentAccessPrincipal(validatedUser);
  if (!principal) {
    throw new AppError("Authentication required", { code: "UNAUTHORIZED", statusCode: 401 });
  }

  if (socket) {
    const cached = tryGetCachedAgentAccess(validatedUser, agentId, principal, socket);
    if (cached) {
      return cached;
    }

    const inflightKey = inFlightAgentAccessKey(socket.id, agentId);
    const inflight = inFlightAgentAccessBySocketAgent.get(inflightKey);
    if (inflight) {
      return inflight;
    }

    let resolveValidation!: (value: AgentAccessPrincipal) => void;
    let rejectValidation!: (reason?: unknown) => void;
    const validationPromise = new Promise<AgentAccessPrincipal>((resolve, reject) => {
      resolveValidation = resolve;
      rejectValidation = reject;
    });
    inFlightAgentAccessBySocketAgent.set(inflightKey, validationPromise);

    void (async () => {
      try {
        const validated = await validateAgentAccessAgainstDb(
          validatedUser,
          agentId,
          principal,
          socket,
        );
        resolveValidation(validated);
      } catch (error: unknown) {
        rejectValidation(error);
      } finally {
        if (inFlightAgentAccessBySocketAgent.get(inflightKey) === validationPromise) {
          inFlightAgentAccessBySocketAgent.delete(inflightKey);
        }
      }
    })();

    return validationPromise;
  }

  return validateAgentAccessAgainstDb(validatedUser, agentId, principal);
};
