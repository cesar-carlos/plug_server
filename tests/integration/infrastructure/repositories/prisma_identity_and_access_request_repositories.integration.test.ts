import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientAgentAccessRequest } from "../../../../src/domain/entities/client_agent_access_request.entity";
import { prismaClient } from "../../../../src/infrastructure/database/prisma/client";
import { PrismaAgentIdentityRepository } from "../../../../src/infrastructure/repositories/prisma_agent_identity.repository";
import { PrismaClientAgentAccessRequestRepository } from "../../../../src/infrastructure/repositories/prisma_client_agent_access_request.repository";

describe("Prisma identity and access request repositories", () => {
  const agentIdentityRepository = new PrismaAgentIdentityRepository();
  const accessRequestRepository = new PrismaClientAgentAccessRequestRepository();

  const createdUserIds = new Set<string>();
  const createdClientIds = new Set<string>();
  const createdAgentIds = new Set<string>();
  const createdRequestIds = new Set<string>();

  const uniqueSuffix = (): string => `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const createUser = async () => {
    const suffix = uniqueSuffix();
    const user = await prismaClient.user.create({
      data: {
        email: `repo-owner-${suffix}@test.com`,
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
        email: `repo-client-${suffix}@test.com`,
        passwordHash: "hash",
        name: "Client",
        lastName: "Repo",
        status: "active",
      },
    });
    createdClientIds.add(client.id);
    return client;
  };

  const createAgent = async (name = "Repo Agent") => {
    const agentId = randomUUID();
    const agent = await prismaClient.agent.create({
      data: {
        agentId,
        name,
        status: "active",
      },
    });
    createdAgentIds.add(agent.agentId);
    return agent;
  };

  beforeEach(() => {
    createdUserIds.clear();
    createdClientIds.clear();
    createdAgentIds.clear();
    createdRequestIds.clear();
  });

  afterEach(async () => {
    if (createdRequestIds.size > 0) {
      await prismaClient.clientAgentAccessApprovalToken.deleteMany({
        where: { requestId: { in: Array.from(createdRequestIds) } },
      });
      await prismaClient.clientAgentAccessRequest.deleteMany({
        where: { id: { in: Array.from(createdRequestIds) } },
      });
    }
    if (createdAgentIds.size > 0) {
      await prismaClient.agentIdentity.deleteMany({
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

  it("binds an agent once and reports ownership/access states correctly", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const earlierAgent = await createAgent("Earlier Agent");
    const laterAgent = await createAgent("Later Agent");

    await expect(agentIdentityRepository.bindIfUnbound(earlierAgent.agentId, owner.id)).resolves.toBe(
      "bound",
    );
    await expect(agentIdentityRepository.bindIfUnbound(earlierAgent.agentId, owner.id)).resolves.toBe(
      "already_bound_to_user",
    );
    await expect(agentIdentityRepository.bindIfUnbound(earlierAgent.agentId, otherUser.id)).resolves.toBe(
      "bound_to_other_user",
    );
    await expect(agentIdentityRepository.bindIfUnbound(laterAgent.agentId, owner.id)).resolves.toBe(
      "bound",
    );

    await expect(agentIdentityRepository.findOwnerUserId(earlierAgent.agentId)).resolves.toBe(owner.id);
    await expect(agentIdentityRepository.hasAccess(owner.id, earlierAgent.agentId)).resolves.toBe(true);
    await expect(agentIdentityRepository.hasAccess(otherUser.id, earlierAgent.agentId)).resolves.toBe(
      false,
    );
    await expect(agentIdentityRepository.listAgentIdsByUserId(owner.id)).resolves.toEqual([
      earlierAgent.agentId,
      laterAgent.agentId,
    ]);
  });

  it("saves requests, clears nullable decision fields on update, and reloads by composite key", async () => {
    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();
    const requestId = randomUUID();
    createdRequestIds.add(requestId);

    await accessRequestRepository.save(
      new ClientAgentAccessRequest({
        id: requestId,
        clientId: client.id,
        agentId: agent.agentId,
        status: "rejected",
        requestedAt: new Date("2026-04-03T10:00:00.000Z"),
        decidedAt: new Date("2026-04-03T10:05:00.000Z"),
        decisionReason: "Needs review",
        createdAt: new Date("2026-04-03T10:00:00.000Z"),
        updatedAt: new Date("2026-04-03T10:05:00.000Z"),
      }),
    );

    await accessRequestRepository.save(
      new ClientAgentAccessRequest({
        id: requestId,
        clientId: client.id,
        agentId: agent.agentId,
        status: "pending",
        requestedAt: new Date("2026-04-03T10:06:00.000Z"),
        createdAt: new Date("2026-04-03T10:00:00.000Z"),
        updatedAt: new Date("2026-04-03T10:06:00.000Z"),
      }),
    );

    await expect(accessRequestRepository.findByClientAndAgent(client.id, agent.agentId)).resolves.toMatchObject({
      id: requestId,
      status: "pending",
      decidedAt: undefined,
      decisionReason: undefined,
    });

    const stored = await prismaClient.clientAgentAccessRequest.findUnique({ where: { id: requestId } });
    expect(stored?.decidedAt).toBeNull();
    expect(stored?.decisionReason).toBeNull();
  });

  it("setStatus persists decision metadata and defaults decidedAt when omitted", async () => {
    const owner = await createUser();
    const client = await createClient(owner.id);
    const agent = await createAgent();
    const request = ClientAgentAccessRequest.create({
      clientId: client.id,
      agentId: agent.agentId,
    });
    createdRequestIds.add(request.id);

    await accessRequestRepository.save(request);
    await accessRequestRepository.setStatus(request.id, "approved");

    const approved = await accessRequestRepository.findById(request.id);
    expect(approved).toMatchObject({
      id: request.id,
      status: "approved",
      decisionReason: undefined,
    });
    expect(approved?.decidedAt).toBeInstanceOf(Date);
  });

  it("lists client requests in descending requestedAt order", async () => {
    const owner = await createUser();
    const client = await createClient(owner.id);
    const firstAgent = await createAgent("Older Request Agent");
    const secondAgent = await createAgent("Newer Request Agent");

    const olderRequest = new ClientAgentAccessRequest({
      id: randomUUID(),
      clientId: client.id,
      agentId: firstAgent.agentId,
      status: "pending",
      requestedAt: new Date("2026-04-03T09:00:00.000Z"),
      createdAt: new Date("2026-04-03T09:00:00.000Z"),
      updatedAt: new Date("2026-04-03T09:00:00.000Z"),
    });
    const newerRequest = new ClientAgentAccessRequest({
      id: randomUUID(),
      clientId: client.id,
      agentId: secondAgent.agentId,
      status: "pending",
      requestedAt: new Date("2026-04-03T11:00:00.000Z"),
      createdAt: new Date("2026-04-03T11:00:00.000Z"),
      updatedAt: new Date("2026-04-03T11:00:00.000Z"),
    });
    createdRequestIds.add(olderRequest.id);
    createdRequestIds.add(newerRequest.id);

    await accessRequestRepository.save(olderRequest);
    await accessRequestRepository.save(newerRequest);

    await expect(accessRequestRepository.listByClientId(client.id)).resolves.toMatchObject([
      { id: newerRequest.id, agentId: secondAgent.agentId },
      { id: olderRequest.id, agentId: firstAgent.agentId },
    ]);
  });

  it("lists owner requests scoped only to agents bound to that owner", async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const client = await createClient(owner.id);
    const ownedAgent = await createAgent("Owned Agent");
    const otherAgent = await createAgent("Other Agent");

    await agentIdentityRepository.bindIfUnbound(ownedAgent.agentId, owner.id);
    await agentIdentityRepository.bindIfUnbound(otherAgent.agentId, otherOwner.id);

    const ownedRequest = new ClientAgentAccessRequest({
      id: randomUUID(),
      clientId: client.id,
      agentId: ownedAgent.agentId,
      status: "pending",
      requestedAt: new Date("2026-04-03T12:00:00.000Z"),
      createdAt: new Date("2026-04-03T12:00:00.000Z"),
      updatedAt: new Date("2026-04-03T12:00:00.000Z"),
    });
    const hiddenRequest = new ClientAgentAccessRequest({
      id: randomUUID(),
      clientId: client.id,
      agentId: otherAgent.agentId,
      status: "pending",
      requestedAt: new Date("2026-04-03T12:05:00.000Z"),
      createdAt: new Date("2026-04-03T12:05:00.000Z"),
      updatedAt: new Date("2026-04-03T12:05:00.000Z"),
    });
    createdRequestIds.add(ownedRequest.id);
    createdRequestIds.add(hiddenRequest.id);

    await accessRequestRepository.save(ownedRequest);
    await accessRequestRepository.save(hiddenRequest);

    await expect(accessRequestRepository.listByOwnerUserId(owner.id)).resolves.toMatchObject([
      { id: ownedRequest.id, agentId: ownedAgent.agentId },
    ]);
    await expect(accessRequestRepository.listByOwnerUserId(otherOwner.id)).resolves.toMatchObject([
      { id: hiddenRequest.id, agentId: otherAgent.agentId },
    ]);
  });
});
