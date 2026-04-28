import type { Agent } from "../../../domain/entities/agent.entity";

export type AgentCatalogDto = {
  agentId: string;
  name: string;
  tradeName: string | null;
  document: string | null;
  cnpjCpf: string | null;
  documentType: Agent["documentType"] | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  address: {
    street: string | null;
    number: string | null;
    district: string | null;
    postalCode: string | null;
    city: string | null;
    state: string | null;
  };
  notes: string | null;
  /** @deprecated Alias for `notes`. Kept for backwards compatibility. */
  observation: string | null;
  lastLoginUserId: string | null;
  profileUpdatedAt: string | null;
  profileVersion: number;
  status: Agent["status"];
  createdAt: string;
  updatedAt: string;
};

export const toAgentCatalogDto = (agent: Agent): AgentCatalogDto => ({
  agentId: agent.agentId,
  name: agent.name,
  tradeName: agent.tradeName ?? null,
  document: agent.document ?? null,
  cnpjCpf: agent.document ?? null,
  documentType: agent.documentType ?? null,
  phone: agent.phone ?? null,
  mobile: agent.mobile ?? null,
  email: agent.email ?? null,
  address: {
    street: agent.street ?? null,
    number: agent.number ?? null,
    district: agent.district ?? null,
    postalCode: agent.postalCode ?? null,
    city: agent.city ?? null,
    state: agent.state ?? null,
  },
  notes: agent.notes ?? null,
  observation: agent.notes ?? null,
  lastLoginUserId: agent.lastLoginUserId ?? null,
  profileUpdatedAt: agent.profileUpdatedAt?.toISOString() ?? null,
  profileVersion: agent.profileVersion,
  status: agent.status,
  createdAt: agent.createdAt.toISOString(),
  updatedAt: agent.updatedAt.toISOString(),
});
