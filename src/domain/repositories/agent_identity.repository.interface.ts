export type BindAgentIdentityStatus =
  | "bound"
  | "already_bound_to_user"
  | "bound_to_other_user";

export interface IAgentIdentityRepository {
  findOwnerUserId(agentId: string): Promise<string | null>;
  bindIfUnbound(agentId: string, userId: string): Promise<BindAgentIdentityStatus>;
}
