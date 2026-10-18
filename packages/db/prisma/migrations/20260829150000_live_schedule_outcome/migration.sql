-- Ledger #238: a schedule row's DELIVERY, separated from its firing.
--
-- `status = FIRED` only ever meant "the request left this system". The
-- 2026-08-29 live audit's paid run #4 fired a SLATE_IN, the provider's
-- scheduled entry went ERROR, the picture never changed, and the local row
-- stayed FIRED with a green badge and a DONE step. `outcome` is what the
-- provider / session / channel actually did with the request.
--
-- Pure DDL + one backfill, no behaviour: the writers land with the code.

-- CreateEnum
CREATE TYPE "LiveScheduleOutcome" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "LiveSchedule" ADD COLUMN     "outcome" "LiveScheduleOutcome" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "outcomeAt" TIMESTAMP(3),
ADD COLUMN     "outcomeNote" TEXT,
ADD COLUMN     "feederSessionId" UUID;

-- CreateIndex
CREATE INDEX "LiveSchedule_feederSessionId_idx" ON "LiveSchedule"("feederSessionId");

-- Historical rows that ALREADY fired read UNKNOWN, not PENDING.
--
-- PENDING is a claim about the future: "the job that fired this row is still
-- running and will write the answer". For a row fired before this column
-- existed that claim is false — the job is long gone and no writer will ever
-- arrive. UNKNOWN says the true thing: it fired, and we hold no evidence of
-- delivery. Both render amber, so neither direction invents a false green;
-- the difference is whether an answer is still coming.
--
-- Rows in every other status are left PENDING: ARMED has not fired yet, and
-- COMPLETED / CANCELED / MISSED / ERROR are already terminal verdicts the UI
-- reads from `status` without consulting the outcome at all.
UPDATE "LiveSchedule" SET "outcome" = 'UNKNOWN' WHERE "status" = 'FIRED';
