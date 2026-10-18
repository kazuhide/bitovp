-- LiveChannel becomes the P3-PR2 lifecycle row: compiled step-log replay
-- (CREATED → PROVISIONING → RUNNING steady state) plus STOPPING/STOPPED
-- action states. The placeholder v1 columns (state/ingest/dvr/stateTimeline,
-- never written by app code) are replaced by status/stepLog/streamKey/
-- encoderIp/error; streamKey is the ledgered redaction exception
-- (connection-routing material — JSON snapshots still mask it).

-- CreateEnum
CREATE TYPE "LiveChannelStatus" AS ENUM ('CREATED', 'PROVISIONING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR');

-- AlterTable
ALTER TABLE "LiveChannel"
    DROP COLUMN "state",
    DROP COLUMN "ingest",
    DROP COLUMN "dvr",
    DROP COLUMN "stateTimeline",
    ADD COLUMN "status" "LiveChannelStatus" NOT NULL DEFAULT 'CREATED',
    ADD COLUMN "stepLog" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "streamKey" TEXT,
    ADD COLUMN "encoderIp" TEXT,
    ADD COLUMN "error" TEXT;

-- DropEnum
DROP TYPE "LiveChannelState";

-- CreateIndex
CREATE INDEX "LiveChannel_status_createdAt_idx" ON "LiveChannel"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "LiveChannel_createdAt_idx" ON "LiveChannel"("createdAt" DESC);
