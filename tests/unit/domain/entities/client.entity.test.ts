import { describe, expect, it } from "vitest";

import { Client } from "../../../../src/domain/entities/client.entity";

describe("Client", () => {
  it("defaults new clients to pending", () => {
    const client = Client.create({
      userId: "owner-user-id",
      email: "client@test.com",
      passwordHash: "hash",
      name: "Client",
      lastName: "Pending",
    });

    expect(client.status).toBe("pending");
  });
});
