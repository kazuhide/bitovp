-- Row #240: the feeder switch is two-phase (audit 2026-08-29 live-scheduling
-- HIGH-3).
--
-- A scheduled switch enqueued a stop for the running feeder and created its
-- replacement on the spot; the replacement then downloaded the WHOLE source,
-- probed it and spawned ffmpeg after air time (paid run #5: FIRED→PUSHING
-- 29.2 s, FIRED→CONNECTED 53.5 s for a 725 MB source), and nothing waited for
-- the old stop to complete — so the seam was dead air or a temporary dual push
-- depending on queue scheduling, with no barrier deciding which and no point
-- that was "the commit".
--
-- FeederSession — the session's two phases, all nullable, no backfill:
--   commitAt          — set = a two-phase session (the planned commit instant).
--                       NULL = an ordinary single-phase session, unchanged.
--   readyAt           — Phase A done: sealed bytes downloaded, probed and gated;
--                       the spool is HELD, ffmpeg is not spawned. Cleared by a
--                       takeover claim (the new owner re-stages).
--   commitRequestedAt — Phase B requested (the sweep's commit at fireAt, or
--                       creation for an immediate switch).
--   committedAt       — the fenced write that IS the commit point, after every
--                       predecessor on the channel was proven gone.
--   predecessorGoneAt — when the last predecessor was proven gone (its
--                       processGoneAt, or its stoppedAt for a clean stop).
--   switchSeamMs      — first push minus predecessorGoneAt: the measured seam.
--
-- LiveSchedule — the row's pre-stage outbox pair and its records:
--   stagedAt / stageDispatchedAt — claim / handoff, the same pair firedAt /
--                       dispatchedAt form for the fire itself (row 236).
--   readyAt           — write-once mirror of the session's readiness.
--   switchSeamMs      — mirror of the measured seam.
ALTER TABLE "FeederSession" ADD COLUMN "commitAt" TIMESTAMP(3),
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "commitRequestedAt" TIMESTAMP(3),
ADD COLUMN     "committedAt" TIMESTAMP(3),
ADD COLUMN     "predecessorGoneAt" TIMESTAMP(3),
ADD COLUMN     "switchSeamMs" INTEGER;

ALTER TABLE "LiveSchedule" ADD COLUMN "stagedAt" TIMESTAMP(3),
ADD COLUMN     "stageDispatchedAt" TIMESTAMP(3),
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "switchSeamMs" INTEGER;
