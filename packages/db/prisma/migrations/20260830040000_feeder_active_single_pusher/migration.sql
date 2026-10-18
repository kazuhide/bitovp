-- Row #267 · audit 602ec286 HIGH-1 (§17 P0-3): the single-pusher rule is a DB
-- GUARANTEE, not a check-then-act. The web create route COUNTed active feeder
-- sessions per channel and then INSERTed the row in a separate statement — two
-- concurrent POSTs both read zero and both created, opening a second push at
-- one ingest (video jam + double billing). This partial unique index makes the
-- racing loser's INSERT a P2002, which the route answers as 409.
--
-- At most ONE active feeder session per channel WHOSE PUSH IS UN-COORDINATED
-- (commitAt IS NULL). A two-phase SWITCH session (commitAt set — row #240) is
-- deliberately EXEMPT: it stages behind the predecessor barrier and only pushes
-- once the active feeder is proven gone, so a switch legitimately holds a second
-- active row for the length of the handoff. A barrier-less (single-phase)
-- session has no such coordination, so two of them on one channel is exactly the
-- dual push this index forbids. commitAt-set <=> barriered holds at BOTH create
-- sites (the web route and the scheduler's live-processor).
--
-- Prisma cannot express a partial unique index declaratively — hand-written
-- here, the #83 / LiveChannelRun_one_live_per_channel precedent. Enumerated in
-- MIGRATIONS.md; keep the checksum in sync per that file if this is edited after
-- applying.
CREATE UNIQUE INDEX "FeederSession_one_active_pusher_per_channel"
  ON "FeederSession"("liveChannelId")
  WHERE "status" IN ('CREATED', 'DOWNLOADING', 'PUSHING') AND "commitAt" IS NULL;
