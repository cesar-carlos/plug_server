-- AlterTable
ALTER TABLE "bridge_latency_traces" ADD COLUMN "phases_sum_ms" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bridge_latency_traces" ADD COLUMN "phases_schema_version" INTEGER NOT NULL DEFAULT 1;
