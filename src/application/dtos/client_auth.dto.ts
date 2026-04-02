import type { ClientStatus } from "../../domain/entities/client.entity";

export interface ClientAuthUserDto {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile?: string;
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
