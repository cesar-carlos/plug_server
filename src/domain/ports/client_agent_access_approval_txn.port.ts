/**
 * Atomic client→agent access approval/rejection across request row, access grant,
 * and approval token rows (production uses a single DB transaction).
 */
export interface ClientAgentAccessApproveTxnInput {
  readonly requestId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly approvedAt: Date;
  readonly pushEventId?: string;
  /** When set, removes this approval token row; otherwise removes tokens by `requestId`. */
  readonly consumeTokenId?: string;
}

export interface ClientAgentAccessRejectTxnInput {
  readonly requestId: string;
  readonly decidedAt: Date;
  readonly reason?: string;
  readonly consumeTokenId?: string;
}

export interface ClientAgentAccessRevokeTxnInput {
  readonly clientId: string;
  readonly agentId: string;
  readonly reason: string;
  readonly pushEventId?: string;
}

export interface IClientAgentAccessApprovalTxn {
  revokeAccess(input: ClientAgentAccessRevokeTxnInput): Promise<boolean>;
  /**
   * If the request is still `pending`: set `approved`, upsert `client_agent_access`,
   * delete approval token(s). Returns false if the row was not pending (race / already decided).
   */
  approvePendingAndGrantAccess(input: ClientAgentAccessApproveTxnInput): Promise<boolean>;

  /**
   * If the request is still `pending`: set `rejected`, delete approval token(s).
   * Returns false if the row was not pending.
   */
  rejectPendingAndConsumeToken(input: ClientAgentAccessRejectTxnInput): Promise<boolean>;
}
