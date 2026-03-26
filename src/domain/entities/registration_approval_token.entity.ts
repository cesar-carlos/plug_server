export interface RegistrationApprovalTokenProps {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export class RegistrationApprovalToken {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;

  constructor(props: RegistrationApprovalTokenProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt;
  }

  static create(
    props: {
      readonly id: string;
      readonly userId: string;
      readonly expiresAt: Date;
      readonly createdAt?: Date;
    },
  ): RegistrationApprovalToken {
    return new RegistrationApprovalToken({
      id: props.id,
      userId: props.userId,
      expiresAt: props.expiresAt,
      createdAt: props.createdAt ?? new Date(),
    });
  }
}
