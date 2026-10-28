import { conflict } from "../../shared/errors/http_errors";
import { enqueuePwaDeliveries } from "../persistence/enqueue_pwa_deliveries";
import { prismaClient } from "../database/prisma/client";
import type {
  PwaPushJob,
  PwaPushMessage,
  PwaPushStore,
  PwaPushSubscription,
} from "../../domain/ports/pwa_push.port";
export class PrismaPwaPushStore implements PwaPushStore {
  async save(input: PwaPushSubscription): Promise<void> {
    try {
      const updated = await prismaClient.pwaSubscription.updateMany({
        where: { installationId: input.installationId, clientId: input.clientId },
        data: { endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth },
      });
      if (updated.count === 0) await prismaClient.pwaSubscription.create({ data: input });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        throw conflict("Subscription is already registered to another installation");
      }
      throw error;
    }
  }
  async remove(clientId: string, installationId: string): Promise<void> {
    await prismaClient.$transaction([
      prismaClient.pwaSubscription.deleteMany({ where: { clientId, installationId } }),
      prismaClient.pwaDelivery.updateMany({
        where: { clientId, installationId, done: false },
        data: { done: true },
      }),
    ]);
  }
  async enqueue(clientId: string, message: PwaPushMessage): Promise<void> {
    await prismaClient.$transaction((tx) => enqueuePwaDeliveries(tx, clientId, message));
  }

  async claim(now: Date): Promise<PwaPushJob | null> {
    const row = await prismaClient.pwaDelivery.findFirst({
      where: { done: false, attempts: { lt: 3 }, availableAt: { lte: now } },
      orderBy: { availableAt: "asc" },
    });
    if (!row) return null;
    const lease = await prismaClient.pwaDelivery.updateMany({
      where: { id: row.id, done: false, attempts: row.attempts, availableAt: { lte: now } },
      data: { attempts: { increment: 1 }, availableAt: new Date(now.getTime() + 60_000) },
    });
    if (!lease.count) return null;
    const subscription = await prismaClient.pwaSubscription.findUnique({
      where: { installationId: row.installationId },
    });
    if (!subscription || subscription.clientId !== row.clientId) {
      await this.complete(row.id);
      return null;
    }
    if (row.type !== "access-approved" && row.type !== "access-revoked") {
      await this.complete(row.id);
      return null;
    }
    return {
      id: row.id,
      subscription,
      attempts: row.attempts + 1,
      message: { eventId: row.eventId, type: row.type },
    };
  }
  async complete(id: string): Promise<void> {
    await prismaClient.pwaDelivery.updateMany({ where: { id }, data: { done: true } });
  }
  async retry(id: string, next: Date): Promise<void> {
    await prismaClient.pwaDelivery.updateMany({ where: { id }, data: { availableAt: next } });
  }
}
