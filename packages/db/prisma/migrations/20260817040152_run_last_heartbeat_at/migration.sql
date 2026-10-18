-- AlterTable
ALTER TABLE "LiveChannelRun" ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3);

-- Backfill (hand-written, the #83 precedent): the backfilled run #1 copied
-- the channel's lastHeartbeat JSON; its `at` field is the honest last-life
-- timestamp for that run.
UPDATE "LiveChannelRun"
SET "lastHeartbeatAt" = ("lastHeartbeat"->>'at')::timestamp
WHERE "lastHeartbeat" IS NOT NULL AND "lastHeartbeat"->>'at' IS NOT NULL;

-- Composition guard (review-109pr1's pre-build catch #2): #240 backfilled
-- run #1 with createdAt = the CHANNEL's creation date (correct for the sort
-- key) — but the anchor rule "null lastHeartbeatAt ⇒ grace from createdAt"
-- would then read a months-old date on a RUNNING backfilled run with an
-- empty heartbeat window: CRIT on the first sweep after deploy. Floor every
-- remaining null to the MIGRATION's own timestamp, so no pre-existing run
-- starts life already-stale. One rule for all runs; the special case lives
-- here, visible and one-time.
UPDATE "LiveChannelRun"
SET "lastHeartbeatAt" = now()
WHERE "lastHeartbeatAt" IS NULL;
