export interface ClientRefreshTokenProps {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;
}

export class ClientRefreshToken {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;

  constructor(props: ClientRefreshTokenProps) {
    this.id = props.id;
    this.clientId = props.clientId;
    this.expiresAt = props.expiresAt;
    if (props.revokedAt !== undefined) {
      this.revokedAt = props.revokedAt;
    }
    this.createdAt = props.createdAt;
  }

  get isRevoked(): boolean {
    return this.revokedAt !== undefined;
  }

  revoke(): ClientRefreshToken {
    return new ClientRefreshToken({ ...this, revokedAt: new Date() });
  }

  static create(props: {
    readonly id: string;
    readonly clientId: string;
    readonly expiresAt: Date;
    readonly createdAt?: Date;
  }): ClientRefreshToken {
    return new ClientRefreshToken({
      id: props.id,
      clientId: props.clientId,
      expiresAt: props.expiresAt,
      createdAt: props.createdAt ?? new Date(),
    });
  }
}
