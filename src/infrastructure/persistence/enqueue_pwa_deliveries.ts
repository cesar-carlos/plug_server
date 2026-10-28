import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { PwaPushMessage } from "../../domain/ports/pwa_push.port";

/** Persist deliveries inside the access decision transaction. */
export async function enqueuePwaDeliveries(
  tx: Pick<Prisma.TransactionClient, "pwaSubscription" | "pwaDelivery">,
  clientId: string,
  message: PwaPushMessage,
): Promise<void> {
  const subscriptions = await tx.pwaSubscription.findMany({
    where: { clientId },
    select: { installationId: true },
  });
  if (subscriptions.length === 0) return;
  await tx.pwaDelivery.createMany({
    data: subscriptions.map(({ installationId }) => ({
      id: randomUUID(),
      installationId,
      clientId,
      eventId: message.eventId,
      type: message.type,
    })),
    skipDuplicates: true,
  });
}
