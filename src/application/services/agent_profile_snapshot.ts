import type { Agent } from "../../domain/entities/agent.entity";

/** JSON-safe catalog snapshot for revisions (no secrets). */
export const agentToProfileSnapshotRecord = (agent: Agent): Record<string, unknown> => ({
  agentId: agent.agentId,
  name: agent.name,
  tradeName: agent.tradeName ?? null,
  document: agent.document ?? null,
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
  profileUpdatedAt: agent.profileUpdatedAt?.toISOString() ?? null,
  profileVersion: agent.profileVersion,
  lastLoginUserId: agent.lastLoginUserId ?? null,
  status: agent.status,
});
