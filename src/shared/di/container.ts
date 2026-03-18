import { AuthService } from "../../application/services/auth.service";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import { ChangePasswordUseCase } from "../../domain/use_cases/change_password.use_case";
import { LoginUseCase } from "../../domain/use_cases/login.use_case";
import { LogoutUseCase } from "../../domain/use_cases/logout.use_case";
import { RefreshTokenUseCase } from "../../domain/use_cases/refresh_token.use_case";
import { RegisterUseCase } from "../../domain/use_cases/register.use_case";
import { BcryptPasswordHasher } from "../../infrastructure/adapters/bcrypt_password_hasher";
import { InMemoryAgentIdentityRepository } from "../../infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryRefreshTokenRepository } from "../../infrastructure/repositories/in_memory_refresh_token.repository";
import { InMemoryUserRepository } from "../../infrastructure/repositories/in_memory_user.repository";
import { PrismaAgentIdentityRepository } from "../../infrastructure/repositories/prisma_agent_identity.repository";
import { PrismaRefreshTokenRepository } from "../../infrastructure/repositories/prisma_refresh_token.repository";
import { PrismaUserRepository } from "../../infrastructure/repositories/prisma_user.repository";
import { env } from "../config/env";

const passwordHasher = new BcryptPasswordHasher();
const shouldUseInMemoryPersistence = env.nodeEnv === "test";

const userRepository: IUserRepository = shouldUseInMemoryPersistence
  ? new InMemoryUserRepository()
  : new PrismaUserRepository();
const refreshTokenRepository: IRefreshTokenRepository = shouldUseInMemoryPersistence
  ? new InMemoryRefreshTokenRepository()
  : new PrismaRefreshTokenRepository();
const agentIdentityRepository: IAgentIdentityRepository = shouldUseInMemoryPersistence
  ? new InMemoryAgentIdentityRepository()
  : new PrismaAgentIdentityRepository();

const registerUseCase = new RegisterUseCase(userRepository);
const loginUseCase = new LoginUseCase(userRepository, passwordHasher);
const changePasswordUseCase = new ChangePasswordUseCase(userRepository, passwordHasher);
const refreshTokenUseCase = new RefreshTokenUseCase(userRepository, refreshTokenRepository);
const logoutUseCase = new LogoutUseCase(refreshTokenRepository);

export const container = {
  authService: new AuthService(
    registerUseCase,
    loginUseCase,
    changePasswordUseCase,
    refreshTokenUseCase,
    logoutUseCase,
    passwordHasher,
    refreshTokenRepository,
    agentIdentityRepository,
  ),
};
