export type ClientAgentAccessRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "revoked";

export interface ClientAgentAccessRequestProps {
  readonly id: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly status: ClientAgentAccessRequestStatus;
  readonly requestedAt: Date;
  readonly decidedAt?: Date;
  readonly decisionReason?: string;
  /** Incremented each time the client retries after rejection/expiry/revocation. */
  readonly retryCount?: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ClientAgentAccessRequest {
  readonly id: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly status: ClientAgentAccessRequestStatus;
  readonly requestedAt: Date;
  readonly decidedAt?: Date;
  readonly decisionReason?: string;
  readonly retryCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: ClientAgentAccessRequestProps) {
    this.id = props.id;
    this.clientId = props.clientId;
    this.agentId = props.agentId;
    this.status = props.status;
    this.requestedAt = props.requestedAt;
    if (props.decidedAt !== undefined) {
      this.decidedAt = props.decidedAt;
    }
    if (props.decisionReason !== undefined) {
      this.decisionReason = props.decisionReason;
    }
    this.retryCount = props.retryCount ?? 0;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(props: {
    readonly id?: string;
    readonly clientId: string;
    readonly agentId: string;
    readonly status?: ClientAgentAccessRequestStatus;
    readonly retryCount?: number;
    readonly requestedAt?: Date;
    readonly createdAt?: Date;
    readonly updatedAt?: Date;
  }): ClientAgentAccessRequest {
    const now = new Date();
    return new ClientAgentAccessRequest({
      id: props.id ?? crypto.randomUUID(),
      clientId: props.clientId,
      agentId: props.agentId,
      status: props.status ?? "pending",
      retryCount: props.retryCount ?? 0,
      requestedAt: props.requestedAt ?? now,
      createdAt: props.createdAt ?? now,
      updatedAt: props.updatedAt ?? now,
    });
  }
}
