export type ClientStatus = "active" | "blocked";

export interface ClientProps {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile?: string;
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
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(
    props: Omit<ClientProps, "id" | "status" | "createdAt" | "updatedAt"> & {
      id?: string;
      status?: ClientStatus;
      createdAt?: Date;
      updatedAt?: Date;
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
      status: props.status ?? "active",
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
