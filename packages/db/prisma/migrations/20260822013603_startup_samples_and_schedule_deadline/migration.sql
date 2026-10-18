-- CreateEnum
CREATE TYPE "StartupSampleSource" AS ENUM ('CHANNEL', 'PROBE');

-- CreateEnum
CREATE TYPE "StartupOutcome" AS ENUM ('RUNNING', 'FAILED', 'CENSORED');

-- AlterTable
ALTER TABLE "LiveChannelRun" ADD COLUMN     "queueSeconds" INTEGER;

-- AlterTable
ALTER TABLE "LiveSchedule" ADD COLUMN     "airAt" TIMESTAMP(3),
ADD COLUMN     "deadlineMarginSeconds" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "deadlineNotifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StartupSample" (
    "id" UUID NOT NULL,
    "cloudRegion" TEXT NOT NULL,
    "infrastructureId" TEXT,
    "bitmovinAccountId" TEXT,
    "source" "StartupSampleSource" NOT NULL,
    "outcome" "StartupOutcome" NOT NULL,
    "failedPhase" TEXT,
    "queueSeconds" INTEGER,
    "totalSeconds" INTEGER,
    "encoderVersion" TEXT,
    "liveChannelRunId" UUID,
    "poolAcquired" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StartupSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StartupSample_liveChannelRunId_key" ON "StartupSample"("liveChannelRunId");

-- CreateIndex
CREATE INDEX "StartupSample_cloudRegion_source_observedAt_idx" ON "StartupSample"("cloudRegion", "source", "observedAt" DESC);
