-- Audit 5c3d97ca BLOCKER-4 (§14.4 EV-02): a Live/MSL PASS rested on facts that
-- were never joined — the run row carried a channel id, a report and a cleanup
-- seal, but no plan digest, no source identity, no provider resource, no output
-- prefix / edge URL and no media bytes, and the edge closure could close on
-- zero segments. One row per (run, scenario, airing, output leg) is the join:
-- `tuple` is core's versioned LiveEvidenceLeg, `complete` its single
-- completeness rule, and the run recorder refuses SEALED while a green live
-- outcome has an incomplete leg.
--
-- Additive only: a new table and its FK. No DML, no partial index, nothing
-- outside the datamodel — so `migrate diff` can see all of it, per
-- prisma/migrations/MIGRATIONS.md's audit standard. `liveChannelRunId` is TEXT
-- on purpose (no FK): the evidence must outlive the channel row it names.
CREATE TABLE "VerificationLiveEvidence" (
    "id" UUID NOT NULL,
    "verificationRunId" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "liveChannelRunId" TEXT NOT NULL,
    "outputLeg" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "missing" JSONB NOT NULL DEFAULT '[]',
    "tuple" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationLiveEvidence_pkey" PRIMARY KEY ("id")
);

-- One tuple per (run, scenario, airing, leg): a re-run of the same scenario in
-- the same run upserts its leg rather than accumulating a second story.
CREATE UNIQUE INDEX "VerificationLiveEvidence_verificationRunId_scenario_liveChan_key" ON "VerificationLiveEvidence"("verificationRunId", "scenario", "liveChannelRunId", "outputLeg");

CREATE INDEX "VerificationLiveEvidence_verificationRunId_idx" ON "VerificationLiveEvidence"("verificationRunId");

-- Cascade: the tuple is a CHILD of the run row and means nothing without it —
-- the run row itself keeps SetNull towards the billed account (its own rule).
ALTER TABLE "VerificationLiveEvidence" ADD CONSTRAINT "VerificationLiveEvidence_verificationRunId_fkey" FOREIGN KEY ("verificationRunId") REFERENCES "VerificationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
