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

/**
 * Reverse index: socketId → Set of inflight keys (`socketId:agentId`) for that socket.
 * Keeps `clearInflightAgentAccessForSocket` O(keys for socket) instead of O(all inflight).
 */
const inflightKeysBySocketId = new Map<string, Set<string>>();

/**
 * Reverse index: agentId → Set of socketIds that have a cached access snapshot for that agent.
 * Used by `invalidateAgentAccessSnapshot` to avoid an O(N) scan over all consumer sockets.
 */
const socketIdsByAgentId = new Map<string, Set<string>>();

/** Principal key → socketIds with at least one cached agent-access snapshot on this hub. */
const socketIdsByPrincipalKey = new Map<string, Set<string>>();

const buildPrincipalKey = (principal: AgentAccessPrincipal): string =>
  `${principal.type}:${principal.id}`;

const resolvePrincipalKeyFromUser = (user: JwtAccessPayload | undefined): string | null => {
  if (typeof user?.sub !== "string" || user.sub.trim() === "") {
    return null;
  }
  return user.principal_type === "client" ? `client:${user.sub}` : `user:${user.sub}`;
};

const trackSocketInPrincipalIndex = (principalKey: string, socketId: string): void => {
  let sockets = socketIdsByPrincipalKey.get(principalKey);
  if (!sockets) {
    sockets = new Set<string>();
    socketIdsByPrincipalKey.set(principalKey, sockets);
  }
  sockets.add(socketId);
};

const untrackSocketFromPrincipalIndex = (principalKey: string, socketId: string): void => {
  const sockets = socketIdsByPrincipalKey.get(principalKey);
  if (!sockets) {
    return;
  }
  sockets.delete(socketId);
  if (sockets.size === 0) {
    socketIdsByPrincipalKey.delete(principalKey);
  }
};

const maybeUntrackSocketFromPrincipalIndex = (socket: GuardSocket): void => {
  const snapshots = socket.data.agentAccessSnapshots;
  if (snapshots && snapshots.size > 0) {
    return;
  }
  const principalKey = resolvePrincipalKeyFromUser(socket.data.user);
  if (principalKey) {
    untrackSocketFromPrincipalIndex(principalKey, socket.id);
  }
};

const removeAgentAccessSnapshotIndexEntry = (agentId: string, socketId: string): void => {
  const sockets = socketIdsByAgentId.get(agentId);
  if (!sockets) {
    return;
  }
  sockets.delete(socketId);
  if (sockets.size === 0) {
    socketIdsByAgentId.delete(agentId);
  }
};

const inFlightAgentAccessKey = (socketId: string, agentId: string): string =>
  `${socketId}:${agentId}`;

const trackInflightKeyForSocket = (socketId: string, inflightKey: string): void => {
  let socketInflight = inflightKeysBySocketId.get(socketId);
  if (!socketInflight) {
    socketInflight = new Set<string>();
    inflightKeysBySocketId.set(socketId, socketInflight);
  }
  socketInflight.add(inflightKey);
};

const untrackInflightKeyForSocket = (socketId: string, inflightKey: string): void => {
  const socketKeys = inflightKeysBySocketId.get(socketId);
  if (!socketKeys) {
    return;
  }
  socketKeys.delete(inflightKey);
  if (socketKeys.size === 0) {
    inflightKeysBySocketId.delete(socketId);
  }
};

/**
 * Clears pending agent-access validations for a disconnecting socket so async
 * DB checks cannot repopulate `socketIdsByAgentId` after cleanup.
 */
export const clearInflightAgentAccessForSocket = (socketId: string): void => {
  const keys = inflightKeysBySocketId.get(socketId);
  if (!keys) {
    return;
  }
  for (const key of keys) {
    inFlightAgentAccessBySocketAgent.delete(key);
  }
  inflightKeysBySocketId.delete(socketId);
};

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

  let sockets = socketIdsByAgentId.get(agentId);
  if (!sockets) {
    sockets = new Set<string>();
    socketIdsByAgentId.set(agentId, sockets);
  }
  sockets.add(socket.id);
  trackSocketInPrincipalIndex(buildPrincipalKey(principal), socket.id);
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
  removeAgentAccessSnapshotIndexEntry(agentId, (socket as { id?: string }).id ?? "");
  maybeUntrackSocketFromPrincipalIndex(socket as GuardSocket);
};

