import { v4 as uuidv4 } from "uuid";

import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import { Client, type ClientStatus } from "../../domain/entities/client.entity";
import { ClientRefreshToken } from "../../domain/entities/client_refresh_token.entity";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import type {
  ClientAuthResponseDto,
  ClientAuthTokensDto,
  ClientAuthUserDto,
} from "../dtos/client_auth.dto";
import { env } from "../../shared/config/env";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { parseExpiryToDate } from "../../shared/utils/date";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../shared/utils/jwt";

export interface RegisterClientServiceInput {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile?: string;
}

export interface LoginClientServiceInput {
  readonly email: string;
  readonly password: string;
}

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

export class ClientAuthService {
  constructor(
    private readonly clientRepository: IClientRepository,
    private readonly clientRefreshTokenRepository: IClientRefreshTokenRepository,
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
  ) {}

  async register(input: RegisterClientServiceInput): Promise<Result<ClientAuthResponseDto>> {
    const owner = await this.userRepository.findById(input.userId);
    if (!owner) {
      return err(notFound("Owner user"));
    }
    if (owner.status !== "active") {
      return err(forbidden("Owner user is not active"));
    }

    const existing = await this.clientRepository.findByEmail(input.email);
    if (existing) {
      return err(conflict("Client email already in use"));
    }

    const passwordHash = await this.passwordHasher.hash(input.password);
    const client = Client.create({
      userId: input.userId,
      email: input.email,
      passwordHash,
      name: input.name,
      lastName: input.lastName,
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
    });
    await this.clientRepository.save(client);

    const tokens = await this.issueTokens(client);
    return ok({
      client: this.toClientDto(client),
      ...tokens,
    });
  }

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
    let clients = await this.clientRepository.listByUserId(ownerUserId);

    if (filter?.status !== undefined) {
      clients = clients.filter((client) => client.status === filter.status);
    }
    if (filter?.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      clients = clients.filter(
        (client) =>
          client.email.toLowerCase().includes(query) ||
          client.name.toLowerCase().includes(query) ||
          client.lastName.toLowerCase().includes(query),
      );
    }

    const total = clients.length;
    const start = (page - 1) * pageSize;
    const items = clients.slice(start, start + pageSize).map((client) => this.toClientDto(client));
    return ok({
      items,
      total,
      page,
      pageSize,
    });
  }

  async findManagedClient(ownerUserId: string, clientId: string): Promise<Result<ClientAuthUserDto>> {
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
    return ok(this.toClientDto(client));
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
      return ok(this.toClientDto(client));
    }

    const updated = new Client({
      ...client,
      status,
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);
    if (status === "blocked") {
      await this.clientRefreshTokenRepository.revokeAllForClient(client.id);
    }
    return ok(this.toClientDto(updated));
  }

  async login(input: LoginClientServiceInput): Promise<Result<ClientAuthResponseDto>> {
    const client = await this.clientRepository.findByEmail(input.email);
    if (!client) {
      return err(unauthorized("Invalid credentials"));
    }
    if (client.status !== "active") {
      return err(forbidden("Client account is blocked"));
    }

    const passwordMatch = await this.passwordHasher.compare(input.password, client.passwordHash);
    if (!passwordMatch) {
      return err(unauthorized("Invalid credentials"));
    }

    const tokens = await this.issueTokens(client);
    return ok({
      client: this.toClientDto(client),
      ...tokens,
    });
  }

  async refresh(rawRefreshToken: string): Promise<Result<ClientAuthTokensDto>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);
    if (!verifyResult.ok) {
      return verifyResult;
    }
    if (verifyResult.value.principal_type !== "client") {
      return err(badRequest("Refresh token is not a client session token"));
    }

    const { sub: clientId, jti: tokenId } = verifyResult.value;
    const consumed = await this.clientRefreshTokenRepository.consume(tokenId, clientId, new Date());
    if (consumed !== "consumed") {
      return err(unauthorized("Invalid or expired refresh token"));
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    if (client.status !== "active") {
      return err(forbidden("Client account is blocked"));
    }
    return ok(await this.issueTokens(client));
  }

  async logout(rawRefreshToken: string): Promise<Result<void>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);
    if (!verifyResult.ok) {
      return ok(undefined);
    }
    if (verifyResult.value.principal_type !== "client") {
      return ok(undefined);
    }
    await this.clientRefreshTokenRepository.revoke(verifyResult.value.jti);
    return ok(undefined);
  }

  async getActiveClient(clientId: string): Promise<Result<Client>> {
    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    if (client.status !== "active") {
      return err(forbidden("Client account is blocked"));
    }
    return ok(client);
  }

  async getMeProfile(clientId: string): Promise<Result<ClientAuthUserDto>> {
    const active = await this.getActiveClient(clientId);
    if (!active.ok) {
      return active;
    }
    return ok(this.toClientDto(active.value));
  }

  private async issueTokens(client: Client): Promise<ClientAuthTokensDto> {
    const jti = uuidv4();
    const expiresAt = parseExpiryToDate(env.jwtRefreshExpiresIn);
    const accessToken = signAccessToken({
      sub: client.id,
      email: client.email,
      role: "client",
      principal_type: "client",
      tokenType: "access",
    });
    const refreshToken = signRefreshToken({
      sub: client.id,
      jti,
      principal_type: "client",
      tokenType: "refresh",
    });

    await this.clientRefreshTokenRepository.save(
      ClientRefreshToken.create({
        id: jti,
        clientId: client.id,
        expiresAt,
      }),
    );
    return { accessToken, refreshToken };
  }

  private toClientDto(client: Client): ClientAuthUserDto {
    return {
      id: client.id,
      userId: client.userId,
      email: client.email,
      name: client.name,
      lastName: client.lastName,
      ...(client.mobile !== undefined ? { mobile: client.mobile } : {}),
      status: client.status,
      role: "client",
    };
  }
}
