-- P3-PR3 feeder: the v1 PseudoLiveFeed placeholder (never written by app
-- code) is superseded by the FeederSession lifecycle row, the PR2 precedent
-- (placeholder schema drops when the real lifecycle lands). The SRT
-- passphrase is never stored (vault credentialId ref only, resolved at
-- spawn); target.streamKey rides the same ledgered redaction exception as
-- LiveChannel.streamKey (the worker must rebuild the push URL across
-- restarts). loopBoundaries is the C7-style local truth P4 VMAF live
-- alignment depends on.

-- DropForeignKey
ALTER TABLE "PseudoLiveFeed" DROP CONSTRAINT "PseudoLiveFeed_liveChannelId_fkey";

-- DropTable
DROP TABLE "PseudoLiveFeed";

-- DropEnum
DROP TYPE "FeedState";

-- CreateEnum
CREATE TYPE "FeederStatus" AS ENUM ('CREATED', 'DOWNLOADING', 'PUSHING', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "FeederProtocol" AS ENUM ('RTMP', 'SRT_CALLER');

-- CreateTable
CREATE TABLE "FeederSession" (
    "id" UUID NOT NULL,
    "liveChannelId" UUID NOT NULL,
    "status" "FeederStatus" NOT NULL DEFAULT 'CREATED',
    "sourceCredentialId" UUID NOT NULL,
    "sourceBucket" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "protocol" "FeederProtocol" NOT NULL,
    "target" JSONB NOT NULL,
    "pid" INTEGER,
    "loopBoundaries" JSONB NOT NULL DEFAULT '[]',
    "logTail" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeederSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeederSession_liveChannelId_idx" ON "FeederSession"("liveChannelId");

-- CreateIndex
CREATE INDEX "FeederSession_status_createdAt_idx" ON "FeederSession"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "FeederSession_createdAt_idx" ON "FeederSession"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "FeederSession" ADD CONSTRAINT "FeederSession_liveChannelId_fkey" FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
