import type { UserRole, UserStatus } from "../../domain/entities/user.entity";

export interface AuthUserDto {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

/** User snapshot returned after registration (pending approval). */
export interface RegisterPendingUserDto {
  readonly id: string;
  readonly email: string;
  /** E.164 when provided at signup */
  readonly celular?: string;
  readonly role: UserRole;
  readonly status: UserStatus;
}

export interface RegisterPendingResponseDto {
  readonly message: string;
  readonly user: RegisterPendingUserDto;
  /**
   * Omitted in production. Present in development/test so clients can complete approval in automation
   * (e2e) or local flows without database access.
   */
  readonly approvalToken?: string;
}

export interface RegistrationStatusResponseDto {
  readonly status: "pending" | "expired";
}

export interface AuthTokensDto {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface AuthResponseDto extends AuthTokensDto {
  readonly user: AuthUserDto;
}

export interface AgentAuthUserDto {
  readonly id: string;
  readonly email: string;
  readonly role: "agent";
  readonly agentId: string;
}

export interface AgentAuthResponseDto extends AuthTokensDto {
  readonly user: AgentAuthUserDto;
}

/** Profile from DB + JWT context (GET /auth/me). */
export interface MeUserResponseDto {
  readonly id: string;
  /** Same as id; kept for clients that expected the raw JWT payload shape on /me */
  readonly sub: string;
  readonly email: string;
  /** From JWT when present (e.g. agent), otherwise domain role */
  readonly role: string;
  readonly status: UserStatus;
  readonly celular?: string;
  /** Present when the access token was issued for agent socket access */
  readonly agentId?: string;
}
