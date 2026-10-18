-- Audit 5c3d97ca SC-01: durable, generation-fenced external-effect intents.
--
-- Rollout is additive. Existing channels start at fence version 0; the first
-- run transition or effect claim advances it. Existing work has no claim and
-- is never inferred to have one.
CREATE TYPE "LiveEffectClaimState" AS ENUM (
  'CLAIMED',
  'DISPATCHING',
  'ACKED',
  'FAILED',
  'AMBIGUOUS'
);

ALTER TABLE "LiveChannel"
  ADD COLUMN "liveEffectFenceVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "LiveEffectClaim" (
  "id" UUID NOT NULL,
  "liveChannelId" UUID NOT NULL,
  "liveChannelRunId" UUID NOT NULL,
  "scheduleId" UUID,
  "action" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "providerEncodingId" TEXT NOT NULL,
  "targetId" TEXT,
  "generation" INTEGER NOT NULL,
  "state" "LiveEffectClaimState" NOT NULL DEFAULT 'CLAIMED',
  "token" UUID NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "ownerId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "dispatchedAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "failure" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveEffectClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveEffectClaim_idempotencyKey_key"
  ON "LiveEffectClaim"("idempotencyKey");
CREATE UNIQUE INDEX "LiveEffectClaim_token_key"
  ON "LiveEffectClaim"("token");
CREATE INDEX "LiveEffectClaim_liveChannelId_state_idx"
  ON "LiveEffectClaim"("liveChannelId", "state");
CREATE INDEX "LiveEffectClaim_scheduleId_idx"
  ON "LiveEffectClaim"("scheduleId");
CREATE INDEX "LiveEffectClaim_state_expiresAt_idx"
  ON "LiveEffectClaim"("state", "expiresAt");

ALTER TABLE "LiveEffectClaim"
  ADD CONSTRAINT "LiveEffectClaim_liveChannelId_fkey"
  FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- MEDIUM-2: only the exact historical contradiction is backfilled. Before
-- this migration the stale transition wrote status but left outcome PENDING.
-- Counts are emitted during deploy so the operator can retain the measured
-- population; no other PENDING schedule is touched.
DO $$
DECLARE
  before_count BIGINT;
  changed_count BIGINT;
BEGIN
  SELECT count(*) INTO before_count
    FROM "LiveSchedule"
   WHERE status = 'SKIPPED_STALE_GENERATION'
     AND outcome = 'PENDING';

  UPDATE "LiveSchedule"
     SET outcome = 'FAILED',
         "outcomeAt" = COALESCE("firedAt", "updatedAt"),
         "outcomeNote" = COALESCE(
           note,
           'Legacy stale-generation refusal: the action was not delivered'
         )
   WHERE status = 'SKIPPED_STALE_GENERATION'
     AND outcome = 'PENDING';
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  RAISE NOTICE 'SC-01 stale schedule backfill: before=%, changed=%',
    before_count, changed_count;
END $$;
