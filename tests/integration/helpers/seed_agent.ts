/**
 * Test seeding helpers for agent catalog and identity data.
 * Only usable in test environments (in-memory repositories).
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { User } from "../../../src/domain/entities/user.entity";
import { Agent } from "../../../src/domain/entities/agent.entity";
import { container } from "../../../src/shared/di/container";
import { approveRegistrationByToken } from "./approve_registration";

export const seedAdminUser = async (
  httpTarget: Parameters<typeof request>[0],
  opts: { email: string; password: string },
): Promise<{ accessToken: string }> => {
  const reg = await request(httpTarget).post("/api/v1/auth/register").send(opts);
  if (reg.status !== 201) throw new Error(`Register failed: ${reg.status} ${reg.text}`);
  await approveRegistrationByToken(httpTarget, reg.body.approvalToken as string);

  const userId: string = reg.body.user.id as string;
  const currentUser = await container._repositories.user.findById(userId);
  if (!currentUser) throw new Error("User not found after registration");

  const adminUser = new User({
    id: currentUser.id,
    email: currentUser.email,
    passwordHash: currentUser.passwordHash,
    role: "admin",
    status: "active",
    createdAt: currentUser.createdAt,
  });
  await container._repositories.user.save(adminUser);

  const login = await request(httpTarget).post("/api/v1/auth/login").send(opts);
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);

  return { accessToken: login.body.accessToken as string };
};

export const seedAgent = async (opts: {
  agentId?: string;
  name: string;
  cnpjCpf: string;
  observation?: string;
  status?: "active" | "inactive";
}): Promise<Agent> => {
  const agent = Agent.create({
    agentId: opts.agentId ?? randomUUID(),
    name: opts.name,
    cnpjCpf: opts.cnpjCpf,
    observation: opts.observation,
    status: opts.status ?? "active",
  });
  await container._repositories.agent.save(agent);
  return agent;
};

export const seedAgentBinding = async (userId: string, agentId: string): Promise<void> => {
  await container._repositories.agentIdentity.addAgentIds(userId, [agentId]);
};
