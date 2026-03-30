import { AuthService } from "../../application/services/auth.service";
import { AgentAccessService } from "../../application/services/agent_access.service";
import { AgentCatalogService } from "../../application/services/agent_catalog.service";
import { UserAgentService } from "../../application/services/user_agent.service";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import { ApproveRegistrationUseCase } from "../../domain/use_cases/approve_registration.use_case";
import { ChangePasswordUseCase } from "../../domain/use_cases/change_password.use_case";
import { GetRegistrationStatusUseCase } from "../../domain/use_cases/get_registration_status.use_case";
import { LoginUseCase } from "../../domain/use_cases/login.use_case";
import { LogoutUseCase } from "../../domain/use_cases/logout.use_case";
import { RefreshTokenUseCase } from "../../domain/use_cases/refresh_token.use_case";
import { RegisterUseCase } from "../../domain/use_cases/register.use_case";
import { RejectRegistrationUseCase } from "../../domain/use_cases/reject_registration.use_case";
import { BcryptPasswordHasher } from "../../infrastructure/adapters/bcrypt_password_hasher";
import { NoopEmailSender } from "../../infrastructure/adapters/noop_email_sender";
import { NodemailerEmailSender } from "../../infrastructure/adapters/nodemailer_email_sender";
import { InMemoryAgentIdentityRepository } from "../../infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../infrastructure/repositories/in_memory_agent.repository";
import { InMemoryRefreshTokenRepository } from "../../infrastructure/repositories/in_memory_refresh_token.repository";
import { InMemoryRegistrationApprovalTokenRepository } from "../../infrastructure/repositories/in_memory_registration_approval_token.repository";
import { InMemoryUserRepository } from "../../infrastructure/repositories/in_memory_user.repository";
import { PrismaAgentIdentityRepository } from "../../infrastructure/repositories/prisma_agent_identity.repository";
import { PrismaAgentRepository } from "../../infrastructure/repositories/prisma_agent.repository";
import { PrismaRefreshTokenRepository } from "../../infrastructure/repositories/prisma_refresh_token.repository";
import { PrismaRegistrationApprovalTokenRepository } from "../../infrastructure/repositories/prisma_registration_approval_token.repository";
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
const agentRepository: IAgentRepository = shouldUseInMemoryPersistence
  ? new InMemoryAgentRepository()
  : new PrismaAgentRepository();
const registrationApprovalTokenRepository = shouldUseInMemoryPersistence
  ? new InMemoryRegistrationApprovalTokenRepository()
  : new PrismaRegistrationApprovalTokenRepository();

const emailSender = shouldUseInMemoryPersistence
  ? new NoopEmailSender()
  : new NodemailerEmailSender({
      appName: env.appName,
      appBaseUrl: env.appBaseUrl,
      adminEmail: env.adminEmail,
      smtpHost: env.smtpHost,
      smtpPort: env.smtpPort,
      smtpUser: env.smtpUser,
      smtpPass: env.smtpPass,
      smtpFrom: env.smtpFrom,
    });

const registerUseCase = new RegisterUseCase(userRepository, registrationApprovalTokenRepository);
const approveRegistrationUseCase = new ApproveRegistrationUseCase(
  registrationApprovalTokenRepository,
  userRepository,
);
const rejectRegistrationUseCase = new RejectRegistrationUseCase(
  registrationApprovalTokenRepository,
  userRepository,
);
const getRegistrationStatusUseCase = new GetRegistrationStatusUseCase(
  registrationApprovalTokenRepository,
);
const loginUseCase = new LoginUseCase(userRepository, passwordHasher);
const changePasswordUseCase = new ChangePasswordUseCase(userRepository, passwordHasher);
const refreshTokenUseCase = new RefreshTokenUseCase(userRepository, refreshTokenRepository);
const logoutUseCase = new LogoutUseCase(refreshTokenRepository);

const agentAccessService = new AgentAccessService(agentRepository, agentIdentityRepository);
const agentCatalogService = new AgentCatalogService(agentRepository);
const userAgentService = new UserAgentService(agentRepository, agentIdentityRepository);

export const container = {
  authService: new AuthService(
    registerUseCase,
    loginUseCase,
    changePasswordUseCase,
    refreshTokenUseCase,
    logoutUseCase,
    approveRegistrationUseCase,
    rejectRegistrationUseCase,
    getRegistrationStatusUseCase,
    passwordHasher,
    refreshTokenRepository,
    agentAccessService,
    emailSender,
  ),
  emailSender,
  agentAccessService,
  agentCatalogService,
  userAgentService,
};

export const getTestRepositoryAccess = (): {
  readonly user: IUserRepository;
  readonly agentIdentity: IAgentIdentityRepository;
  readonly agent: IAgentRepository;
} => {
  if (env.nodeEnv !== "test") {
    throw new Error("getTestRepositoryAccess is only available in test environment");
  }

  return {
    user: userRepository,
    agentIdentity: agentIdentityRepository,
    agent: agentRepository,
  };
};
