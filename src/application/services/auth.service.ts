import { v4 as uuidv4 } from "uuid";

import { RefreshToken } from "../../domain/entities/refresh_token.entity";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type { User } from "../../domain/entities/user.entity";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";
import type { ChangePasswordUseCase } from "../../domain/use_cases/change_password.use_case";
import type { LoginUseCase } from "../../domain/use_cases/login.use_case";
import type { LogoutUseCase } from "../../domain/use_cases/logout.use_case";
import type { RefreshTokenUseCase } from "../../domain/use_cases/refresh_token.use_case";
import type { RegisterUseCase } from "../../domain/use_cases/register.use_case";
import { env } from "../../shared/config/env";
import { type Result, ok } from "../../shared/errors/result";
import { parseExpiryToDate } from "../../shared/utils/date";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../shared/utils/jwt";
import type { AuthResponseDto, AuthTokensDto, AuthUserDto } from "../dtos/auth.dto";

export interface RegisterServiceInput {
  readonly email: string;
  readonly password: string;
}

export interface LoginServiceInput {
  readonly email: string;
  readonly password: string;
}

export interface ChangePasswordServiceInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export class AuthService {
  constructor(
    private readonly registerUseCase: RegisterUseCase,
    private readonly loginUseCase: LoginUseCase,
    private readonly changePasswordUseCase: ChangePasswordUseCase,
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly passwordHasher: IPasswordHasher,
    private readonly refreshTokenRepository: IRefreshTokenRepository,
  ) {}

  async register(input: RegisterServiceInput): Promise<Result<AuthResponseDto>> {
    const passwordHash = await this.passwordHasher.hash(input.password);

    const result = await this.registerUseCase.execute({ email: input.email, passwordHash });
    if (!result.ok) return result;

    const tokens = await this.issueTokens(result.value);
    return ok({ user: this.toUserDto(result.value), ...tokens });
  }

  async login(input: LoginServiceInput): Promise<Result<AuthResponseDto>> {
    const result = await this.loginUseCase.execute({
      email: input.email,
      plainPassword: input.password,
    });
    if (!result.ok) return result;

    const tokens = await this.issueTokens(result.value);
    return ok({ user: this.toUserDto(result.value), ...tokens });
  }

  async changePassword(input: ChangePasswordServiceInput): Promise<Result<void>> {
    return this.changePasswordUseCase.execute(input);
  }

  async refresh(rawRefreshToken: string): Promise<Result<AuthTokensDto>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);
    if (!verifyResult.ok) return verifyResult;

    const { sub: userId, jti: tokenId } = verifyResult.value;

    const result = await this.refreshTokenUseCase.execute({ tokenId, userId });
    if (!result.ok) return result;

    return ok(await this.issueTokens(result.value));
  }

  async logout(rawRefreshToken: string): Promise<Result<void>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);

    if (!verifyResult.ok) {
      // Silently succeed — an invalid token is already effectively logged out
      return ok(undefined);
    }

    return this.logoutUseCase.execute(verifyResult.value.jti);
  }

  private async issueTokens(user: User): Promise<AuthTokensDto> {
    const jti = uuidv4();
    const expiresAt = parseExpiryToDate(env.jwtRefreshExpiresIn);

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenType: "access",
    });
    const refreshToken = signRefreshToken({ sub: user.id, jti, tokenType: "refresh" });

    await this.refreshTokenRepository.save(
      RefreshToken.create({ id: jti, userId: user.id, expiresAt }),
    );

    return { accessToken, refreshToken };
  }

  private toUserDto(user: User): AuthUserDto {
    return { id: user.id, email: user.email, role: user.role };
  }
}
