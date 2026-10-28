import { enqueuePwaDeliveries } from "../../src/infrastructure/persistence/enqueue_pwa_deliveries";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaPwaPushStore } from "../../src/infrastructure/repositories/prisma_pwa_push_store";
import { prismaClient } from "../../src/infrastructure/database/prisma/client";

// Opt in only against a dedicated database created for this test.
describe.skipIf(process.env.PWA_DATABASE_TEST !== "true")("PWA PostgreSQL persistence", () => {
  const store = new PrismaPwaPushStore();
  const clientId = randomUUID();
  const installationId = randomUUID();
  const subscription = {
    clientId,
    installationId,
    endpoint: `https://fcm.googleapis.com/fcm/send/${installationId}`,
    p256dh: "test",
    auth: "test",
  };
  afterAll(async () => {
    await prismaClient.pwaDelivery.deleteMany({ where: { clientId } });
    await prismaClient.pwaSubscription.deleteMany({ where: { clientId } });
    await prismaClient.$disconnect();
  });
  it("rolls back queued deliveries when the enclosing decision transaction fails", async () => {
    await store.save(subscription);
    await expect(
      prismaClient.$transaction(async (tx) => {
        await enqueuePwaDeliveries(tx, clientId, {
          eventId: "rolled-back",
          type: "access-revoked",
        });
        throw new Error("decision failed");
      }),
    ).rejects.toThrow("decision failed");
    expect(
      await prismaClient.pwaDelivery.count({ where: { clientId, eventId: "rolled-back" } }),
    ).toBe(0);
  });
  it("deduplicates events, claims once, and preserves subscription ownership", async () => {
    await store.save(subscription);
    await expect(store.save({ ...subscription, clientId: randomUUID() })).rejects.toMatchObject({
      statusCode: 409,
    });
    await Promise.all([
      store.enqueue(clientId, { eventId: "event-1", type: "access-approved" }),
      store.enqueue(clientId, { eventId: "event-1", type: "access-approved" }),
    ]);
    expect(await prismaClient.pwaDelivery.count({ where: { clientId } })).toBe(1);
    const jobs = await Promise.all([store.claim(new Date()), store.claim(new Date())]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
    const job = jobs.find(Boolean)!;
    expect(job.subscription.clientId).toBe(clientId);
    await store.retry(job.id, new Date(Date.now() - 1));
    expect((await store.claim(new Date()))?.attempts).toBe(2);
    await store.remove(randomUUID(), installationId);
    expect(await prismaClient.pwaSubscription.count({ where: { installationId } })).toBe(1);
    await store.remove(clientId, installationId);
    expect(await prismaClient.pwaSubscription.count({ where: { installationId } })).toBe(0);
    expect(await store.claim(new Date(Date.now() + 120000))).toBeNull();
  });
});
