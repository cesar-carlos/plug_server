export type ClientAgentAccessRequestStatus = "pending" | "approved" | "rejected" | "expired";

export interface ClientAgentAccessRequestProps {
  readonly id: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly status: ClientAgentAccessRequestStatus;
  readonly requestedAt: Date;
  readonly decidedAt?: Date;
  readonly decisionReason?: string;
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
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(props: {
    readonly id?: string;
    readonly clientId: string;
    readonly agentId: string;
    readonly status?: ClientAgentAccessRequestStatus;
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
      requestedAt: props.requestedAt ?? now,
      createdAt: props.createdAt ?? now,
      updatedAt: props.updatedAt ?? now,
    });
  }
}
