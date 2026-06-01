import { AuthService } from "../../application/services/auth.service";
import { UserRegistrationService } from "../../application/services/user_registration.service";
import { UserAccountService } from "../../application/services/user_account.service";
import { AgentAccessService } from "../../application/services/agent_access.service";
import { AgentCatalogService } from "../../application/services/agent_catalog.service";
import { AgentProfileSyncService } from "../../application/services/agent_profile_sync.service";
import { AgentSelfProfileService } from "../../application/services/agent_self_profile.service";
import { AgentAutoUpdateDiagnosticsService } from "../../application/services/agent_auto_update_diagnostics.service";
import { ClientAgentAccessQueryService } from "../../application/services/client_agent_access_query.service";
import { ClientAgentAccessRequestService } from "../../application/services/client_agent_access_request.service";
import { ClientAgentAccessDecisionService } from "../../application/services/client_agent_access_decision.service";
import { ClientAgentTokenService } from "../../application/services/client_agent_token.service";
import type { ClientAgentLiveProfileDeps } from "../../application/services/agent_snapshot_refresher";
import {
  invalidateConsumerAgentAccessSnapshotsByAgentId,
  invalidateConsumerClientAgentAccessSnapshots,
} from "../../application/services/consumer_socket_control_sink";
import { ClientAuthService } from "../../application/services/client_auth.service";
import { ClientRegistrationService } from "../../application/services/client_registration.service";
import { ClientProfileService } from "../../application/services/client_profile.service";
import { ClientManagementService } from "../../application/services/client_management.service";
import { ClientPasswordRecoveryService } from "../../application/services/client_password_recovery.service";
import { HealthReadinessService } from "../../application/services/health_readiness.service";
import { UserAgentService } from "../../application/services/user_agent.service";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import type { IClientAgentAccessApprovalTokenRepository } from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";
import type { IClientPasswordRecoveryTokenRepository } from "../../domain/repositories/client_password_recovery_token.repository.interface";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IClientRegistrationApprovalTokenRepository } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { IPendingClientAgentAccessWriter } from "../../domain/ports/pending_client_agent_access_writer.port";
import type { IClientAgentAccessApprovalTxn } from "../../domain/ports/client_agent_access_approval_txn.port";
import type { IClientRegistrationDecisionTxn } from "../../domain/ports/client_registration_decision_txn.port";
import type { IRegistrationDecisionTxn } from "../../domain/ports/registration_decision_txn.port";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
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
import { AdminSetUserStatusUseCase } from "../../domain/use_cases/admin_set_user_status.use_case";
import { UpdateMyCelularUseCase } from "../../domain/use_cases/update_my_celular.use_case";
import { BcryptPasswordHasher } from "../../infrastructure/adapters/bcrypt_password_hasher";
import { LocalFileStorage } from "../../infrastructure/adapters/local_file_storage";
import { NoopEmailSender } from "../../infrastructure/adapters/noop_email_sender";
import { NodemailerEmailSender } from "../../infrastructure/adapters/nodemailer_email_sender";
import { InMemoryAgentIdentityRepository } from "../../infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../infrastructure/repositories/in_memory_agent.repository";
import { InMemoryAgentAutoUpdateDiagnosticsRepository } from "../../infrastructure/repositories/in_memory_agent_auto_update_diagnostics.repository";
import { InMemoryClientAgentAccessApprovalTokenRepository } from "../../infrastructure/repositories/in_memory_client_agent_access_approval_token.repository";
import { InMemoryClientAgentAccessRepository } from "../../infrastructure/repositories/in_memory_client_agent_access.repository";
import { InMemoryClientAgentAccessRequestRepository } from "../../infrastructure/repositories/in_memory_client_agent_access_request.repository";
import { InMemoryClientPasswordRecoveryTokenRepository } from "../../infrastructure/repositories/in_memory_client_password_recovery_token.repository";
import { InMemoryClientRefreshTokenRepository } from "../../infrastructure/repositories/in_memory_client_refresh_token.repository";
import { InMemoryClientRegistrationApprovalTokenRepository } from "../../infrastructure/repositories/in_memory_client_registration_approval_token.repository";
import { InMemoryClientRepository } from "../../infrastructure/repositories/in_memory_client.repository";
import { InMemoryRefreshTokenRepository } from "../../infrastructure/repositories/in_memory_refresh_token.repository";
import { InMemoryRegistrationApprovalTokenRepository } from "../../infrastructure/repositories/in_memory_registration_approval_token.repository";
import { InMemoryUserRepository } from "../../infrastructure/repositories/in_memory_user.repository";
import { PrismaAgentIdentityRepository } from "../../infrastructure/repositories/prisma_agent_identity.repository";
import { PrismaAgentRepository } from "../../infrastructure/repositories/prisma_agent.repository";
import { PrismaAgentAutoUpdateDiagnosticsRepository } from "../../infrastructure/repositories/prisma_agent_auto_update_diagnostics.repository";
import { PrismaClientAgentAccessApprovalTokenRepository } from "../../infrastructure/repositories/prisma_client_agent_access_approval_token.repository";
import { PrismaClientAgentAccessRepository } from "../../infrastructure/repositories/prisma_client_agent_access.repository";
import { PrismaClientAgentAccessRequestRepository } from "../../infrastructure/repositories/prisma_client_agent_access_request.repository";
import { PrismaClientPasswordRecoveryTokenRepository } from "../../infrastructure/repositories/prisma_client_password_recovery_token.repository";
import { PrismaClientRefreshTokenRepository } from "../../infrastructure/repositories/prisma_client_refresh_token.repository";
import { PrismaClientRegistrationApprovalTokenRepository } from "../../infrastructure/repositories/prisma_client_registration_approval_token.repository";
import { PrismaClientRepository } from "../../infrastructure/repositories/prisma_client.repository";
import { PrismaDatabaseReadinessProbe } from "../../infrastructure/database/prisma/prisma_database_readiness_probe";
import { PrismaRefreshTokenRepository } from "../../infrastructure/repositories/prisma_refresh_token.repository";
import { PrismaRegistrationApprovalTokenRepository } from "../../infrastructure/repositories/prisma_registration_approval_token.repository";
import { PrismaUserRepository } from "../../infrastructure/repositories/prisma_user.repository";
import { PrismaPendingClientAgentAccessWriter } from "../../infrastructure/persistence/prisma_pending_client_agent_access.writer";
import { PrismaClientAgentAccessApprovalTxn } from "../../infrastructure/persistence/prisma_client_agent_access_approval_txn";
import { InMemoryClientAgentAccessApprovalTxn } from "../../infrastructure/persistence/in_memory_client_agent_access_approval_txn";
import { InMemoryClientRegistrationDecisionTxn } from "../../infrastructure/persistence/in_memory_client_registration_decision_txn";
import { InMemoryRegistrationDecisionTxn } from "../../infrastructure/persistence/in_memory_registration_decision_txn";
import { PrismaClientRegistrationDecisionTxn } from "../../infrastructure/persistence/prisma_client_registration_decision_txn";
import { PrismaRegistrationDecisionTxn } from "../../infrastructure/persistence/prisma_registration_decision_txn";
import { SequentialPendingClientAgentAccessWriter } from "../../infrastructure/persistence/sequential_pending_client_agent_access.writer";
import { RestAgentBridgeService } from "../../application/services/rest_agent_bridge.service";
import {
  agentsHubDiagnosticsAdapter,
  connectedAgentsRegistryAdapter,
} from "../../presentation/adapters/rest_agent_bridge.adapters";
import { createSocketMetricsSnapshotProvider } from "../../presentation/adapters/socket_metrics_snapshot.adapter";
import {
  isAgentConnectedToHub,
  resolveClusterHubConnectedAgentIds,
} from "../../presentation/socket/hub/agent_hub_connection";
import { dispatchRpcCommandToAgent } from "../../presentation/socket/hub/relay/rpc_bridge";
import { env } from "../config/env";

