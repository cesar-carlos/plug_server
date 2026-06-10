import { describe, expect, it } from "vitest";

import { Client } from "../../../../src/domain/entities/client.entity";
import { RegistrationApprovalToken } from "../../../../src/domain/entities/registration_approval_token.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import { InMemoryClientRegistrationDecisionTxn } from "../../../../src/infrastructure/persistence/in_memory_client_registration_decision_txn";
import { InMemoryRegistrationDecisionTxn } from "../../../../src/infrastructure/persistence/in_memory_registration_decision_txn";
import { InMemoryClientRegistrationApprovalTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_registration_approval_token.repository";
import { InMemoryClientRepository } from "../../../../src/infrastructure/repositories/in_memory_client.repository";
import { InMemoryRegistrationApprovalTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_registration_approval_token.repository";
import { InMemoryUserRepository } from "../../../../src/infrastructure/repositories/in_memory_user.repository";

const future = (): Date => new Date(Date.now() + 60_000);
const past = (): Date => new Date(Date.now() - 60_000);

interface UserDecisionFixture {
  readonly user: User;
  readonly userRepository: InMemoryUserRepository;
  readonly tokenRepository: InMemoryRegistrationApprovalTokenRepository;
  readonly txn: InMemoryRegistrationDecisionTxn;
}

interface ClientDecisionFixture {
  readonly client: Client;
  readonly clientRepository: InMemoryClientRepository;
  readonly tokenRepository: InMemoryClientRegistrationApprovalTokenRepository;
  readonly txn: InMemoryClientRegistrationDecisionTxn;
}

describe("InMemoryRegistrationDecisionTxn", () => {
  const makeUserFixture = async (
    status: "pending" | "active" | "rejected" = "pending",
  ): Promise<UserDecisionFixture> => {
    const userRepository = new InMemoryUserRepository();
    const tokenRepository = new InMemoryRegistrationApprovalTokenRepository();
    const txn = new InMemoryRegistrationDecisionTxn(tokenRepository, userRepository);
    const user = User.create({
      id: `user-${status}`,
      email: `${status}@test.com`,
      passwordHash: "hash",
      role: "user",
      status,
    });
    await userRepository.save(user);
    await tokenRepository.save(
      new RegistrationApprovalToken({
        id: `token-${status}`,
        userId: user.id,
        createdAt: new Date(),
        expiresAt: future(),
      }),
    );
    return { user, userRepository, tokenRepository, txn };
  };

  it("approves a pending registration and removes the token", async () => {
    const { user, userRepository, tokenRepository, txn } = await makeUserFixture();

    const result = await txn.approve("token-pending");

    expect(result.status).toBe("approved");
    expect((await userRepository.findById(user.id))?.status).toBe("active");
    expect(await tokenRepository.findById("token-pending")).toBeNull();
  });

  it("rejects a pending registration and removes the token", async () => {
    const { user, userRepository, tokenRepository, txn } = await makeUserFixture();

    const result = await txn.reject("token-pending");

    expect(result.status).toBe("rejected");
    expect((await userRepository.findById(user.id))?.status).toBe("rejected");
    expect(await tokenRepository.findById("token-pending")).toBeNull();
  });

  it("returns expired, not_found and not_pending outcomes", async () => {
    const { user, tokenRepository, txn } = await makeUserFixture("active");
    expect(await txn.approve("missing-token")).toEqual({ status: "not_found" });

    const expiredTokenRepository = new InMemoryRegistrationApprovalTokenRepository();
    const userRepository = new InMemoryUserRepository();
    const expiredTxn = new InMemoryRegistrationDecisionTxn(expiredTokenRepository, userRepository);
    await userRepository.save(
      User.create({ id: "expired-user", email: "e@test.com", passwordHash: "h", role: "user" }),
    );
    await expiredTokenRepository.save(
      new RegistrationApprovalToken({
        id: "expired-token",
        userId: "expired-user",
        createdAt: past(),
        expiresAt: past(),
      }),
    );
    expect(await expiredTxn.approve("expired-token")).toEqual({ status: "expired" });
    expect(await expiredTokenRepository.findById("expired-token")).toBeNull();

    expect(await txn.approve("token-active")).toEqual({ status: "not_pending" });
    expect(await tokenRepository.findById("token-active")).toBeNull();
    expect(user.status).toBe("active");
  });

  it("serializes concurrent decisions so exactly one wins", async () => {
    const { user, userRepository, tokenRepository, txn } = await makeUserFixture();

    const [approve, reject] = await Promise.all([
      txn.approve("token-pending"),
      txn.reject("token-pending"),
    ]);

    const statuses = [approve.status, reject.status];
    expect(
      statuses.filter((status) => status === "approved" || status === "rejected"),
    ).toHaveLength(1);
    expect(statuses).toContain("not_found");
    expect(["active", "rejected"]).toContain((await userRepository.findById(user.id))?.status);
    expect(await tokenRepository.findById("token-pending")).toBeNull();
  });
});

describe("InMemoryClientRegistrationDecisionTxn", () => {
  const makeClientFixture = async (
    status: "pending" | "active" | "rejected" = "pending",
  ): Promise<ClientDecisionFixture> => {
    const clientRepository = new InMemoryClientRepository();
    const tokenRepository = new InMemoryClientRegistrationApprovalTokenRepository();
    const userRepository = new InMemoryUserRepository();
    await userRepository.save(
      User.create({
        id: "owner-id",
        email: "owner@test.com",
        passwordHash: "hash",
        role: "user",
        status: "active",
      }),
    );
    const txn = new InMemoryClientRegistrationDecisionTxn(
      tokenRepository,
      clientRepository,
      userRepository,
    );
    const client = Client.create({
      id: `client-${status}`,
      userId: "owner-id",
      email: `client-${status}@test.com`,
      passwordHash: "hash",
      name: "Client",
      lastName: status,
      status,
    });
    await clientRepository.save(client);
    await tokenRepository.save({
      id: `client-token-${status}`,
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: future(),
    });
    return { client, clientRepository, tokenRepository, txn };
  };

  it("approves, rejects and consumes pending client tokens", async () => {
    const approved = await makeClientFixture();
    expect((await approved.txn.approve("client-token-pending")).status).toBe("approved");
    expect((await approved.clientRepository.findById(approved.client.id))?.status).toBe("active");
    expect(await approved.tokenRepository.findById("client-token-pending")).toBeNull();

    const rejected = await makeClientFixture();
    expect((await rejected.txn.reject("client-token-pending")).status).toBe("rejected");
    expect((await rejected.clientRepository.findById(rejected.client.id))?.status).toBe("rejected");
    expect(await rejected.tokenRepository.findById("client-token-pending")).toBeNull();
  });

  it("returns expired, not_found and not_pending client outcomes", async () => {
    const { tokenRepository, txn } = await makeClientFixture("active");
    expect(await txn.approve("missing-client-token")).toEqual({ status: "not_found" });
    expect(await txn.approve("client-token-active")).toEqual({ status: "not_pending" });
    expect(await tokenRepository.findById("client-token-active")).toBeNull();

    const clientRepository = new InMemoryClientRepository();
    const expiredTokenRepository = new InMemoryClientRegistrationApprovalTokenRepository();
    const userRepository = new InMemoryUserRepository();
    await userRepository.save(
      User.create({
        id: "owner-id",
        email: "owner@test.com",
        passwordHash: "hash",
        role: "user",
        status: "active",
      }),
    );
    const expiredTxn = new InMemoryClientRegistrationDecisionTxn(
      expiredTokenRepository,
      clientRepository,
      userRepository,
    );
    await clientRepository.save(
      Client.create({
        id: "expired-client",
        userId: "owner-id",
        email: "expired-client@test.com",
        passwordHash: "hash",
        name: "Expired",
        lastName: "Client",
      }),
    );
    await expiredTokenRepository.save({
      id: "expired-client-token",
      clientId: "expired-client",
      createdAt: past(),
      expiresAt: past(),
    });
    expect(await expiredTxn.approve("expired-client-token")).toEqual({ status: "expired" });
    expect(await expiredTokenRepository.findById("expired-client-token")).toBeNull();
  });

  it("serializes concurrent client decisions so exactly one wins", async () => {
    const { client, clientRepository, tokenRepository, txn } = await makeClientFixture();

    const [approve, reject] = await Promise.all([
      txn.approve("client-token-pending"),
      txn.reject("client-token-pending"),
    ]);

    const statuses = [approve.status, reject.status];
    expect(
      statuses.filter((status) => status === "approved" || status === "rejected"),
    ).toHaveLength(1);
    expect(statuses).toContain("not_found");
    expect(["active", "rejected"]).toContain((await clientRepository.findById(client.id))?.status);
    expect(await tokenRepository.findById("client-token-pending")).toBeNull();
  });
});
