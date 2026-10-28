export interface PwaPushSubscription {
  readonly clientId: string;
  readonly installationId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}
export interface PwaPushMessage {
  readonly eventId: string;
  readonly type: "access-approved" | "access-revoked";
}
export interface PwaPushJob {
  readonly id: string;
  readonly subscription: PwaPushSubscription;
  readonly message: PwaPushMessage;
  readonly attempts: number;
}
export interface PwaPushStore {
  save(subscription: PwaPushSubscription): Promise<void>;
  remove(clientId: string, installationId: string): Promise<void>;
  enqueue(clientId: string, message: PwaPushMessage): Promise<void>;
  claim(now: Date): Promise<PwaPushJob | null>;
  complete(id: string): Promise<void>;
  retry(id: string, next: Date): Promise<void>;
}
export interface PwaPushSender {
  send(
    subscription: PwaPushSubscription,
    message: PwaPushMessage,
  ): Promise<"sent" | "expired" | "retry">;
}