const passwordHasher = new BcryptPasswordHasher();
const shouldUseInMemoryPersistence = env.persistenceMode === "memory";
const shouldUseNoopEmailSender = env.emailSenderMode === "noop";

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
const agentAutoUpdateDiagnosticsRepository = shouldUseInMemoryPersistence
  ? new InMemoryAgentAutoUpdateDiagnosticsRepository()
  : new PrismaAgentAutoUpdateDiagnosticsRepository();
const registrationApprovalTokenRepository = shouldUseInMemoryPersistence
  ? new InMemoryRegistrationApprovalTokenRepository()
  : new PrismaRegistrationApprovalTokenRepository();
const clientRepository: IClientRepository = shouldUseInMemoryPersistence
  ? new InMemoryClientRepository()
  : new PrismaClientRepository();
const clientRefreshTokenRepository: IClientRefreshTokenRepository = shouldUseInMemoryPersistence
  ? new InMemoryClientRefreshTokenRepository()
  : new PrismaClientRefreshTokenRepository();
const clientPasswordRecoveryTokenRepository: IClientPasswordRecoveryTokenRepository =
  shouldUseInMemoryPersistence
    ? new InMemoryClientPasswordRecoveryTokenRepository()
    : new PrismaClientPasswordRecoveryTokenRepository();
