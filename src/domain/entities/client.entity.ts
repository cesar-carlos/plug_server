export type ClientStatus = "pending" | "active" | "blocked";

export interface ClientProps {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile?: string;
  readonly thumbnailUrl?: string;
  readonly credentialsUpdatedAt: Date;
  readonly status: ClientStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Client {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile?: string;
  readonly thumbnailUrl?: string;
  readonly credentialsUpdatedAt: Date;
  readonly status: ClientStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: ClientProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.email = props.email;
    this.passwordHash = props.passwordHash;
    this.name = props.name;
    this.lastName = props.lastName;
    if (props.mobile !== undefined) {
      this.mobile = props.mobile;
    }
    if (props.thumbnailUrl !== undefined) {
      this.thumbnailUrl = props.thumbnailUrl;
    }
    this.credentialsUpdatedAt = props.credentialsUpdatedAt;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(
    props: Omit<ClientProps, "id" | "status" | "createdAt" | "updatedAt" | "credentialsUpdatedAt"> & {
      id?: string;
      status?: ClientStatus;
      createdAt?: Date;
      updatedAt?: Date;
      credentialsUpdatedAt?: Date;
    },
  ): Client {
    const now = new Date();
    return new Client({
      id: props.id ?? crypto.randomUUID(),
      userId: props.userId,
      email: props.email,
      passwordHash: props.passwordHash,
      name: props.name,
      lastName: props.lastName,
      ...(props.mobile !== undefined ? { mobile: props.mobile } : {}),
      ...(props.thumbnailUrl !== undefined ? { thumbnailUrl: props.thumbnailUrl } : {}),
      credentialsUpdatedAt: props.credentialsUpdatedAt ?? now,
      status: props.status ?? "pending",
      createdAt: props.createdAt ?? now,
      updatedAt: props.updatedAt ?? now,
    });
  }

  withPasswordHash(passwordHash: string): Client {
    return new Client({
      ...this,
      passwordHash,
      updatedAt: new Date(),
    });
  }
}
