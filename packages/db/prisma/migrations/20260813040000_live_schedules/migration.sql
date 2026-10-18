-- One-shot schedules (START/STOP/SLATE_IN) and the channel runtime cap.

CREATE TYPE "LiveScheduleStatus" AS ENUM ('ARMED', 'FIRED', 'COMPLETED', 'CANCELED', 'MISSED', 'ERROR');
CREATE TYPE "LiveScheduleAction" AS ENUM ('START', 'STOP', 'SLATE_IN');

ALTER TABLE "LiveChannel" ADD COLUMN "maxRunMinutes" INTEGER;

CREATE TABLE "LiveSchedule" (
    "id" UUID NOT NULL,
    "liveChannelId" UUID NOT NULL,
    "action" "LiveScheduleAction" NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "insertableContentId" TEXT,
    "slateDurationSeconds" INTEGER,
    "status" "LiveScheduleStatus" NOT NULL DEFAULT 'ARMED',
    "firedAt" TIMESTAMP(3),
    "note" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LiveSchedule_status_fireAt_idx" ON "LiveSchedule"("status", "fireAt");
CREATE INDEX "LiveSchedule_liveChannelId_idx" ON "LiveSchedule"("liveChannelId");

ALTER TABLE "LiveSchedule" ADD CONSTRAINT "LiveSchedule_liveChannelId_fkey"
    FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- review-190 I6: the cap reads an indexed column, never step logs; a
-- restart writes a fresh epoch.
ALTER TABLE "LiveChannel" ADD COLUMN "runningSince" TIMESTAMP(3);

-- review-190 I1: the cap's claim must be ATOMIC. fireAt is derived from
-- runningSince + cap, so every worker computes the same value for one
-- epoch — the partial unique index makes the second creator lose on P2002.
CREATE UNIQUE INDEX "LiveSchedule_cap_epoch_key"
    ON "LiveSchedule"("liveChannelId", "fireAt")
    WHERE "note" = 'max-run-cap';
