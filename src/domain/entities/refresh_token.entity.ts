export interface RefreshTokenProps {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;
}

export class RefreshToken {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;

  constructor(props: RefreshTokenProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.expiresAt = props.expiresAt;
    if (props.revokedAt !== undefined) {
      this.revokedAt = props.revokedAt;
    }
    this.createdAt = props.createdAt;
  }

  get isRevoked(): boolean {
    return this.revokedAt !== undefined;
  }

  get isExpired(): boolean {
    return this.expiresAt < new Date();
  }

  get isValid(): boolean {
    return !this.isRevoked && !this.isExpired;
  }

  revoke(): RefreshToken {
    return new RefreshToken({ ...this, revokedAt: new Date() });
  }

  static create(props: {
    id: string;
    userId: string;
    expiresAt: Date;
    createdAt?: Date;
  }): RefreshToken {
    return new RefreshToken({
      id: props.id,
      userId: props.userId,
      expiresAt: props.expiresAt,
      createdAt: props.createdAt ?? new Date(),
    });
  }
}
