import type { ClientStatus } from "../../domain/entities/client.entity";

export interface ClientAuthUserDto {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile?: string;
  readonly thumbnailUrl?: string;
  readonly status: ClientStatus;
  readonly role: "client";
}

export interface ClientAuthTokensDto {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface ClientAuthResponseDto extends ClientAuthTokensDto {
  readonly client: ClientAuthUserDto;
}

export interface ClientRegistrationRequestResponseDto {
  readonly message: string;
  readonly client?: ClientAuthUserDto;
  readonly registrationPollToken?: string;
  /** Dev/test only — owner email approval link; never returned in production. */
  readonly approvalToken?: string;
  readonly duplicate?: boolean;
}

/** `GET /client-auth/registration/status` — reflects client row via poll token. */
export type ClientRegistrationPollStatus =
  | "pending"
  | "expired"
  | "approved"
  | "rejected"
  | "blocked"
  | "unknown";
