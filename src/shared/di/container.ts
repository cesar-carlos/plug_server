import { AuthService } from "../../application/services/auth.service";
import { LoginUseCase } from "../../domain/use_cases/login.use_case";
import { LogoutUseCase } from "../../domain/use_cases/logout.use_case";
import { RefreshTokenUseCase } from "../../domain/use_cases/refresh_token.use_case";
import { RegisterUseCase } from "../../domain/use_cases/register.use_case";
import { BcryptPasswordHasher } from "../../infrastructure/adapters/bcrypt_password_hasher";
import { InMemoryRefreshTokenRepository } from "../../infrastructure/repositories/in_memory_refresh_token.repository";
import { InMemoryUserRepository } from "../../infrastructure/repositories/in_memory_user.repository";

const userRepository = new InMemoryUserRepository();
const refreshTokenRepository = new InMemoryRefreshTokenRepository();
const passwordHasher = new BcryptPasswordHasher();

const registerUseCase = new RegisterUseCase(userRepository);
const loginUseCase = new LoginUseCase(userRepository, passwordHasher);
const refreshTokenUseCase = new RefreshTokenUseCase(userRepository, refreshTokenRepository);
const logoutUseCase = new LogoutUseCase(refreshTokenRepository);

export const container = {
  authService: new AuthService(
    registerUseCase,
    loginUseCase,
    refreshTokenUseCase,
    logoutUseCase,
    passwordHasher,
    refreshTokenRepository,
  ),
};