const clientRegistrationApprovalTokenRepository: IClientRegistrationApprovalTokenRepository =
  shouldUseInMemoryPersistence
    ? new InMemoryClientRegistrationApprovalTokenRepository()
    : new PrismaClientRegistrationApprovalTokenRepository();
const clientAgentAccessRepository: IClientAgentAccessRepository = shouldUseInMemoryPersistence
  ? new InMemoryClientAgentAccessRepository()
  : new PrismaClientAgentAccessRepository();
const clientAgentAccessRequestRepository: IClientAgentAccessRequestRepository =
  shouldUseInMemoryPersistence
    ? new InMemoryClientAgentAccessRequestRepository()
    : new PrismaClientAgentAccessRequestRepository();
const clientAgentAccessApprovalTokenRepository: IClientAgentAccessApprovalTokenRepository =
  shouldUseInMemoryPersistence
    ? new InMemoryClientAgentAccessApprovalTokenRepository()
    : new PrismaClientAgentAccessApprovalTokenRepository();

const pendingClientAgentAccessWriter: IPendingClientAgentAccessWriter = shouldUseInMemoryPersistence
  ? new SequentialPendingClientAgentAccessWriter(
      clientAgentAccessRequestRepository,
      clientAgentAccessApprovalTokenRepository,
    )
  : new PrismaPendingClientAgentAccessWriter();

const clientAgentAccessApprovalTxn: IClientAgentAccessApprovalTxn = shouldUseInMemoryPersistence
  ? new InMemoryClientAgentAccessApprovalTxn(
      clientAgentAccessRequestRepository as InMemoryClientAgentAccessRequestRepository,
      clientAgentAccessRepository as InMemoryClientAgentAccessRepository,
      clientAgentAccessApprovalTokenRepository as InMemoryClientAgentAccessApprovalTokenRepository,
    )
  : new PrismaClientAgentAccessApprovalTxn();

const registrationDecisionTxn: IRegistrationDecisionTxn = shouldUseInMemoryPersistence
  ? new InMemoryRegistrationDecisionTxn(registrationApprovalTokenRepository, userRepository)
  : new PrismaRegistrationDecisionTxn();

const clientRegistrationDecisionTxn: IClientRegistrationDecisionTxn = shouldUseInMemoryPersistence
  ? new InMemoryClientRegistrationDecisionTxn(
      clientRegistrationApprovalTokenRepository,
      clientRepository,
    )
  : new PrismaClientRegistrationDecisionTxn();

const emailSender = shouldUseNoopEmailSender
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
const fileStorage = new LocalFileStorage({
  uploadsDir: env.uploadsDir,
  uploadsPublicBaseUrl: env.uploadsPublicBaseUrl,
  clientThumbnailWidth: env.clientThumbnailWidth,
  clientThumbnailHeight: env.clientThumbnailHeight,
  clientThumbnailWebpQuality: env.clientThumbnailWebpQuality,
});
const healthReadinessService = new HealthReadinessService(new PrismaDatabaseReadinessProbe(), {
  databaseTimeoutMs: 1_500,
  skipDatabaseProbe: env.nodeEnv === "test",
});

