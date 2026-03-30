export type AgentStatus = "active" | "inactive";

export interface AgentProps {
  readonly agentId: string;
  readonly name: string;
  readonly cnpjCpf: string;
  readonly observation: string | undefined;
  readonly status: AgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Agent {
  readonly agentId: string;
  readonly name: string;
  readonly cnpjCpf: string;
  readonly observation: string | undefined;
  readonly status: AgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: AgentProps) {
    this.agentId = props.agentId;
    this.name = props.name;
    this.cnpjCpf = props.cnpjCpf;
    this.observation = props.observation;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(opts: {
    agentId: string;
    name: string;
    cnpjCpf: string;
    observation?: string;
    status?: AgentStatus;
    createdAt?: Date;
    updatedAt?: Date;
  }): Agent {
    const now = new Date();
    return new Agent({
      agentId: opts.agentId,
      name: opts.name,
      cnpjCpf: opts.cnpjCpf,
      observation: opts.observation,
      status: opts.status ?? "active",
      createdAt: opts.createdAt ?? now,
      updatedAt: opts.updatedAt ?? now,
    });
  }

  deactivate(): Agent {
    return new Agent({
      agentId: this.agentId,
      name: this.name,
      cnpjCpf: this.cnpjCpf,
      observation: this.observation,
      status: "inactive",
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }

  update(patch: { name?: string; cnpjCpf?: string; observation?: string | null }): Agent {
    const newObservation =
      patch.observation === null ? undefined : (patch.observation ?? this.observation);
    return new Agent({
      agentId: this.agentId,
      name: patch.name ?? this.name,
      cnpjCpf: patch.cnpjCpf ?? this.cnpjCpf,
      observation: newObservation,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }
}
