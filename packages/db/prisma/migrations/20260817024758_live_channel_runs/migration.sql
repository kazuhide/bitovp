-- AlterTable
ALTER TABLE "FeederSession" ADD COLUMN     "liveChannelRunId" UUID;

-- AlterTable
ALTER TABLE "LiveHeartbeat" ADD COLUMN     "liveChannelRunId" UUID;

-- CreateTable
CREATE TABLE "LiveChannelRun" (
    "id" UUID NOT NULL,
    "liveChannelId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "LiveChannelStatus" NOT NULL DEFAULT 'CREATED',
    "bitmovinEncodingId" TEXT,
    "stepLog" JSONB NOT NULL DEFAULT '[]',
    "encoderIp" TEXT,
    "streamKey" TEXT,
    "outputPrefix" TEXT NOT NULL,
    "runningSince" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "programStartAt" TIMESTAMP(3),
    "programEndAt" TIMESTAMP(3),
    "error" TEXT,
    "liveToVod" JSONB,
    "lastHeartbeat" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveChannelRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveChannelRun_bitmovinEncodingId_key" ON "LiveChannelRun"("bitmovinEncodingId");

-- CreateIndex
CREATE INDEX "LiveChannelRun_liveChannelId_createdAt_idx" ON "LiveChannelRun"("liveChannelId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LiveChannelRun_liveChannelId_seq_key" ON "LiveChannelRun"("liveChannelId", "seq");

-- AddForeignKey
ALTER TABLE "LiveChannelRun" ADD CONSTRAINT "LiveChannelRun_liveChannelId_fkey" FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveHeartbeat" ADD CONSTRAINT "LiveHeartbeat_liveChannelRunId_fkey" FOREIGN KEY ("liveChannelRunId") REFERENCES "LiveChannelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeederSession" ADD CONSTRAINT "FeederSession_liveChannelRunId_fkey" FOREIGN KEY ("liveChannelRunId") REFERENCES "LiveChannelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------------
-- Hand-written section (ledger #108 §2/§6 — the #83 precedent; keep the
-- checksum in sync per docs/DATABASE-UPGRADES.md if this file is edited after applying).
-- ------------------------------------------------------------------------

-- At most ONE non-terminal run per channel (closes ledger #48's duplicate-
-- encoding half BY CONSTRUCTION): run creation INSERTs CREATED; a lost race
-- is a unique violation answered as 409. Prisma cannot express a partial
-- unique index declaratively.
CREATE UNIQUE INDEX "LiveChannelRun_one_live_per_channel"
  ON "LiveChannelRun"("liveChannelId")
  WHERE "status" IN ('CREATED','PROVISIONING','RUNNING','STOPPING');

-- Backfill (§6 step 2): one run per channel THAT HAS EVIDENCE OF ONE — an
-- encoding id, or any status past CREATED. A never-started channel gets NO
-- row (it derives IDLE; a backfilled CREATED row would occupy the partial
-- unique index and block the channel's first real start). outputPrefix ''
-- records honestly that run #1 wrote at the plan's own paths (pre-#108).
INSERT INTO "LiveChannelRun" (
  "id", "liveChannelId", "seq", "status", "bitmovinEncodingId", "stepLog",
  "encoderIp", "streamKey", "outputPrefix", "runningSince",
  "programStartAt", "programEndAt", "error", "liveToVod", "lastHeartbeat",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), c."id", 1, c."status", c."bitmovinEncodingId",
  c."stepLog", c."encoderIp", c."streamKey", '', c."runningSince",
  c."programStartAt", c."programEndAt", c."error", c."liveToVod",
  c."lastHeartbeat", c."createdAt", c."updatedAt"
FROM "LiveChannel" c
WHERE c."bitmovinEncodingId" IS NOT NULL OR c."status" <> 'CREATED';

-- Re-point child rows at the backfilled run (nullable through the two-step
-- move; rows of never-started channels keep NULL, which is the truth).
UPDATE "LiveHeartbeat" h
SET "liveChannelRunId" = r."id"
FROM "LiveChannelRun" r
WHERE r."liveChannelId" = h."liveChannelId" AND r."seq" = 1;

UPDATE "FeederSession" f
SET "liveChannelRunId" = r."id"
FROM "LiveChannelRun" r
WHERE r."liveChannelId" = f."liveChannelId" AND r."seq" = 1;
