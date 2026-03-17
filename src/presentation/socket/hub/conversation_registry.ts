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
  private readonly conversations = new Map<string, RelayConversation>();
  private readonly conversationsByConsumerSocket = new Map<string, Set<string>>();
  private readonly conversationsByAgentSocket = new Map<string, Set<string>>();

  create(input: {
    readonly consumerSocketId: string;
    readonly agentSocketId: string;
    readonly agentId: string;
    readonly conversationId?: string;
  }): RelayConversation {
    const now = new Date().toISOString();
    const conversationId = input.conversationId ?? randomUUID();

    const conversation: RelayConversation = {
      conversationId,
      consumerSocketId: input.consumerSocketId,
      agentSocketId: input.agentSocketId,
      agentId: input.agentId,
      createdAt: now,
      lastSeenAt: now,
    };

    this.conversations.set(conversationId, conversation);
    addIndexValue(this.conversationsByConsumerSocket, input.consumerSocketId, conversationId);
    addIndexValue(this.conversationsByAgentSocket, input.agentSocketId, conversationId);
    return conversation;
  }

  findByConversationId(conversationId: string): RelayConversation | null {
    return this.conversations.get(conversationId) ?? null;
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

    const updated: RelayConversation = {
      ...existing,
      lastSeenAt: new Date().toISOString(),
    };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  removeByConversationId(conversationId: string): RelayConversation | null {
    const existing = this.conversations.get(conversationId);
    if (!existing) {
      return null;
    }

    this.conversations.delete(conversationId);
    removeIndexValue(this.conversationsByConsumerSocket, existing.consumerSocketId, conversationId);
    removeIndexValue(this.conversationsByAgentSocket, existing.agentSocketId, conversationId);
    return existing;
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
    const removed: RelayConversation[] = [];

    for (const conversation of this.conversations.values()) {
      const lastSeenMs = Date.parse(conversation.lastSeenAt);
      if (Number.isNaN(lastSeenMs)) {
        continue;
      }

      if (now - lastSeenMs >= timeoutMs) {
        const item = this.removeByConversationId(conversation.conversationId);
        if (item) {
          removed.push(item);
        }
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
