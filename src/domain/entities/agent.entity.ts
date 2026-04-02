export type AgentStatus = "active" | "inactive";
export type AgentDocumentType = "cpf" | "cnpj";

export interface AgentAddress {
  readonly street?: string | undefined;
  readonly number?: string | undefined;
  readonly district?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
}

export interface AgentProps {
  readonly agentId: string;
  readonly name: string;
  readonly tradeName: string | undefined;
  readonly document: string | undefined;
  readonly documentType: AgentDocumentType | undefined;
  readonly phone: string | undefined;
  readonly mobile: string | undefined;
  readonly email: string | undefined;
  readonly street: string | undefined;
  readonly number: string | undefined;
  readonly district: string | undefined;
  readonly postalCode: string | undefined;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly notes: string | undefined;
  readonly profileUpdatedAt: Date | undefined;
  readonly lastLoginUserId: string | undefined;
  readonly status: AgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Agent {
  readonly agentId: string;
  readonly name: string;
  readonly tradeName: string | undefined;
  readonly document: string | undefined;
  readonly documentType: AgentDocumentType | undefined;
  readonly phone: string | undefined;
  readonly mobile: string | undefined;
  readonly email: string | undefined;
  readonly street: string | undefined;
  readonly number: string | undefined;
  readonly district: string | undefined;
  readonly postalCode: string | undefined;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly notes: string | undefined;
  readonly profileUpdatedAt: Date | undefined;
  readonly lastLoginUserId: string | undefined;
  readonly status: AgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: AgentProps) {
    this.agentId = props.agentId;
    this.name = props.name;
    this.tradeName = props.tradeName;
    this.document = props.document;
    this.documentType = props.documentType;
    this.phone = props.phone;
    this.mobile = props.mobile;
    this.email = props.email;
    this.street = props.street;
    this.number = props.number;
    this.district = props.district;
    this.postalCode = props.postalCode;
    this.city = props.city;
    this.state = props.state;
    this.notes = props.notes;
    this.profileUpdatedAt = props.profileUpdatedAt;
    this.lastLoginUserId = props.lastLoginUserId;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(opts: {
    agentId: string;
    name: string;
    tradeName?: string;
    document?: string;
    documentType?: AgentDocumentType;
    phone?: string;
    mobile?: string;
    email?: string;
    address?: AgentAddress;
    notes?: string;
    profileUpdatedAt?: Date;
    lastLoginUserId?: string;
    status?: AgentStatus;
    createdAt?: Date;
    updatedAt?: Date;
  }): Agent {
    const now = new Date();
    return new Agent({
      agentId: opts.agentId,
      name: opts.name,
      tradeName: opts.tradeName,
      document: opts.document,
      documentType: opts.documentType,
      phone: opts.phone,
      mobile: opts.mobile,
      email: opts.email,
      street: opts.address?.street,
      number: opts.address?.number,
      district: opts.address?.district,
      postalCode: opts.address?.postalCode,
      city: opts.address?.city,
      state: opts.address?.state,
      notes: opts.notes,
      profileUpdatedAt: opts.profileUpdatedAt,
      lastLoginUserId: opts.lastLoginUserId,
      status: opts.status ?? "active",
      createdAt: opts.createdAt ?? now,
      updatedAt: opts.updatedAt ?? now,
    });
  }

  deactivate(): Agent {
    return new Agent({
      agentId: this.agentId,
      name: this.name,
      tradeName: this.tradeName,
      document: this.document,
      documentType: this.documentType,
      phone: this.phone,
      mobile: this.mobile,
      email: this.email,
      street: this.street,
      number: this.number,
      district: this.district,
      postalCode: this.postalCode,
      city: this.city,
      state: this.state,
      notes: this.notes,
      profileUpdatedAt: this.profileUpdatedAt,
      lastLoginUserId: this.lastLoginUserId,
      status: "inactive",
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }

  update(patch: {
    name?: string;
    tradeName?: string | null;
    document?: string | null;
    documentType?: AgentDocumentType | null;
    phone?: string | null;
    mobile?: string | null;
    email?: string | null;
    address?: AgentAddress | null;
    notes?: string | null;
    lastLoginUserId?: string | null;
    profileUpdatedAt?: Date | null;
  }): Agent {
    const patchAddress = patch.address;
    const addressCleared = patchAddress === null;
    const currentAddress = {
      street: this.street,
      number: this.number,
      district: this.district,
      postalCode: this.postalCode,
      city: this.city,
      state: this.state,
    };
    const nextAddress: AgentAddress = addressCleared
      ? {}
      : {
          ...currentAddress,
          ...(patchAddress ?? {}),
        };

    return new Agent({
      agentId: this.agentId,
      name: patch.name ?? this.name,
      tradeName: patch.tradeName === null ? undefined : (patch.tradeName ?? this.tradeName),
      document: patch.document === null ? undefined : (patch.document ?? this.document),
      documentType:
        patch.documentType === null ? undefined : (patch.documentType ?? this.documentType),
      phone: patch.phone === null ? undefined : (patch.phone ?? this.phone),
      mobile: patch.mobile === null ? undefined : (patch.mobile ?? this.mobile),
      email: patch.email === null ? undefined : (patch.email ?? this.email),
      street: nextAddress.street,
      number: nextAddress.number,
      district: nextAddress.district,
      postalCode: nextAddress.postalCode,
      city: nextAddress.city,
      state: nextAddress.state,
      notes: patch.notes === null ? undefined : (patch.notes ?? this.notes),
      lastLoginUserId:
        patch.lastLoginUserId === null
          ? undefined
          : (patch.lastLoginUserId ?? this.lastLoginUserId),
      profileUpdatedAt:
        patch.profileUpdatedAt === null
          ? undefined
          : (patch.profileUpdatedAt ?? this.profileUpdatedAt),
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: new Date(),
    });
  }
}
