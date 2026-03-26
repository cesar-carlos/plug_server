import { randomUUID } from "node:crypto";

export type ConversationCloseReason =
  | "consumer_ended"
  | "consumer_disconnected"
  | "agent_disconnected"
  | "expired";

export interface RelayConversation {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

interface InternalRelayConversation {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly agentId: string;
  readonly createdAtMs: number;
  lastSeenAtMs: number;
}

const addIndexValue = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (existing) {
    existing.add(value);
    return;
  }

  index.set(key, new Set([value]));
};

const removeIndexValue = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (!existing) {
    return;
  }

  existing.delete(value);
  if (existing.size === 0) {
    index.delete(key);
  }
};

class InMemoryConversationRegistry {
  private readonly conversations = new Map<string, InternalRelayConversation>();
  private readonly conversationsByConsumerSocket = new Map<string, Set<string>>();
  private readonly conversationsByAgentSocket = new Map<string, Set<string>>();

  private toPublic(internal: InternalRelayConversation): RelayConversation {
    return {
      conversationId: internal.conversationId,
      consumerSocketId: internal.consumerSocketId,
      agentSocketId: internal.agentSocketId,
      agentId: internal.agentId,
      createdAt: new Date(internal.createdAtMs).toISOString(),
      lastSeenAt: new Date(internal.lastSeenAtMs).toISOString(),
    };
  }

  create(input: {
    readonly consumerSocketId: string;
    readonly agentSocketId: string;
    readonly agentId: string;
    readonly conversationId?: string;
  }): RelayConversation {
    const nowMs = Date.now();
    const conversationId = input.conversationId ?? randomUUID();

    const conversation: InternalRelayConversation = {
      conversationId,
      consumerSocketId: input.consumerSocketId,
      agentSocketId: input.agentSocketId,
      agentId: input.agentId,
      createdAtMs: nowMs,
      lastSeenAtMs: nowMs,
    };

    this.conversations.set(conversationId, conversation);
    addIndexValue(this.conversationsByConsumerSocket, input.consumerSocketId, conversationId);
    addIndexValue(this.conversationsByAgentSocket, input.agentSocketId, conversationId);
    return this.toPublic(conversation);
  }

  findByConversationId(conversationId: string): RelayConversation | null {
    const internal = this.conversations.get(conversationId);
    return internal ? this.toPublic(internal) : null;
  }

  countAll(): number {
    return this.conversations.size;
  }

  countByConsumerSocketId(consumerSocketId: string): number {
    return this.conversationsByConsumerSocket.get(consumerSocketId)?.size ?? 0;
  }

  touch(conversationId: string): RelayConversation | null {
    const existing = this.conversations.get(conversationId);
    if (!existing) {
      return null;
    }

    existing.lastSeenAtMs = Date.now();
    this.conversations.set(conversationId, existing);
    return this.toPublic(existing);
  }

  removeByConversationId(conversationId: string): RelayConversation | null {
    const existing = this.conversations.get(conversationId);
    if (!existing) {
      return null;
    }

    this.conversations.delete(conversationId);
    removeIndexValue(this.conversationsByConsumerSocket, existing.consumerSocketId, conversationId);
    removeIndexValue(this.conversationsByAgentSocket, existing.agentSocketId, conversationId);
    return this.toPublic(existing);
  }

  removeByConsumerSocketId(consumerSocketId: string): readonly RelayConversation[] {
    const ids = Array.from(this.conversationsByConsumerSocket.get(consumerSocketId) ?? []);
    const removed: RelayConversation[] = [];

    for (const conversationId of ids) {
      const item = this.removeByConversationId(conversationId);
      if (item) {
        removed.push(item);
      }
    }

    return removed;
  }

  removeByAgentSocketId(agentSocketId: string): readonly RelayConversation[] {
    const ids = Array.from(this.conversationsByAgentSocket.get(agentSocketId) ?? []);
    const removed: RelayConversation[] = [];

    for (const conversationId of ids) {
      const item = this.removeByConversationId(conversationId);
      if (item) {
        removed.push(item);
      }
    }

    return removed;
  }

  isConsumerOwner(conversationId: string, consumerSocketId: string): boolean {
    const conversation = this.findByConversationId(conversationId);
    return conversation?.consumerSocketId === consumerSocketId;
  }

  removeExpired(idleTimeoutMs: number): readonly RelayConversation[] {
    const timeoutMs = Math.max(1, Math.floor(idleTimeoutMs));
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const conversation of this.conversations.values()) {
      if (now - conversation.lastSeenAtMs >= timeoutMs) {
        expiredIds.push(conversation.conversationId);
      }
    }

    const removed: RelayConversation[] = [];
    for (const conversationId of expiredIds) {
      const item = this.removeByConversationId(conversationId);
      if (item) {
        removed.push(item);
      }
    }

    return removed;
  }

  clear(): void {
    this.conversations.clear();
    this.conversationsByConsumerSocket.clear();
    this.conversationsByAgentSocket.clear();
  }
}

export const conversationRegistry = new InMemoryConversationRegistry();
