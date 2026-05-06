import { randomUUID } from "node:crypto";

import type { Agent, Client, User } from "@prisma/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prismaClient } from "../../../../src/infrastructure/database/prisma/client";
import { PrismaClientAgentAccessApprovalTxn } from "../../../../src/infrastructure/persistence/prisma_client_agent_access_approval_txn";
import { generateOpaqueClientAccessToken } from "../../../../src/shared/utils/client_access_token";

describe("PrismaClientAgentAccessApprovalTxn", () => {
  const txn = new PrismaClientAgentAccessApprovalTxn();
  let databaseAvailable = false;

  const createdUserIds = new Set<string>();
  const createdClientIds = new Set<string>();
  const createdAgentIds = new Set<string>();
  const createdRequestIds = new Set<string>();
  const createdAccessPairs: Array<{ readonly clientId: string; readonly agentId: string }> = [];

  const uniqueSuffix = (): string => `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const createUser = async (): Promise<User> => {
    const suffix = uniqueSuffix();
    const user = await prismaClient.user.create({
      data: {
        email: `txn-owner-${suffix}@test.com`,
        passwordHash: "hash",
        role: "user",
        status: "active",
      },
    });
    createdUserIds.add(user.id);
    return user;
  };

  const createClient = async (userId: string): Promise<Client> => {
    const suffix = uniqueSuffix();
    const client = await prismaClient.client.create({
      data: {
        userId,
        email: `txn-client-${suffix}@test.com`,
        passwordHash: "hash",
        name: "Txn",
        lastName: "Client",
        status: "active",
      },
    });
    createdClientIds.add(client.id);
    return client;
  };

  const createAgent = async (): Promise<Agent> => {
    const agentId = randomUUID();
    const agent = await prismaClient.agent.create({
      data: { agentId, name: "Txn Agent", status: "active" },
    });
    createdAgentIds.add(agent.agentId);
    return agent;
  };

  beforeAll(async () => {
    try {
      await prismaClient.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
    }
  });

  beforeEach(() => {
    createdUserIds.clear();
    createdClientIds.clear();
    createdAgentIds.clear();
    createdRequestIds.clear();
    createdAccessPairs.length = 0;
  });

  afterEach(async () => {
    if (!databaseAvailable) {
      return;
    }
    for (const { clientId, agentId } of createdAccessPairs) {
      await prismaClient.clientAgentAccess.deleteMany({
        where: { clientId, agentId },
      });
    }
    if (createdRequestIds.size > 0) {
      await prismaClient.clientAgentAccessApprovalToken.deleteMany({
        where: { requestId: { in: Array.from(createdRequestIds) } },
      });
      await prismaClient.clientAgentAccessRequest.deleteMany({
        where: { id: { in: Array.from(createdRequestIds) } },
      });
    }
    if (createdAgentIds.size > 0) {
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

  it("approvePendingAndGrantAccess updates request, upserts access, removes token", async () => {
    if (!databaseAvailable) {
      return;
    }

    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();
    const requestId = randomUUID();
    const tokenId = generateOpaqueClientAccessToken();

    await prismaClient.clientAgentAccessRequest.create({
      data: {
        id: requestId,
        clientId: client.id,
        agentId: agent.agentId,
        status: "pending",
        retryCount: 0,
      },
    });
    createdRequestIds.add(requestId);

    await prismaClient.clientAgentAccessApprovalToken.create({
      data: {
        id: tokenId,
        requestId,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const approvedAt = new Date();
    const granted = await txn.approvePendingAndGrantAccess({
      requestId,
      clientId: client.id,
      agentId: agent.agentId,
      approvedAt,
      consumeTokenId: tokenId,
    });

    expect(granted).toBe(true);
    createdAccessPairs.push({ clientId: client.id, agentId: agent.agentId });

    const updated = await prismaClient.clientAgentAccessRequest.findUnique({
      where: { id: requestId },
    });
    expect(updated?.status).toBe("approved");
    expect(updated?.decidedAt).not.toBeNull();

    const access = await prismaClient.clientAgentAccess.findUnique({
      where: {
        clientId_agentId: { clientId: client.id, agentId: agent.agentId },
      },
    });
    expect(access).not.toBeNull();
    expect(access?.approvedAt).not.toBeNull();

    const tok = await prismaClient.clientAgentAccessApprovalToken.findUnique({
      where: { id: tokenId },
    });
    expect(tok).toBeNull();
  });

  it("approvePendingAndGrantAccess returns false when request is not pending", async () => {
    if (!databaseAvailable) {
      return;
    }

    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();
    const requestId = randomUUID();

    await prismaClient.clientAgentAccessRequest.create({
      data: {
        id: requestId,
        clientId: client.id,
        agentId: agent.agentId,
        status: "approved",
        retryCount: 0,
        decidedAt: new Date(),
      },
    });
    createdRequestIds.add(requestId);

    const granted = await txn.approvePendingAndGrantAccess({
      requestId,
      clientId: client.id,
      agentId: agent.agentId,
      approvedAt: new Date(),
    });

    expect(granted).toBe(false);
  });

  it("rejectPendingAndConsumeToken rejects request and removes token", async () => {
    if (!databaseAvailable) {
      return;
    }

    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();
    const requestId = randomUUID();
    const tokenId = generateOpaqueClientAccessToken();

    await prismaClient.clientAgentAccessRequest.create({
      data: {
        id: requestId,
        clientId: client.id,
        agentId: agent.agentId,
        status: "pending",
        retryCount: 0,
      },
    });
    createdRequestIds.add(requestId);

    await prismaClient.clientAgentAccessApprovalToken.create({
      data: {
        id: tokenId,
        requestId,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const decidedAt = new Date();
    const rejected = await txn.rejectPendingAndConsumeToken({
      requestId,
      decidedAt,
      reason: "integration test",
      consumeTokenId: tokenId,
    });

    expect(rejected).toBe(true);

    const updated = await prismaClient.clientAgentAccessRequest.findUnique({
      where: { id: requestId },
    });
    expect(updated?.status).toBe("rejected");
    expect(updated?.decisionReason).toBe("integration test");

    const tok = await prismaClient.clientAgentAccessApprovalToken.findUnique({
      where: { id: tokenId },
    });
    expect(tok).toBeNull();
  });
});
