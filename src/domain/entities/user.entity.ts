export type UserRole = "user" | "admin";

export type UserStatus = "pending" | "active" | "rejected";

export interface UserProps {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export class User {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;

  constructor(props: UserProps) {
    this.id = props.id;
    this.email = props.email;
    this.passwordHash = props.passwordHash;
    this.role = props.role;
    this.status = props.status;
    this.createdAt = props.createdAt;
  }

  static create(
    props: Omit<UserProps, "id" | "createdAt" | "status"> & {
      id?: string;
      createdAt?: Date;
      status?: UserStatus;
    },
  ): User {
    return new User({
      id: props.id ?? crypto.randomUUID(),
      email: props.email,
      passwordHash: props.passwordHash,
      role: props.role,
      status: props.status ?? "pending",
      createdAt: props.createdAt ?? new Date(),
    });
  }
}
