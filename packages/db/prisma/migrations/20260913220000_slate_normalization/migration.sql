-- CreateEnum
CREATE TYPE "SlateNormalizationStatus" AS ENUM ('WAITING_FOR_INPUT', 'QUEUED', 'NORMALIZING', 'REGISTERING', 'READY', 'ERROR');

-- CreateTable
CREATE TABLE "SlateNormalization" (
    "id" UUID NOT NULL,
    "liveChannelId" UUID NOT NULL,
    "bitmovinAccountId" UUID NOT NULL,
    "name" TEXT,
    "credentialId" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "status" "SlateNormalizationStatus" NOT NULL DEFAULT 'QUEUED',
    "target" JSONB,
    "note" TEXT,
    "error" TEXT,
    "registeredKey" TEXT,
    "normalized" BOOLEAN NOT NULL DEFAULT false,
    "insertableContentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlateNormalization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlateNormalization_liveChannelId_status_idx" ON "SlateNormalization"("liveChannelId", "status");

-- CreateIndex
CREATE INDEX "SlateNormalization_status_updatedAt_idx" ON "SlateNormalization"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "SlateNormalization" ADD CONSTRAINT "SlateNormalization_liveChannelId_fkey" FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