/** Clears all per-socket agent-access snapshots (e.g. when the user account is blocked). */
export const clearAllConsumerSocketAgentAccessSnapshots = (
  socket: AgentAccessSnapshotHolder,
): void => {
  const snapshots = socket.data.agentAccessSnapshots;
  if (snapshots) {
    const socketId = (socket as { id?: string }).id ?? "";
    for (const agentId of snapshots.keys()) {
      removeAgentAccessSnapshotIndexEntry(agentId, socketId);
    }
    snapshots.clear();
    const principalKey = resolvePrincipalKeyFromUser((socket as GuardSocket).data.user);
    if (principalKey) {
      untrackSocketFromPrincipalIndex(principalKey, socketId);
    }
  }
};

/**
 * Returns the set of socketIds that currently hold a cached access snapshot for the given agentId.
 * Used by the socket control sink to perform targeted invalidation without iterating all consumers.
 */
export const getSocketIdsWithAgentAccessSnapshot = (agentId: string): ReadonlySet<string> =>
  socketIdsByAgentId.get(agentId) ?? new Set<string>();

export const getSocketIdsWithPrincipalKey = (principalKey: string): ReadonlySet<string> =>
  socketIdsByPrincipalKey.get(principalKey) ?? new Set<string>();

type LocalConsumerSocketLookup = {
  readonly sockets: {
    get(socketId: string): AgentAccessSnapshotHolder | undefined;
  };
};

/**
 * Clears cached agent-access snapshots for local sockets indexed under `agentId`.
 * Stale index entries (socket no longer on this hub) are pruned without `fetchSockets`.
 */
export const invalidateLocalAgentAccessSnapshotsByAgentId = (
  namespace: LocalConsumerSocketLookup,
  agentId: string,
): number => {
  let cleared = 0;
  for (const socketId of [...getSocketIdsWithAgentAccessSnapshot(agentId)]) {
    const socket = namespace.sockets.get(socketId);
    if (!socket) {
      removeAgentAccessSnapshotIndexEntry(agentId, socketId);
      continue;
    }
    clearConsumerSocketAgentAccessSnapshot(socket, agentId);
    cleared += 1;
  }
  return cleared;
};

/**
 * Clears one client principal's cached snapshot for `agentId` on this hub only.
 */
export const invalidateLocalClientAgentAccessSnapshot = (
  namespace: LocalConsumerSocketLookup,
  clientId: string,
  agentId: string,
): number => {
  let cleared = 0;
  for (const socketId of [...getSocketIdsWithAgentAccessSnapshot(agentId)]) {
    const socket = namespace.sockets.get(socketId) as GuardSocket | undefined;
    if (!socket) {
      removeAgentAccessSnapshotIndexEntry(agentId, socketId);
      continue;
    }
    if (socket.data.user?.principal_type !== "client" || socket.data.user.sub !== clientId) {
      continue;
    }
    clearConsumerSocketAgentAccessSnapshot(socket, agentId);
    cleared += 1;
  }
  return cleared;
};

/**
 * Clears all cached agent-access snapshots for a user principal on this hub only.
 */
export const invalidateLocalUserAccessSnapshots = (
  namespace: LocalConsumerSocketLookup,
  userId: string,
): number => {
  let cleared = 0;
  for (const socketId of [...getSocketIdsWithPrincipalKey(`user:${userId}`)]) {
    const socket = namespace.sockets.get(socketId);
    if (!socket) {
      untrackSocketFromPrincipalIndex(`user:${userId}`, socketId);
      continue;
    }
    clearAllConsumerSocketAgentAccessSnapshots(socket);
    cleared += 1;
  }
  return cleared;
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
    const inflightKey = inFlightAgentAccessKey(socket.id, agentId);
    if (inFlightAgentAccessBySocketAgent.has(inflightKey)) {
      recordAgentAccessSnapshot(user, agentId, principal, socket);
    }
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
    trackInflightKeyForSocket(socket.id, inflightKey);

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
        untrackInflightKeyForSocket(socket.id, inflightKey);
      }
    })();

    return validationPromise;
  }

  return validateAgentAccessAgainstDb(validatedUser, agentId, principal);
};
