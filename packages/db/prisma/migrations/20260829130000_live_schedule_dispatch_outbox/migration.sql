-- ROLLOUT — read this BEFORE `migrate deploy` (rev346 MEDIUM-1).
--
-- The backfill below is the right steady-state call and it has one cost: it
-- permanently erases the dispatcher's only signal for a row that CRITICAL-1
-- ALREADY stranded in the running deployment. A row that is FIRED because a
-- worker died between its claim and its `queue.add` looks, after this
-- migration, exactly like a row that was handed off successfully. So the
-- one chance to find those rows is BEFORE the migration runs.
--
-- Run this against the deployment you are about to upgrade. It reports the
-- claims whose channel never left the state the claim put it in:
--
--   SELECT s.id, s.action, s.note, s."fireAt", s."firedAt",
--          c.id AS "liveChannelId", c.name AS channel, c.status,
--          c."provisionClaimedAt"
--     FROM "LiveSchedule" s
--     JOIN "LiveChannel"  c ON c.id = s."liveChannelId"
--    WHERE s.status = 'FIRED'
--      AND s."firedAt" < now() - interval '15 minutes'
--      AND (   (s.action = 'START' AND c.status = 'PROVISIONING')
--           OR (s.action = 'STOP'  AND c.status = 'STOPPING') )
--    ORDER BY s."firedAt";
--
-- 15 minutes is a first cut: comfortably longer than a provision or a stop
-- takes, so a claim in flight right now is not reported. Raise N if the
-- install is slower. `provisionClaimedAt` is a second opinion on a START
-- hit: NULL means no provision job ever took the lease, which is the lost
-- handoff rather than a slow one.
--
-- ZERO ROWS: nothing to do — deploy.
--
-- HITS, and there are two ways to clear them:
--   (a) Let the new dispatcher take them. Save the ids, `migrate deploy`,
--       then immediately re-open their outbox:
--         UPDATE "LiveSchedule" SET "dispatchedAt" = NULL
--          WHERE id IN ('<id>', …);
--       The next dispatcher pass (boot, or the tick 30s later) re-adds each
--       under `sched-<id>`. A START's channel is already PROVISIONING and a
--       STOP's already STOPPING, which is exactly the state the
--       re-dispatched job expects, so nothing else needs touching.
--   (b) Clear them by hand FIRST, from the channel page — retry the start,
--       or stop the channel — and re-run the query until it is empty.
--
-- WHAT THE QUERY CANNOT SEE, stated rather than hoped away: SLATE_IN and
-- FEEDER_* rows leave no channel-state signature (the channel is RUNNING
-- whether or not the handoff landed), so a stranded one is only visible as
-- a FIRED row on the schedule panel with no insert record and no feeder
-- session for that airing. In practice a stranded windowed row is past its
-- useful-until by now, and the dispatcher would mark it MISSED rather than
-- air it late — which is the honest outcome, and the reason this note does
-- not ask an operator to hunt for them.

-- AlterTable
ALTER TABLE "LiveSchedule" ADD COLUMN     "dispatchJobId" TEXT,
ADD COLUMN     "dispatchedAt" TIMESTAMP(3);

-- Backfill (hand-written; MIGRATIONS.md's DML enumeration counts it).
--
-- The new column's meaning is "this row's action was handed to the queue".
-- Every row that is ALREADY FIRED was fired by code that had no such column,
-- so it would read as never-handed-off and the dispatcher pass would re-add
-- every historical START / STOP / slate / feeder job on the first boot after
-- deploy — provisioning channels and inserting slates from last month. Those
-- rows were handed off (or were lost by the very crash this work closes, and
-- nothing on the row can tell the two apart), so the only safe reading is
-- "handed off at the moment they fired". firedAt is that moment; updatedAt
-- covers any row whose firedAt was never stamped.
--
-- One-time and irreversible in the same sense as the #83/#240 precedents: it
-- forecloses recovery of a handoff that was genuinely lost BEFORE this
-- migration ran. That is deliberate for the unattended path — a lost
-- pre-migration handoff is indistinguishable from a completed one, and
-- replaying every one of them unattended is strictly worse than leaving them
-- recorded as fired. The ROLLOUT note above is how an operator recovers the
-- ones that matter, deliberately and before the evidence is gone.
UPDATE "LiveSchedule"
SET "dispatchedAt" = COALESCE("firedAt", "updatedAt")
WHERE "status" = 'FIRED';

-- CreateIndex
CREATE INDEX "LiveSchedule_status_dispatchedAt_idx" ON "LiveSchedule"("status", "dispatchedAt");
