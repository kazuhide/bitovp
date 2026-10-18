-- The provider's lifecycle for a run's EXACT encoding was never read back
-- and never stored.
-- The paid sequence: provider auto-shutdown FINISHED → local stayed RUNNING
-- (the heartbeat sweep reads only the heartbeat) → Restart hit the provider's
-- 409 → local ERROR → Start REVIVED the same run, reusing the FINISHED
-- encoding's id, ingest coordinates and DONE step log → local RUNNING again →
-- RTMP refused. Nothing on the row could say "the provider ended this".
--
-- Provider-observation and durable convergence columns, plus one poll token.
-- All nullable / defaulted,
-- ADDITIVE only. No backfill: a value here means an EXACT readback happened
-- for that run's encoding id; guessing one for existing rows would be the same
-- substitution of our write for the provider's answer.
-- Rows stay NULL until the sweep or an action reads them back.
ALTER TABLE "LiveChannelRun" ADD COLUMN "providerStatus" TEXT;
ALTER TABLE "LiveChannelRun" ADD COLUMN "providerStatusObservedAt" TIMESTAMP(3);
ALTER TABLE "LiveChannelRun" ADD COLUMN "providerUnknownSince" TIMESTAMP(3);
ALTER TABLE "LiveChannelRun" ADD COLUMN "providerUnknownAlertedAt" TIMESTAMP(3);
ALTER TABLE "LiveChannelRun" ADD COLUMN "providerTerminalAt" TIMESTAMP(3);
ALTER TABLE "LiveChannelRun" ADD COLUMN "providerFeederStopsEnqueuedAt" TIMESTAMP(3);
ALTER TABLE "LiveChannelRun" ADD COLUMN "heartbeatPollEpoch" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "LiveChannelRun_providerTerminalAt_providerFeederStopsEnqueuedAt_idx"
ON "LiveChannelRun"("providerTerminalAt", "providerFeederStopsEnqueuedAt");