const registerUseCase = new RegisterUseCase(userRepository, registrationApprovalTokenRepository);
const approveRegistrationUseCase = new ApproveRegistrationUseCase(registrationDecisionTxn);
const rejectRegistrationUseCase = new RejectRegistrationUseCase(registrationDecisionTxn);
const getRegistrationStatusUseCase = new GetRegistrationStatusUseCase(
  registrationApprovalTokenRepository,
);
const loginUseCase = new LoginUseCase(userRepository, passwordHasher);
const changePasswordUseCase = new ChangePasswordUseCase(userRepository, passwordHasher);
const refreshTokenUseCase = new RefreshTokenUseCase(userRepository, refreshTokenRepository);
const logoutUseCase = new LogoutUseCase(refreshTokenRepository);
const adminSetUserStatusUseCase = new AdminSetUserStatusUseCase(
  userRepository,
  refreshTokenRepository,
);
const updateMyCelularUseCase = new UpdateMyCelularUseCase(userRepository);

const agentAccessService = new AgentAccessService(
  agentRepository,
  agentIdentityRepository,
  clientAgentAccessRepository,
);
const agentCatalogService = new AgentCatalogService(agentRepository, {
  onAgentDeactivated: (agentId) => {
    agentAccessService.invalidateAccessCacheForAgent(agentId);
    void invalidateConsumerAgentAccessSnapshotsByAgentId({ agentId });
  },
});
const agentSelfProfileService = new AgentSelfProfileService(agentRepository);
const agentProfileSyncService = new AgentProfileSyncService(agentSelfProfileService);
const agentAutoUpdateDiagnosticsService = new AgentAutoUpdateDiagnosticsService(
  agentAutoUpdateDiagnosticsRepository,
);
const userAgentService = new UserAgentService(agentRepository, agentIdentityRepository);
const clientAuthService = new ClientAuthService(
  clientRepository,
  clientRefreshTokenRepository,
  clientPasswordRecoveryTokenRepository,
  passwordHasher,
);
const clientRegistrationService = new ClientRegistrationService(
  clientRepository,
  clientRegistrationApprovalTokenRepository,
  clientRegistrationDecisionTxn,
  userRepository,
  passwordHasher,
  emailSender,
);
const clientProfileService = new ClientProfileService(
  clientRepository,
  fileStorage,
  clientAuthService,
);
const clientManagementService = new ClientManagementService(
  userRepository,
  clientRepository,
  clientRefreshTokenRepository,
  clientAuthService,
);
const clientPasswordRecoveryService = new ClientPasswordRecoveryService(
  clientRepository,
  clientPasswordRecoveryTokenRepository,
  clientRefreshTokenRepository,
  passwordHasher,
  emailSender,
  clientAuthService,
);
const restAgentBridgeService = new RestAgentBridgeService(
  connectedAgentsRegistryAdapter,
  agentsHubDiagnosticsAdapter,
  dispatchRpcCommandToAgent,
);
restAgentBridgeService.isAgentConnectedCluster = isAgentConnectedToHub;
restAgentBridgeService.resolveClusterConnectedAgentIds = resolveClusterHubConnectedAgentIds;
const socketMetricsSnapshotProvider = createSocketMetricsSnapshotProvider();

const clientAgentLiveProfileDeps: ClientAgentLiveProfileDeps = {
  isAgentOnline: isAgentConnectedToHub,
  refreshAgentProfile: (agentId) =>
    agentProfileSyncService.syncFromConnectedAgent({
      agentId,
      dispatch: dispatchRpcCommandToAgent,
      timeoutMs: 10_000,
    }),
  onAccessRevoked: (clientId, agentId) => {
    agentAccessService.invalidateAccessCache("client", clientId, agentId);
    void invalidateConsumerClientAgentAccessSnapshots({ clientId, agentId });
  },
};

const clientAgentAccessQueryService = new ClientAgentAccessQueryService(
  agentRepository,
  clientRepository,
  clientAgentAccessRepository,
  clientAgentAccessRequestRepository,
  clientAgentLiveProfileDeps,
);

