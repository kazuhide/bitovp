-- Audit 5c3d97ca BLOCKER-2 / §14.5 LC-02: the single-pusher rule must be a
-- DB guarantee about PUBLISHERS, not about statuses.
--
-- `FeederSession_one_active_pusher_per_channel` (20260830040000) admits at most
-- one uncoordinated ACTIVE row per channel. A row that has left the active set
-- with its ffmpeg still pushing is outside it: the cross-host takeover refusal
-- lands ERROR with the pid kept, `stop()`'s not-ours arm lands STOPPED with
-- the pid kept, the dead-job handler lands ERROR with the pid kept — and the
-- web route and the scheduler counted only CREATED/DOWNLOADING/PUSHING, so a
-- second publisher could be admitted, spawned and pushing at the same ingest
-- for up to a lease renewal plus a kill grace, until the old owner self-fenced.
--
-- Three columns and a partial unique index, status-independent:
--   publisherClaimedAt  — the owning worker took the channel's publisher slot
--                         (BEFORE spawning ffmpeg).
--   publisherReleasedAt — the slot was given back on POSITIVE proof that the
--                         process is gone (the owning supervisor's exit event,
--                         a verified kill ladder, ESRCH). Never on a terminal
--                         status, a lease expiry or a pid-null rewrite.
--   publisherGeneration — claims taken on this row (a takeover re-claims), so
--                         an attempt record can name the claim it served.
-- Claimed-and-not-released is the index predicate; two such rows on one
-- channel are a P2002, whatever their status.
--
-- ROLLOUT ORDER (mixed-version publisher execution is FORBIDDEN — a worker
-- that predates this migration spawns without claiming and walks straight
-- past the index; see prisma/migrations/MIGRATIONS.md "Pre-deploy step:
-- 20260830070000_feeder_publisher_claim"):
--   1. column expand (this file's ALTER TABLE — additive, nullable/defaulted);
--   2. pause the feeder create/switch doors (web POST /api/feeder-sessions and
--      the scheduler's feeder-start/stage/commit dispatch);
--   3. drain and STOP every pre-claim worker; confirm the running image set
--      holds zero pre-claim images — directly, not by deploy log;
--   4. backfill real publishers + the duplicate scan (this file's DO block and
--      UPDATE — the block fails CLOSED and names the session ids when one
--      channel holds more than one live publisher candidate; resolve by hand
--      and re-run migrate deploy);
--   5. create the unique index and read it back from pg_indexes as valid;
--   6. start claim-aware workers only;
--   7. resume the doors.
-- There is no supported zero-downtime rollout for this migration. The shipped
-- file adds the columns, backfills and creates the index in ONE transaction;
-- claim-aware code cannot run before those columns exist, while pre-claim code
-- cannot run after the guarantee is declared complete. If delivery cannot be
-- interrupted, ABORT and design/review a separate expand-handoff-contract
-- rollout first. A "new workers claim, old workers drain later" rollout is NOT
-- acceptable — one pre-claim worker is one unguarded publisher.
BEGIN;

ALTER TABLE "FeederSession" ADD COLUMN "publisherClaimedAt" TIMESTAMP(3),
ADD COLUMN     "publisherReleasedAt" TIMESTAMP(3),
ADD COLUMN     "publisherGeneration" INTEGER NOT NULL DEFAULT 0;

-- BACKFILL — only rows that PROVE a real spawn may hold a claim:
--   * PUSHING (a supervisor is pushing right now), or
--   * pid IS NOT NULL AND processGoneAt IS NULL (a recorded process nobody has
--     proven gone — the audit's may-be-alive shape, any status), or
--   * startedAt IS NOT NULL AND processGoneAt IS NULL (a process was spawned,
--     but its pid pointer was later lost without positive gone proof).
-- NOT claimed: CREATED/DOWNLOADING stage/holds (they have not spawned; the
-- claim-aware worker claims just before it spawns). A terminal row with a
-- startedAt but neither pid nor processGoneAt is deliberately claimed: it is
-- proof that a publisher existed and NO proof that it ended. Failing open to
-- avoid an operator repair would permit exactly the overlapping successor this
-- migration closes. Nothing here fabricates a pid or processGoneAt; an operator
-- must establish the missing proof before releasing such a claim. The claim
-- timestamp is the first push (startedAt) where one was recorded, else the
-- row's last write.
DO $$
DECLARE
  duplicates TEXT;
BEGIN
  SELECT string_agg(format('channel %s: sessions %s', d."liveChannelId", d.ids), '; ')
    INTO duplicates
    FROM (
      SELECT "liveChannelId", string_agg(id::text, ', ' ORDER BY "createdAt") AS ids
        FROM "FeederSession"
       WHERE "status" = 'PUSHING'
          OR ("pid" IS NOT NULL AND "processGoneAt" IS NULL)
          OR ("startedAt" IS NOT NULL AND "processGoneAt" IS NULL)
       GROUP BY "liveChannelId"
      HAVING count(*) > 1
    ) d;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'feeder publisher claim backfill refused: more than one live publisher candidate on one channel — stop or prove gone all but one from the host that owns its pid, then re-run migrate deploy. %', duplicates;
  END IF;
END $$;

UPDATE "FeederSession"
   SET "publisherClaimedAt" = COALESCE("startedAt", "updatedAt"),
       "publisherReleasedAt" = NULL,
       "publisherGeneration" = 1
 WHERE "status" = 'PUSHING'
    OR ("pid" IS NOT NULL AND "processGoneAt" IS NULL)
    OR ("startedAt" IS NOT NULL AND "processGoneAt" IS NULL);

-- The guarantee. Prisma cannot express a partial unique index declaratively —
-- hand-written here (the #83 / #267 precedent). Enumerated in MIGRATIONS.md;
-- keep the checksum in sync per that file if this is edited after applying.
CREATE UNIQUE INDEX "FeederSession_one_publisher_claim_per_channel"
  ON "FeederSession"("liveChannelId")
  WHERE "publisherClaimedAt" IS NOT NULL AND "publisherReleasedAt" IS NULL;

COMMIT;
