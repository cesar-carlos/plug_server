CREATE TABLE "PwaSubscription" (
  "installationId" UUID PRIMARY KEY, "clientId" UUID NOT NULL,
  "endpoint" TEXT NOT NULL UNIQUE, "p256dh" TEXT NOT NULL, "auth" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PwaSubscription_clientId_idx" ON "PwaSubscription"("clientId");
CREATE TABLE "PwaDelivery" (
  "id" UUID PRIMARY KEY, "installationId" UUID NOT NULL, "clientId" UUID NOT NULL,
  "eventId" TEXT NOT NULL, "type" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "done" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "PwaDelivery_installationId_eventId_key" ON "PwaDelivery"("installationId", "eventId");
CREATE INDEX "PwaDelivery_done_availableAt_idx" ON "PwaDelivery"("done", "availableAt");
