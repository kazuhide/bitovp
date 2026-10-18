-- Re-audit 2026-08-29 HIGH-7 / GO 11: release evidence could not be
-- reconstructed from the Dashboard. One row per paid verification run, binding
-- the run to its source identity, provider account, per-scenario verdicts,
-- provider readback, cleanup and the report's seal.
--
-- No DML, no partial index, nothing outside the datamodel — so `migrate diff`
-- can see all of it, per docs/DATABASE-UPGRADES.md's audit standard.
CREATE TABLE "VerificationRun" (
    "id" UUID NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "commit" TEXT NOT NULL DEFAULT 'unknown',
    "checkoutLatestMigration" TEXT NOT NULL DEFAULT 'unknown',
    "dbLatestMigration" TEXT NOT NULL DEFAULT 'unknown',
    "drift" BOOLEAN NOT NULL DEFAULT false,
    "bitmovinAccountId" UUID,
    "baseUrlOrigin" TEXT,
    "actor" TEXT,
    "sourceObject" TEXT,
    "sourceIdentity" TEXT,
    "resumedFromRunId" TEXT,
    "outcomes" JSONB NOT NULL DEFAULT '[]',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "providerReadback" JSONB,
    "cleanup" JSONB,
    "reportPath" TEXT NOT NULL,
    "reportSha256" TEXT,
    "seal" TEXT,
    "sealedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

-- The reservation itself: a second host starting the same --run-id gets P2002
-- instead of spending into another run's prefix.
CREATE UNIQUE INDEX "VerificationRun_runId_key" ON "VerificationRun"("runId");

CREATE INDEX "VerificationRun_startedAt_idx" ON "VerificationRun"("startedAt" DESC);

CREATE INDEX "VerificationRun_bitmovinAccountId_idx" ON "VerificationRun"("bitmovinAccountId");

-- SetNull, not Cascade: deleting a Bitmovin account must not delete the
-- evidence of what it was billed for.
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_bitmovinAccountId_fkey" FOREIGN KEY ("bitmovinAccountId") REFERENCES "BitmovinAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
