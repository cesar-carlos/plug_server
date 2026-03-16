export type UserRole = "user" | "admin";

export interface UserProps {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly createdAt: Date;
}

export class User {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly createdAt: Date;

  constructor(props: UserProps) {
    this.id = props.id;
    this.email = props.email;
    this.passwordHash = props.passwordHash;
    this.role = props.role;
    this.createdAt = props.createdAt;
  }

  static create(props: Omit<UserProps, "id" | "createdAt"> & { id?: string; createdAt?: Date }): User {
    return new User({
      id: props.id ?? crypto.randomUUID(),
      email: props.email,
      passwordHash: props.passwordHash,
      role: props.role,
      createdAt: props.createdAt ?? new Date(),
    });
  }
}
