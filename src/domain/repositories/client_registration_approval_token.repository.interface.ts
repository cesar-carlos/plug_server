import type { Client, ClientStatus } from "../entities/client.entity";

export interface ClientRegistrationApprovalToken {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface ClientRegistrationApprovalReviewSummaryRecord {
  readonly ownerEmail: string;
  readonly clientEmail: string;
  readonly clientName: string;
  readonly clientStatus: ClientStatus;
  readonly expiresAt: Date;
}

export interface IClientRegistrationApprovalTokenRepository {
  save(token: ClientRegistrationApprovalToken): Promise<void>;
  replaceForClientRetry(client: Client, token: ClientRegistrationApprovalToken): Promise<void>;
  findById(id: string): Promise<ClientRegistrationApprovalToken | null>;
  findReviewSummaryById(id: string): Promise<ClientRegistrationApprovalReviewSummaryRecord | null>;
  deleteById(id: string): Promise<void>;
}
