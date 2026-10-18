-- review-259 116-A1: the orchestrator's terminal transition gets its own
-- timestamp. updatedAt is @updatedAt (client-maintained, bumped by ANY later
-- write — MARK_ONLY VMAF verdicts, snapshot backfills), so durations derived
-- from it inflate; step-log.ts already dodges the column with raw SQL for
-- exactly this reason.
ALTER TABLE "EncodingJob" ADD COLUMN "finishedAt" TIMESTAMP(3);

CREATE INDEX "EncodingJob_finishedAt_idx" ON "EncodingJob"("finishedAt" DESC);

-- Backfill: rows already FINISHED get updatedAt as a STATED approximation
-- (the real finish moment is unrecoverable for them; the error decays as the
-- 14-day insights window ages past the migration).
UPDATE "EncodingJob" SET "finishedAt" = "updatedAt" WHERE "status" = 'FINISHED';

-- review-259 116-A2 (writer-side repair, historical rows): resume REVIVES a
-- terminal run in place but left the old endedAt stamped while the restart
-- rewrote runningSince fresh — so endedAt < runningSince marks exactly the
-- revived-and-not-yet-re-terminal class. Those rows currently render a bogus
-- end time (runs-panel) and would zero out live airtime. The revive route now
-- clears endedAt going forward; this repairs the rows it already left behind.
UPDATE "LiveChannelRun" SET "endedAt" = NULL WHERE "endedAt" < "runningSince";
