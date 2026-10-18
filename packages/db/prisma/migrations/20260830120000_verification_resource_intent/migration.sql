-- EV-01 · audit 5c3d97ca BLOCKER-5 (§14.4): a paid create's id lived only in
-- the HTTP response. A timeout, a reset or an unparseable body between the
-- server's create and `jobId = …` / `channelId = …` left the harness with
-- NOTHING cleanup could act on while the job or channel billed.
--
-- Three additive changes, all datamodel-expressible (no DML, no partial index
-- — `migrate diff` sees every statement, per MIGRATIONS.md's audit standard):
--
--   1. EncodingJob / LiveChannel gain a nullable UNIQUE `verificationKey` and
--      the `verificationRequestSha256` the harness sent with it. The create
--      routes return the existing row for a repeat of the same key + SHA and
--      409 a repeat with a different SHA, so a lost response is recoverable by
--      the key alone. Ordinary jobs and channels never carry either column.
--   2. VerificationResourceIntent: the durable intent, written BEFORE the
--      create is sent (PREPARED → SUBMITTED → CONFIRMED | AMBIGUOUS → TERMINAL)
--      with its cleanup state; the run's seal reads this set, never memory.
--      Cascade from VerificationRun: an intent is a child of the run's evidence.
--   3. The unique index on the intent's key: one intent per paid resource
--      across every run sharing this database.
--
-- Generated with `prisma migrate diff --from-schema-datamodel <main>
-- --to-schema-datamodel <this branch> --script`; only this header was added.

-- AlterTable
ALTER TABLE "EncodingJob" ADD COLUMN     "verificationKey" TEXT,
ADD COLUMN     "verificationRequestSha256" TEXT;

-- AlterTable
ALTER TABLE "LiveChannel" ADD COLUMN     "verificationKey" TEXT,
ADD COLUMN     "verificationRequestSha256" TEXT;

-- CreateTable
CREATE TABLE "VerificationResourceIntent" (
    "id" UUID NOT NULL,
    "verificationRunId" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "verificationKey" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "resourceName" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "localId" TEXT,
    "providerId" TEXT,
    "providerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "candidates" JSONB,
    "cleanupState" TEXT NOT NULL DEFAULT 'PENDING',
    "readback" JSONB,
    "possiblyCreatedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cleanedResourceKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "closureDigest" TEXT,
    "sealedAt" TIMESTAMP(3),
    "eventSeq" INTEGER NOT NULL DEFAULT 0,
    "recoveryOwner" TEXT,
    "recoveryLeaseUntil" TIMESTAMP(3),
    "recoveryGeneration" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationResourceIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationResourceIntentEvent" (
    "id" UUID NOT NULL,
    "verificationResourceIntentId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "cleanupState" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationResourceIntentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationResourceIntent_verificationKey_key" ON "VerificationResourceIntent"("verificationKey");

-- CreateIndex
CREATE INDEX "VerificationResourceIntent_verificationRunId_idx" ON "VerificationResourceIntent"("verificationRunId");

-- CreateIndex
CREATE INDEX "VerificationResourceIntent_state_idx" ON "VerificationResourceIntent"("state");

-- CreateIndex
CREATE INDEX "VerificationResourceIntent_state_recoveryLeaseUntil_idx" ON "VerificationResourceIntent"("state", "recoveryLeaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationResourceIntentEvent_verificationResourceIntentId_sequence_key" ON "VerificationResourceIntentEvent"("verificationResourceIntentId", "sequence");

-- CreateIndex
CREATE INDEX "VerificationResourceIntentEvent_createdAt_idx" ON "VerificationResourceIntentEvent"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EncodingJob_verificationKey_key" ON "EncodingJob"("verificationKey");

-- CreateIndex
CREATE UNIQUE INDEX "LiveChannel_verificationKey_key" ON "LiveChannel"("verificationKey");

-- AddForeignKey
ALTER TABLE "VerificationResourceIntent" ADD CONSTRAINT "VerificationResourceIntent_verificationRunId_fkey" FOREIGN KEY ("verificationRunId") REFERENCES "VerificationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationResourceIntentEvent" ADD CONSTRAINT "VerificationResourceIntentEvent_verificationResourceIntentId_fkey" FOREIGN KEY ("verificationResourceIntentId") REFERENCES "VerificationResourceIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
