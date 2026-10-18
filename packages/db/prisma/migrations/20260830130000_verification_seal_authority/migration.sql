-- Audit 5c3d97ca HIGH-6 / EV-03: one authority for DB, report, seal,
-- fingerprint, scenario evidence and retention. Key material is never stored.
ALTER TABLE "VerificationRun"
    ADD COLUMN "resumedFromId" UUID,
    ADD COLUMN "resumeDecision" JSONB,
    ADD COLUMN "sealAlgorithm" TEXT,
    ADD COLUMN "sealKeyId" TEXT,
    ADD COLUMN "evidenceVersion" INTEGER,
    ADD COLUMN "evidenceManifest" JSONB,
    ADD COLUMN "retentionUntil" TIMESTAMP(3);

-- The old column held the prior run's public runId as unconstrained text.
-- Preserve every resolvable link, then remove the competing authority. An
-- unresolved legacy value remains visible in historical report bytes, but is
-- deliberately not promoted to a trusted relation.
UPDATE "VerificationRun" AS current
SET "resumedFromId" = prior."id"
FROM "VerificationRun" AS prior
WHERE current."resumedFromRunId" = prior."runId";

ALTER TABLE "VerificationRun" DROP COLUMN "resumedFromRunId";

CREATE INDEX "VerificationRun_resumedFromId_idx" ON "VerificationRun"("resumedFromId");
CREATE INDEX "VerificationRun_retentionUntil_idx" ON "VerificationRun"("retentionUntil");

ALTER TABLE "VerificationRun"
    ADD CONSTRAINT "VerificationRun_resumedFromId_fkey"
    FOREIGN KEY ("resumedFromId") REFERENCES "VerificationRun"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
