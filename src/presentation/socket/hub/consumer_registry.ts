export interface RegisteredConsumer {
  readonly socketId: string;
  readonly userId: string | null;
  readonly principalType: "user" | "client" | null;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

interface InternalRegisteredConsumer {
  readonly socketId: string;
  readonly userId: string | null;
  readonly principalType: "user" | "client" | null;
  readonly connectedAtMs: number;
  lastSeenAtMs: number;
}

class InMemoryConsumerRegistry {
  private readonly consumers = new Map<string, InternalRegisteredConsumer>();

  private toPublic(internal: InternalRegisteredConsumer): RegisteredConsumer {
    return {
      socketId: internal.socketId,
      userId: internal.userId,
      principalType: internal.principalType,
      connectedAt: new Date(internal.connectedAtMs).toISOString(),
      lastSeenAt: new Date(internal.lastSeenAtMs).toISOString(),
    };
  }

  registerSession(input: {
    readonly socketId: string;
    readonly userId: string | null;
    readonly principalType: "user" | "client" | null;
  }): RegisteredConsumer {
    const nowMs = Date.now();
    const existing = this.consumers.get(input.socketId);
    const consumer: InternalRegisteredConsumer = {
      socketId: input.socketId,
      userId: input.userId,
      principalType: input.principalType,
      connectedAtMs: existing?.connectedAtMs ?? nowMs,
      lastSeenAtMs: nowMs,
    };
    this.consumers.set(input.socketId, consumer);
    return this.toPublic(consumer);
  }

  touch(socketId: string): RegisteredConsumer | null {
    const existing = this.consumers.get(socketId);
    if (!existing) {
      return null;
    }

    existing.lastSeenAtMs = Date.now();
    this.consumers.set(socketId, existing);
    return this.toPublic(existing);
  }

  removeBySocketId(socketId: string): RegisteredConsumer | null {
    const existing = this.consumers.get(socketId);
    if (!existing) {
      return null;
    }

    this.consumers.delete(socketId);
    return this.toPublic(existing);
  }

  listIdle(idleTimeoutMs: number): readonly RegisteredConsumer[] {
    const timeoutMs = Math.max(1, Math.floor(idleTimeoutMs));
    const nowMs = Date.now();
    const idle: RegisteredConsumer[] = [];

    for (const internal of this.consumers.values()) {
      if (nowMs - internal.lastSeenAtMs >= timeoutMs) {
        idle.push(this.toPublic(internal));
      }
    }

    return idle;
  }

  clear(): void {
    this.consumers.clear();
  }
}

export const consumerRegistry = new InMemoryConsumerRegistry();
