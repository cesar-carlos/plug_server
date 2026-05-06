import type { Agent } from "../entities/agent.entity";
import type { Client } from "../entities/client.entity";
import type { ClientAgentAccessRequestStatus } from "../entities/client_agent_access_request.entity";
import { conflict } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { assertClientEligibleForAccessGrant } from "./client_registration_status.policy";

export const assertAgentEligibleForClientAccessGrant = (agent: Agent): Result<void> => {
  if (agent.status !== "active") {
    return err(conflict(`Agent ${agent.agentId} is not active`));
  }
  return ok(undefined);
};

export const assertClientEligibleForClientAccessGrant = (client: Client): Result<void> =>
  assertClientEligibleForAccessGrant(client);

export const isClientAccessRequestRetryEligible = (
  status: ClientAgentAccessRequestStatus,
): boolean => status === "rejected" || status === "expired" || status === "revoked";
