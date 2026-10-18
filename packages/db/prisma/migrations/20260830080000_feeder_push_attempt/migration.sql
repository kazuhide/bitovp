-- Attempt-bound feeder evidence.
--
-- This is an additive table and is safe to deploy before the worker image.
-- Old workers do not write it; therefore the release queue must remain paused
-- until every publisher-capable worker is on the attempt-aware image. Resume
-- only after `prisma migrate status` and the image-set check are green.

CREATE TABLE "FeederPushAttempt" (
    "id" UUID NOT NULL,
    "liveScheduleId" UUID,
    "liveChannelRunId" UUID,
    "feederSessionId" UUID NOT NULL,
    "ownerGeneration" INTEGER NOT NULL,
    "publisherGeneration" INTEGER NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "pid" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "processSpawnedAt" TIMESTAMP(3),
    "evidenceNotBefore" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "exitSignal" TEXT,
    "sanitizedTarget" TEXT NOT NULL,
    "codecDecision" JSONB NOT NULL,
    "sourceSha256" TEXT,
    "providerSampleAt" TIMESTAMP(3),
    "providerStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "providerAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeederPushAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeederPushAttempt_feederSessionId_ownerGeneration_attemptNo_key"
ON "FeederPushAttempt"("feederSessionId", "ownerGeneration", "attemptNo");

CREATE INDEX "FeederPushAttempt_liveScheduleId_startedAt_idx"
ON "FeederPushAttempt"("liveScheduleId", "startedAt");

CREATE INDEX "FeederPushAttempt_liveChannelRunId_startedAt_idx"
ON "FeederPushAttempt"("liveChannelRunId", "startedAt");

CREATE INDEX "FeederPushAttempt_feederSessionId_startedAt_idx"
ON "FeederPushAttempt"("feederSessionId", "startedAt");
