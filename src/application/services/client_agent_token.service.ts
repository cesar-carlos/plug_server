import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import { agentAccessDenied } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { logger } from "../../shared/utils/logger";
import { recordSocketAuditEvent } from "./socket_audit.service";
import {
  CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED,
  CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET,
  type ClientTokenAuditPayload,
} from "./client_agent_access_types";

/**
 * Reads/writes the per-(client, agent) bearer token stored alongside the
 * access grant. Emits an `audit_events` row on every mutation while keeping
 * the token value itself out of logs and audit payloads.
 */
export class ClientAgentTokenService {
  constructor(private readonly clientAgentAccessRepository: IClientAgentAccessRepository) {}

  /**
   * Reads the per-(client, agent) bearer token stored at access-approval time
   * (or set later via {@link setClientTokenForAgent}). Only returns a value
   * when the client currently has approved access to the agent.
   *
   * Returns `null` when access exists but no token is stored yet.
   */
  async getClientTokenForAgent(
    clientId: string,
    agentId: string,
  ): Promise<Result<{ clientToken: string | null }>> {
    const access = await this.clientAgentAccessRepository.findByClientAndAgent(clientId, agentId);
    if (!access) {
      return err(agentAccessDenied(agentId));
    }
    return ok({ clientToken: access.clientToken });
  }

  /**
   * Stores (or clears) the per-(client, agent) bearer token. The client must
   * already have approved access to the agent — this method does NOT create
   * the access row.
   *
   * - `clientToken: string` — replace stored token.
   * - `clientToken: null`  — clear the stored token.
   *
   * Emits an `audit_events` row (`client_token.set` / `client_token.cleared`)
   * with metadata only (length + whether a previous value existed). The token
   * value itself is **never** persisted in the audit trail.
   *
   * Returns the value the client should now see.
   */
  async setClientTokenForAgent(
    clientId: string,
    agentId: string,
    clientToken: string | null,
  ): Promise<Result<{ clientToken: string | null }>> {
    const existing = await this.clientAgentAccessRepository.findByClientAndAgent(clientId, agentId);
    if (!existing) {
      return err(agentAccessDenied(agentId));
    }

    const updated = await this.clientAgentAccessRepository.setClientToken(
      clientId,
      agentId,
      clientToken,
    );
    if (!updated) {
      // Race: row deleted between the read and the write — treat as if access
      // had never existed.
      return err(agentAccessDenied(agentId));
    }

    const replacedExisting =
      typeof existing.clientToken === "string" && existing.clientToken !== "";
    void this.recordClientTokenAudit({
      clientId,
      agentId,
      eventType:
        clientToken === null
          ? CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED
          : CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET,
      payload: {
        len: clientToken ? clientToken.length : 0,
        replacedExisting,
      },
    });

    return ok({ clientToken });
  }

  private async recordClientTokenAudit(input: {
    readonly clientId: string;
    readonly agentId: string;
    readonly eventType: string;
    readonly payload: ClientTokenAuditPayload;
  }): Promise<void> {
    try {
      await recordSocketAuditEvent({
        eventType: input.eventType,
        // `actor_user_id` is the principal column on `audit_events`; here it
        // carries the client id (principal_type=client) so queries can join
        // by `clients.id` when the actor was a client.
        actorUserId: input.clientId,
        actorRole: "client",
        direction: "control",
        agentId: input.agentId,
        payload: input.payload,
      });
    } catch (error) {
      // Audit failures must never break the user-facing operation.
      logger.warn("client_token_audit_record_failed", {
        clientId: input.clientId,
        agentId: input.agentId,
        eventType: input.eventType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
