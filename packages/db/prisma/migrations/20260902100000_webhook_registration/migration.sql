-- WP-G G-2 — per-encoding webhook registrations. One row per (encoding,
-- kind) the worker's registrar created with Bitmovin's createByEncodingId,
-- plus the rows it could not create (SKIPPED: no public ingress; FAILED:
-- provider error, retried with backoff). Additive only: a new enum, a new
-- table, and two nullable id columns on WebhookEvent that record which job /
-- run a `j`-scope delivery was registered for. No data is rewritten.
--
-- The job/run foreign keys are ON DELETE SET NULL, not CASCADE, on purpose:
-- the row must outlive its job so the registrar can still delete the hook
-- at the provider from what the row itself knows (bitmovinAccountId +
-- encodingId + providerWebhookId). Rolling out ahead of a worker that does
-- not know this table is harmless — nothing reads it until the registrar
-- runs; rolling back means dropping the table, which orphans nothing.

-- CreateEnum
CREATE TYPE "WebhookRegistrationStatus" AS ENUM ('ACTIVE', 'SKIPPED', 'FAILED', 'DELETED');

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "encodingJobId" UUID,
ADD COLUMN     "liveChannelRunId" UUID;

-- CreateTable
CREATE TABLE "WebhookRegistration" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'j',
    "encodingJobId" UUID,
    "liveChannelRunId" UUID,
    "bitmovinAccountId" UUID NOT NULL,
    "encodingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "WebhookRegistrationStatus" NOT NULL DEFAULT 'SKIPPED',
    "providerWebhookId" TEXT,
    "url" TEXT,
    "tokenHash" TEXT,
    "keyId" TEXT,
    "note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookRegistration_tokenHash_idx" ON "WebhookRegistration"("tokenHash");

-- CreateIndex
CREATE INDEX "WebhookRegistration_status_idx" ON "WebhookRegistration"("status");

-- CreateIndex
CREATE INDEX "WebhookRegistration_encodingJobId_idx" ON "WebhookRegistration"("encodingJobId");

-- CreateIndex
CREATE INDEX "WebhookRegistration_liveChannelRunId_idx" ON "WebhookRegistration"("liveChannelRunId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookRegistration_encodingId_kind_key" ON "WebhookRegistration"("encodingId", "kind");

-- AddForeignKey
ALTER TABLE "WebhookRegistration" ADD CONSTRAINT "WebhookRegistration_encodingJobId_fkey" FOREIGN KEY ("encodingJobId") REFERENCES "EncodingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRegistration" ADD CONSTRAINT "WebhookRegistration_liveChannelRunId_fkey" FOREIGN KEY ("liveChannelRunId") REFERENCES "LiveChannelRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
