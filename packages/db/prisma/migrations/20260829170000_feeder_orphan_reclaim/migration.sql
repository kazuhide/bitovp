-- Audit 2026-08-29 CRITICAL-2: a dead feeder START job could leave an infinite
-- `-stream_loop -1` ffmpeg that no product path could reach.
--
-- The failed handler marks the session ERROR and keeps the pid on purpose (it
-- is the only pointer to the orphan), but ERROR was treated as "nothing to do":
-- the stop route 409'd it, the worker's stop returned before its kill ladder,
-- and DELETE removed the row — erasing the pid while ffmpeg kept pushing.
--
-- Two columns, both nullable, no backfill:
--   ownerHost      — which host the pid is meaningful on. NULL on existing rows
--                    reads as "the documented single-worker assumption held",
--                    which is exactly what those rows were written under.
--   processGoneAt  — positive proof the pid is gone (verified kill ladder or an
--                    ESRCH existence probe). NULL means never proven, NOT
--                    "still alive"; every existing terminal row already carries
--                    pid = NULL, so none of them become undeletable.
ALTER TABLE "FeederSession" ADD COLUMN "ownerHost" TEXT;
ALTER TABLE "FeederSession" ADD COLUMN "processGoneAt" TIMESTAMP(3);
