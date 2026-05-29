import type { User } from "../../domain/entities/user.entity";
import type {
  AdminSetUserStatusInput,
  AdminSetUserStatusUseCase,
} from "../../domain/use_cases/admin_set_user_status.use_case";
import type { UpdateMyCelularUseCase } from "../../domain/use_cases/update_my_celular.use_case";
import type { AgentAccessService } from "./agent_access.service";
import type { AuthService } from "./auth.service";
import { disconnectAgentPrincipalSockets } from "./agent_socket_control_sink";
import {
  disconnectConsumerPrincipalSockets,
  invalidateConsumerUserAccessSnapshots,
} from "./consumer_socket_control_sink";
import type { Result } from "../../shared/errors/result";
import type { JwtAccessPayload } from "../../shared/utils/jwt";
import type { MeUserResponseDto } from "../dtos/auth.dto";

/**
 * Admin/account-level mutations for users. `adminSetUserStatus` is the
 * single place that enforces the immediate consequences of blocking an
 * account (snapshot eviction, agent-access cache invalidation, live
 * socket disconnection on both namespaces). `updateMyCelular` is the
 * authenticated user's profile-edit shortcut.
 */
export class UserAccountService {
  constructor(
    private readonly adminSetUserStatusUseCase: AdminSetUserStatusUseCase,
    private readonly updateMyCelularUseCase: UpdateMyCelularUseCase,
    private readonly agentAccessService: AgentAccessService,
    private readonly authService: Pick<
      AuthService,
      "getMeProfile" | "invalidateSnapshotCache"
    >,
  ) {}

  async adminSetUserStatus(input: AdminSetUserStatusInput): Promise<Result<User>> {
    const result = await this.adminSetUserStatusUseCase.execute(input);
    if (result.ok && input.status === "blocked") {
      const userId = result.value.id;
      this.authService.invalidateSnapshotCache(userId);
      this.agentAccessService.invalidateAccessCacheForUser(userId);
      await Promise.all([
        disconnectConsumerPrincipalSockets({
          principalType: "user",
          principalId: userId,
          reason: "account_blocked",
        }),
        disconnectAgentPrincipalSockets({
          userId,
          reason: "account_blocked",
        }),
        invalidateConsumerUserAccessSnapshots({ userId }),
      ]);
    }
    return result;
  }

  async updateMyCelular(
    jwtUser: JwtAccessPayload,
    input: { celular: string | null },
  ): Promise<Result<MeUserResponseDto>> {
    const result = await this.updateMyCelularUseCase.execute({
      userId: jwtUser.sub,
      celular: input.celular,
    });
    if (!result.ok) {
      return result;
    }
    return this.authService.getMeProfile(jwtUser, result.value);
  }
}
