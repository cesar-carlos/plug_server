-- CreateTable
CREATE TABLE "client_registration_poll_tokens" (
    "id" VARCHAR(128) NOT NULL,
    "client_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_registration_poll_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_registration_poll_tokens_client_id_key" ON "client_registration_poll_tokens"("client_id");

-- AddForeignKey
ALTER TABLE "client_registration_poll_tokens" ADD CONSTRAINT "client_registration_poll_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
