import { Client } from "../../domain/entities/client.entity";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IFileStorage } from "../../domain/ports/file_storage.port";
import type { ClientAuthUserDto } from "../dtos/client_auth.dto";
import { env } from "../../shared/config/env";
import { badRequest } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { toClientAuthUserDto } from "./client_auth_helpers";
import type { ClientAuthService } from "./client_auth.service";

export interface UpdateMyClientProfileInput {
  readonly name?: string;
  readonly lastName?: string;
  readonly mobile?: string | null;
  readonly thumbnailUrl?: null;
}

/**
 * Mutations for the authenticated client's own profile (text fields and
 * thumbnail upload). Delegates the active-client lookup to
 * `ClientAuthService.getActiveClient` so all status/credentials-version
 * checks stay centralized.
 */
export class ClientProfileService {
  constructor(
    private readonly clientRepository: IClientRepository,
    private readonly fileStorage: IFileStorage,
    private readonly authService: Pick<ClientAuthService, "getActiveClient">,
  ) {}

  async updateMyProfile(
    clientId: string,
    input: UpdateMyClientProfileInput,
    preloaded?: Client,
  ): Promise<Result<ClientAuthUserDto>> {
    const active = await this.authService.getActiveClient(clientId, preloaded);
    if (!active.ok) {
      return active;
    }

    const current = active.value;
    const nextName = input.name ?? current.name;
    const nextLastName = input.lastName ?? current.lastName;
    const nextMobile = input.mobile === undefined ? current.mobile : (input.mobile ?? undefined);
    const nextThumbnailUrl = input.thumbnailUrl === undefined ? current.thumbnailUrl : undefined;

    if (
      nextName === current.name &&
      nextLastName === current.lastName &&
      nextMobile === current.mobile &&
      nextThumbnailUrl === current.thumbnailUrl
    ) {
      return ok(toClientAuthUserDto(current));
    }

    const updated = new Client({
      ...current,
      name: nextName,
      lastName: nextLastName,
      ...(nextMobile !== undefined ? { mobile: nextMobile } : {}),
      ...(nextThumbnailUrl !== undefined ? { thumbnailUrl: nextThumbnailUrl } : {}),
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);
    if (
      input.thumbnailUrl === null &&
      current.thumbnailUrl?.startsWith(`${env.uploadsPublicBaseUrl}/`)
    ) {
      await this.fileStorage.delete(
        current.thumbnailUrl.slice(`${env.uploadsPublicBaseUrl}/`.length),
      );
    }
    return ok(toClientAuthUserDto(updated));
  }

  async updateThumbnail(
    clientId: string,
    file: {
      readonly buffer: Buffer;
      readonly mimeType: string;
    },
    preloaded?: Client,
  ): Promise<Result<ClientAuthUserDto>> {
    const active = await this.authService.getActiveClient(clientId, preloaded);
    if (!active.ok) {
      return active;
    }

    const current = active.value;
    let stored: { url: string; storageKey: string };
    try {
      stored = await this.fileStorage.saveClientThumbnail({
        clientId: current.id,
        buffer: file.buffer,
        mimeType: file.mimeType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid thumbnail image file";
      return err(badRequest(message));
    }

    const updated = new Client({
      ...current,
      thumbnailUrl: stored.url,
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);

    if (current.thumbnailUrl?.startsWith(env.uploadsPublicBaseUrl)) {
      const prefix = `${env.uploadsPublicBaseUrl}/`;
      const previousStorageKey = current.thumbnailUrl.slice(prefix.length);
      if (previousStorageKey.trim() !== "") {
        await this.fileStorage.delete(previousStorageKey);
      }
    }

    return ok(toClientAuthUserDto(updated));
  }
}
