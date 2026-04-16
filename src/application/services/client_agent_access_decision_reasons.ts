export const clientAgentAccessExpiredDecisionReason = "Approval token expired";

/** Access row removed by the client via `DELETE /client/me/agents`. */
export const clientAgentAccessRevokedByClientDecisionReason = "client_revoked_access";

/** Access row removed by the agent owner via `DELETE /me/agents/:agentId/clients/:clientId`. */
export const clientAgentAccessRevokedByOwnerDecisionReason = "owner_revoked_access";