const clientAgentAccessRequestService = new ClientAgentAccessRequestService(
  agentRepository,
  agentIdentityRepository,
  clientRepository,
  userRepository,
  clientAgentAccessRepository,
  clientAgentAccessRequestRepository,
  clientAgentAccessApprovalTokenRepository,
  emailSender,
  pendingClientAgentAccessWriter,
  clientAgentLiveProfileDeps,
);

const clientAgentAccessDecisionService = new ClientAgentAccessDecisionService(
  agentRepository,
  agentIdentityRepository,
  clientRepository,
  clientAgentAccessRepository,
  clientAgentAccessRequestRepository,
  clientAgentAccessApprovalTokenRepository,
  emailSender,
  clientAgentAccessApprovalTxn,
  clientAgentLiveProfileDeps,
);

const clientAgentTokenService = new ClientAgentTokenService(clientAgentAccessRepository);

const authService = new AuthService(
  loginUseCase,
  changePasswordUseCase,
  refreshTokenUseCase,
  logoutUseCase,
  refreshTokenRepository,
  userRepository,
  agentAccessService,
);
const userRegistrationService = new UserRegistrationService(
  registerUseCase,
  approveRegistrationUseCase,
  rejectRegistrationUseCase,
  getRegistrationStatusUseCase,
  registrationApprovalTokenRepository,
  userRepository,
  passwordHasher,
  emailSender,
);
const userAccountService = new UserAccountService(
  adminSetUserStatusUseCase,
  updateMyCelularUseCase,
  agentAccessService,
  authService,
);

export const container = {
  authService,
  userRegistrationService,
  userAccountService,
  emailSender,
  agentAccessService,
  agentCatalogService,
  agentSelfProfileService,
  agentProfileSyncService,
  agentAutoUpdateDiagnosticsService,
  userAgentService,
  clientAuthService,
  clientRegistrationService,
  clientProfileService,
  clientManagementService,
  clientPasswordRecoveryService,
  clientAgentAccessQueryService,
  clientAgentAccessRequestService,
  clientAgentAccessDecisionService,
  clientAgentTokenService,
  healthReadinessService,
  isAgentConnectedToHub,
  restAgentBridgeService,
  socketMetricsSnapshotProvider,
};

export const getTestRepositoryAccess = (): {
  readonly user: IUserRepository;
  readonly agentIdentity: IAgentIdentityRepository;
  readonly agent: IAgentRepository;
  readonly agentAutoUpdateDiagnostics: typeof agentAutoUpdateDiagnosticsRepository;
  readonly client: IClientRepository;
  readonly clientAgentAccess: IClientAgentAccessRepository;
  readonly clientAgentAccessRequest: IClientAgentAccessRequestRepository;
  readonly clientAgentAccessApprovalToken: IClientAgentAccessApprovalTokenRepository;
  readonly registrationApprovalToken: typeof registrationApprovalTokenRepository;
  readonly clientRegistrationApprovalToken: IClientRegistrationApprovalTokenRepository;
  readonly clientPasswordRecoveryToken: IClientPasswordRecoveryTokenRepository;
} => {
  if (env.nodeEnv !== "test") {
    throw new Error("getTestRepositoryAccess is only available in test environment");
  }

  return {
    user: userRepository,
    agentIdentity: agentIdentityRepository,
    agent: agentRepository,
    agentAutoUpdateDiagnostics: agentAutoUpdateDiagnosticsRepository,
    client: clientRepository,
    clientAgentAccess: clientAgentAccessRepository,
    clientAgentAccessRequest: clientAgentAccessRequestRepository,
    clientAgentAccessApprovalToken: clientAgentAccessApprovalTokenRepository,
    registrationApprovalToken: registrationApprovalTokenRepository,
    clientRegistrationApprovalToken: clientRegistrationApprovalTokenRepository,
    clientPasswordRecoveryToken: clientPasswordRecoveryTokenRepository,
  };
};

export const getTestNoopEmailSender = (): NoopEmailSender => {
  if (env.nodeEnv !== "test" || !(emailSender instanceof NoopEmailSender)) {
    throw new Error(
      "getTestNoopEmailSender is only available with NoopEmailSender in test environment",
    );
  }

  return emailSender;
};
