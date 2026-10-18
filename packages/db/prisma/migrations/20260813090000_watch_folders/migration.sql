-- Ledger #87 PR2: watch folders — rules + per-object tracking.

CREATE TABLE "WatchRule" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "credentialId" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "extensions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "presetId" UUID NOT NULL,
    "outputPrefixTemplate" TEXT NOT NULL,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 120,
    "stabilityChecks" INTEGER NOT NULL DEFAULT 2,
    "maxConcurrentJobs" INTEGER NOT NULL DEFAULT 3,
    "scanCursor" TEXT,
    "errorStreak" INTEGER NOT NULL DEFAULT 0,
    "lastSweepAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WatchRule_name_key" ON "WatchRule"("name");

ALTER TABLE "WatchRule" ADD CONSTRAINT "WatchRule_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "Credential"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WatchRule" ADD CONSTRAINT "WatchRule_presetId_fkey"
    FOREIGN KEY ("presetId") REFERENCES "Preset"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "WatchedObjectState" AS ENUM ('SEEN', 'STABLE', 'SUBMITTED', 'SKIPPED', 'ERROR');

CREATE TABLE "WatchedObject" (
    "id" UUID NOT NULL,
    "watchRuleId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "state" "WatchedObjectState" NOT NULL DEFAULT 'SEEN',
    "size" BIGINT,
    "mtimeMs" DOUBLE PRECISION,
    "stableCount" INTEGER NOT NULL DEFAULT 0,
    "encodingJobId" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchedObject_pkey" PRIMARY KEY ("id")
);

-- The dedup contract (#14 precedent): one row per (rule, key, content
-- identity); a racing second submitter loses on P2002 and treats it as done.
CREATE UNIQUE INDEX "WatchedObject_watchRuleId_objectKey_contentId_key"
    ON "WatchedObject"("watchRuleId", "objectKey", "contentId");

CREATE INDEX "WatchedObject_watchRuleId_state_idx"
    ON "WatchedObject"("watchRuleId", "state");

ALTER TABLE "WatchedObject" ADD CONSTRAINT "WatchedObject_watchRuleId_fkey"
    FOREIGN KEY ("watchRuleId") REFERENCES "WatchRule"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WatchedObject" ADD CONSTRAINT "WatchedObject_encodingJobId_fkey"
    FOREIGN KEY ("encodingJobId") REFERENCES "EncodingJob"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
