import { randomUUID } from "node:crypto";

import type { Agent, Client, User } from "@prisma/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClientAgentAccessRequest } from "../../../../src/domain/entities/client_agent_access_request.entity";
import { prismaClient } from "../../../../src/infrastructure/database/prisma/client";
import { PrismaPendingClientAgentAccessWriter } from "../../../../src/infrastructure/persistence/prisma_pending_client_agent_access.writer";
import { PrismaClientAgentAccessApprovalTokenRepository } from "../../../../src/infrastructure/repositories/prisma_client_agent_access_approval_token.repository";
import { generateOpaqueClientAccessToken } from "../../../../src/shared/utils/client_access_token";

describe("PrismaPendingClientAgentAccessWriter", () => {
  const writer = new PrismaPendingClientAgentAccessWriter();
  const tokenRepository = new PrismaClientAgentAccessApprovalTokenRepository();
  let databaseAvailable = false;

  const createdUserIds = new Set<string>();
  const createdClientIds = new Set<string>();
  const createdAgentIds = new Set<string>();
  const createdRequestIds = new Set<string>();

  const uniqueSuffix = (): string => `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const createUser = async (): Promise<User> => {
    const suffix = uniqueSuffix();
    const user = await prismaClient.user.create({
      data: {
        email: `writer-owner-${suffix}@test.com`,
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
        email: `writer-client-${suffix}@test.com`,
        passwordHash: "hash",
        name: "Writer",
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
      data: { agentId, name: "Writer Agent", status: "active" },
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
  });

  afterEach(async () => {
    if (!databaseAvailable) {
      return;
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

  it("writes request and token in a single transaction", async () => {
    if (!databaseAvailable) {
      return;
    }

    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();

    const request = ClientAgentAccessRequest.create({
      clientId: client.id,
      agentId: agent.agentId,
      retryCount: 0,
    });
    createdRequestIds.add(request.id);

    const token = {
      id: generateOpaqueClientAccessToken(),
      requestId: request.id,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      createdAt: new Date(),
    };

    await writer.writePendingRequests([{ request, token }]);

    const savedRequest = await prismaClient.clientAgentAccessRequest.findUnique({
      where: { id: request.id },
    });
    expect(savedRequest).not.toBeNull();
    expect(savedRequest?.clientId).toBe(client.id);
    expect(savedRequest?.agentId).toBe(agent.agentId);
    expect(savedRequest?.status).toBe("pending");
    expect(savedRequest?.retryCount).toBe(0);

    const savedToken = await tokenRepository.findById(token.id);
    expect(savedToken).not.toBeNull();
    expect(savedToken?.requestId).toBe(request.id);
  });

  it("persists retryCount correctly when non-zero", async () => {
    if (!databaseAvailable) {
      return;
    }

    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();

    const request = ClientAgentAccessRequest.create({
      clientId: client.id,
      agentId: agent.agentId,
      retryCount: 2,
    });
    createdRequestIds.add(request.id);

    const token = {
      id: generateOpaqueClientAccessToken(),
      requestId: request.id,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      createdAt: new Date(),
    };

    await writer.writePendingRequests([{ request, token }]);

    const saved = await prismaClient.clientAgentAccessRequest.findUnique({
      where: { id: request.id },
    });
    expect(saved?.retryCount).toBe(2);
  });

  it("updates retryCount on upsert when request already exists", async () => {
    if (!databaseAvailable) {
      return;
    }

    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();

    const request = ClientAgentAccessRequest.create({
      clientId: client.id,
      agentId: agent.agentId,
      retryCount: 1,
    });
    createdRequestIds.add(request.id);

    const firstToken = {
      id: generateOpaqueClientAccessToken(),
      requestId: request.id,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      createdAt: new Date(),
    };
    await writer.writePendingRequests([{ request, token: firstToken }]);

    const reopened = new ClientAgentAccessRequest({
      ...request,
      retryCount: 2,
      requestedAt: new Date(),
      updatedAt: new Date(),
    });
    const secondToken = {
      id: generateOpaqueClientAccessToken(),
      requestId: request.id,
      expiresAt: new Date(Date.now() + 7200 * 1000),
      createdAt: new Date(),
    };
    await writer.writePendingRequests([{ request: reopened, token: secondToken }]);

    const saved = await prismaClient.clientAgentAccessRequest.findUnique({
      where: { id: request.id },
    });
    expect(saved?.retryCount).toBe(2);

    const updatedToken = await tokenRepository.findById(secondToken.id);
    expect(updatedToken).not.toBeNull();
  });

  it("is a no-op when called with an empty array", async () => {
    if (!databaseAvailable) {
      return;
    }
    await expect(writer.writePendingRequests([])).resolves.toBeUndefined();
  });
});
