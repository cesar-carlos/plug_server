import type { ClientStatus } from "../../domain/entities/client.entity";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import type { ClientAuthUserDto } from "../dtos/client_auth.dto";
import { disconnectConsumerPrincipalSockets } from "./consumer_socket_control_sink";
import { forbidden, notFound } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import {
  assertManagedClientStatusTransition,
  type ManagedClientStatus,
} from "../../domain/policies/client_registration_status.policy";
import { toClientAuthUserDto } from "./client_auth_helpers";
import type { ClientAuthService } from "./client_auth.service";

export interface ListManagedClientsFilter {
  readonly status?: ClientStatus;
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ManagedClientsPage {
  readonly items: ClientAuthUserDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Owner-facing management of their clients: listing, detail lookup and
 * status transitions. Blocking a client revokes refresh tokens, evicts the
 * cached auth snapshot and disconnects live consumer sockets so the change
 * is enforced immediately across REST and Socket.IO.
 */
export class ClientManagementService {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly clientRepository: IClientRepository,
    private readonly clientRefreshTokenRepository: IClientRefreshTokenRepository,
    private readonly authService: Pick<ClientAuthService, "invalidateSnapshotCache">,
  ) {}

  async listManagedClientsPage(
    ownerUserId: string,
    filter?: ListManagedClientsFilter,
  ): Promise<Result<ManagedClientsPage>> {
    const owner = await this.userRepository.findById(ownerUserId);
    if (!owner) {
      return err(notFound("Owner user"));
    }
    if (owner.status !== "active") {
      return err(forbidden("Owner user is not active"));
    }

    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, filter?.pageSize ?? 20));

    const pageResult = await this.clientRepository.listByUserIdPage(ownerUserId, {
      ...(filter?.status !== undefined ? { status: filter.status } : {}),
      ...(filter?.search !== undefined ? { search: filter.search } : {}),
      page,
      pageSize,
    });

    return ok({
      items: pageResult.items.map((client) => toClientAuthUserDto(client)),
      total: pageResult.total,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
    });
  }

  async findManagedClient(
    ownerUserId: string,
    clientId: string,
  ): Promise<Result<ClientAuthUserDto>> {
    const owner = await this.userRepository.findById(ownerUserId);
    if (!owner) {
      return err(notFound("Owner user"));
    }
    if (owner.status !== "active") {
      return err(forbidden("Owner user is not active"));
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client || client.userId !== ownerUserId) {
      return err(notFound("Client"));
    }
    return ok(toClientAuthUserDto(client));
  }

  async setManagedClientStatus(
    ownerUserId: string,
    clientId: string,
    status: ClientStatus,
  ): Promise<Result<ClientAuthUserDto>> {
    const owner = await this.userRepository.findById(ownerUserId);
    if (!owner) {
      return err(notFound("Owner user"));
    }
    if (owner.status !== "active") {
      return err(forbidden("Owner user is not active"));
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client || client.userId !== ownerUserId) {
      return err(notFound("Client"));
    }

    if (client.status === status) {
      return ok(toClientAuthUserDto(client));
    }

    const transition = assertManagedClientStatusTransition(
      client.status,
      status as ManagedClientStatus,
    );
    if (!transition.ok) {
      return transition;
    }

    const updated = client.withStatus(status, { updatedAt: new Date() });
    await this.clientRepository.save(updated);
    if (status === "blocked") {
      this.authService.invalidateSnapshotCache(client.id);
      await this.clientRefreshTokenRepository.revokeAllForClient(client.id);
      await disconnectConsumerPrincipalSockets({
        principalType: "client",
        principalId: client.id,
        reason: "account_blocked",
      });
    }
    return ok(toClientAuthUserDto(updated));
  }
}
