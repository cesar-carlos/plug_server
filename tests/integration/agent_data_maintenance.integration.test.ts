import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  pruneAgentProfileData,
  resetAgentDataMaintenanceServiceForTests,
  sweepExpiredClientAgentAccessData,
} from "../../src/application/services/agent_data_maintenance.service";
import { clientAgentAccessExpiredDecisionReason } from "../../src/application/services/client_agent_access_decision_reasons";
import { prismaClient } from "../../src/infrastructure/database/prisma/client";

describe("agent_data_maintenance.service (integration)", () => {
  let tablesAvailable = false;

  const createdUserIds = new Set<string>();
  const createdClientIds = new Set<string>();
  const createdAgentIds = new Set<string>();
  const createdRequestIds = new Set<string>();

  const uniqueSuffix = (): string => `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const createUser = async () => {
    const suffix = uniqueSuffix();
    const user = await prismaClient.user.create({
      data: {
        email: `agent-maint-owner-${suffix}@test.com`,
        passwordHash: "hash",
        role: "user",
        status: "active",
      },
    });
    createdUserIds.add(user.id);
    return user;
  };

  const createClient = async (userId: string) => {
    const suffix = uniqueSuffix();
    const client = await prismaClient.client.create({
      data: {
        userId,
        email: `agent-maint-client-${suffix}@test.com`,
        passwordHash: "hash",
        name: "Client",
        lastName: "Maintenance",
        status: "active",
      },
    });
    createdClientIds.add(client.id);
    return client;
  };

  const createAgent = async (name: string) => {
    const agent = await prismaClient.agent.create({
      data: {
        agentId: randomUUID(),
        name,
        status: "active",
      },
    });
    createdAgentIds.add(agent.agentId);
    return agent;
  };

  beforeAll(async () => {
    resetAgentDataMaintenanceServiceForTests();
    try {
      const rows = await prismaClient.$queryRaw<
        Array<{
          profileRevisionsExists: boolean;
          profileIdempotenciesExists: boolean;
          accessRequestsExists: boolean;
          accessTokensExists: boolean;
        }>
      >`
        SELECT
          to_regclass('public.agent_profile_revisions') IS NOT NULL AS "profileRevisionsExists",
          to_regclass('public.agent_profile_write_idempotencies') IS NOT NULL AS "profileIdempotenciesExists",
          to_regclass('public.client_agent_access_requests') IS NOT NULL AS "accessRequestsExists",
          to_regclass('public.client_agent_access_approval_tokens') IS NOT NULL AS "accessTokensExists"
      `;
      tablesAvailable = Boolean(
        rows[0]?.profileRevisionsExists &&
          rows[0]?.profileIdempotenciesExists &&
          rows[0]?.accessRequestsExists &&
          rows[0]?.accessTokensExists,
      );
    } catch {
      tablesAvailable = false;
    }
  });

  beforeEach(() => {
    resetAgentDataMaintenanceServiceForTests();
    createdUserIds.clear();
    createdClientIds.clear();
    createdAgentIds.clear();
    createdRequestIds.clear();
  });

  afterEach(async () => {
    resetAgentDataMaintenanceServiceForTests();

    if (createdRequestIds.size > 0) {
      await prismaClient.clientAgentAccessApprovalToken.deleteMany({
        where: { requestId: { in: Array.from(createdRequestIds) } },
      });
      await prismaClient.clientAgentAccessRequest.deleteMany({
        where: { id: { in: Array.from(createdRequestIds) } },
      });
    }

    if (createdAgentIds.size > 0) {
      await prismaClient.agentProfileWriteIdempotency.deleteMany({
        where: { agentId: { in: Array.from(createdAgentIds) } },
      });
      await prismaClient.agentProfileRevision.deleteMany({
        where: { agentId: { in: Array.from(createdAgentIds) } },
      });
      await prismaClient.agent.deleteMany({
        where: { agentId: { in: Array.from(createdAgentIds) } },
      });
    }

    if (createdClientIds.size > 0) {
      await prismaClient.client.deleteMany({
        where: { id: { in: Array.from(createdClientIds) } },
      });
    }

    if (createdUserIds.size > 0) {
      await prismaClient.user.deleteMany({
        where: { id: { in: Array.from(createdUserIds) } },
      });
    }
  });

  afterAll(() => {
    resetAgentDataMaintenanceServiceForTests();
  });

  it("prunes expired profile history rows when maintenance tables exist", async () => {
    if (!tablesAvailable) {
      return;
    }

    const agent = await createAgent("Maintenance Prune Agent");
    const oldRevisionId = randomUUID();
    const freshRevisionId = randomUUID();
    const oldIdempotencyId = randomUUID();
    const freshIdempotencyId = randomUUID();
    const oldCreatedAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const freshCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

    await prismaClient.agentProfileRevision.createMany({
      data: [
        {
          id: oldRevisionId,
          agentId: agent.agentId,
          profileVersion: 1,
          source: "maintenance-test",
          changedFields: {},
          snapshotJson: {},
          createdAt: oldCreatedAt,
        },
        {
          id: freshRevisionId,
          agentId: agent.agentId,
          profileVersion: 2,
          source: "maintenance-test",
          changedFields: {},
          snapshotJson: {},
          createdAt: freshCreatedAt,
        },
      ],
    });

    await prismaClient.agentProfileWriteIdempotency.createMany({
      data: [
        {
          id: oldIdempotencyId,
          agentId: agent.agentId,
          dedupeKey: `old-${randomUUID()}`,
          patchFingerprint: "a".repeat(64),
          resultingProfileVersion: 1,
          createdAt: oldCreatedAt,
        },
        {
          id: freshIdempotencyId,
          agentId: agent.agentId,
          dedupeKey: `fresh-${randomUUID()}`,
          patchFingerprint: "b".repeat(64),
          resultingProfileVersion: 2,
          createdAt: freshCreatedAt,
        },
      ],
    });

    await expect(
      pruneAgentProfileData({
        revisionRetentionDays: 30,
        idempotencyRetentionDays: 30,
        batchSize: 100,
      }),
    ).resolves.toEqual({
      revisionsDeleted: 1,
      idempotencyDeleted: 1,
    });

    await expect(
      prismaClient.agentProfileRevision.findUnique({ where: { id: oldRevisionId } }),
    ).resolves.toBeNull();
    await expect(
      prismaClient.agentProfileWriteIdempotency.findUnique({ where: { id: oldIdempotencyId } }),
    ).resolves.toBeNull();
    await expect(
      prismaClient.agentProfileRevision.findUnique({ where: { id: freshRevisionId } }),
    ).resolves.not.toBeNull();
    await expect(
      prismaClient.agentProfileWriteIdempotency.findUnique({ where: { id: freshIdempotencyId } }),
    ).resolves.not.toBeNull();
  });

  it("expires pending requests and removes expired tokens when access tables exist", async () => {
    if (!tablesAvailable) {
      return;
    }

    const owner = await createUser();
    const client = await createClient(owner.id);
    const pendingAgent = await createAgent("Pending Expiry Agent");
    const approvedAgent = await createAgent("Approved Expiry Agent");
    const pendingRequestId = randomUUID();
    const approvedRequestId = randomUUID();
    const expiredAt = new Date(Date.now() - 60_000);

    createdRequestIds.add(pendingRequestId);
    createdRequestIds.add(approvedRequestId);

    await prismaClient.clientAgentAccessRequest.create({
      data: {
        id: pendingRequestId,
        clientId: client.id,
        agentId: pendingAgent.agentId,
        status: "pending",
      },
    });
    await prismaClient.clientAgentAccessApprovalToken.create({
      data: {
        id: `pending-token-${randomUUID()}`,
        requestId: pendingRequestId,
        expiresAt: expiredAt,
      },
    });

    await prismaClient.clientAgentAccessRequest.create({
      data: {
        id: approvedRequestId,
        clientId: client.id,
        agentId: approvedAgent.agentId,
        status: "approved",
        decidedAt: new Date(Date.now() - 120_000),
      },
    });
    await prismaClient.clientAgentAccessApprovalToken.create({
      data: {
        id: `approved-token-${randomUUID()}`,
        requestId: approvedRequestId,
        expiresAt: expiredAt,
      },
    });

    await expect(
      sweepExpiredClientAgentAccessData({
        batchSize: 100,
      }),
    ).resolves.toEqual({
      requestsExpired: 1,
      tokensDeleted: 2,
    });

    await expect(
      prismaClient.clientAgentAccessApprovalToken.findFirst({
        where: { requestId: { in: [pendingRequestId, approvedRequestId] } },
      }),
    ).resolves.toBeNull();

    await expect(
      prismaClient.clientAgentAccessRequest.findUnique({ where: { id: pendingRequestId } }),
    ).resolves.toMatchObject({
      id: pendingRequestId,
      status: "expired",
      decisionReason: clientAgentAccessExpiredDecisionReason,
    });

    await expect(
      prismaClient.clientAgentAccessRequest.findUnique({ where: { id: approvedRequestId } }),
    ).resolves.toMatchObject({
      id: approvedRequestId,
      status: "approved",
    });
  });
});
