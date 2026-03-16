import type { UserRole } from "../../domain/entities/user.entity";

export interface AuthUserDto {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface AuthTokensDto {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface AuthResponseDto extends AuthTokensDto {
  readonly user: AuthUserDto;
}
