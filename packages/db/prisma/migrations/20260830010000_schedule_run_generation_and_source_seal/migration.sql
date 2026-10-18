-- Row #241: which AIRING a schedule row was armed for, and which BYTES a
-- feeder was armed against (audit 2026-08-29 live-scheduling HIGH-4).
--
-- Two facts the ledger could not state:
--
--  1. `LiveSchedule` carried only `liveChannelId`. After a re-air, a STOP
--     armed for last night's programme could take today's off the air, and a
--     slate or feeder armed for run N could push its content into run N+1 —
--     and afterwards nothing on the row could say which generation it had
--     been armed for.
--  2. A feeder's source was a LOCATION (`credentialId/bucket/key`) and a
--     location is not a version. An object replaced under the same key
--     between arm and air aired different content than the one that was
--     scheduled, and the row could not tell the two apart.
--
-- Pure DDL. The enforcement lands with the code; the one data decision is an
-- operator step, see section 3.

-- ---------------------------------------------------------------------------
-- 1. Generation bind
-- ---------------------------------------------------------------------------

-- ALTER TYPE ... ADD VALUE cannot be USED in the same transaction that adds
-- it (Postgres). Nothing below references the new label, so this is safe;
-- IF NOT EXISTS follows the AKAMAI_NETSTORAGE / AKAMAI_MSL precedent so a
-- half-applied deploy is re-runnable.
ALTER TYPE "LiveScheduleStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_STALE_GENERATION';

-- Provenance, no FK: the schedule ledger must outlive the run it names
-- (same shape as "LiveSchedule"."feederSessionId" and
-- "StartupSample"."liveChannelRunId").
ALTER TABLE "LiveSchedule" ADD COLUMN "liveChannelRunId" UUID;

CREATE INDEX "LiveSchedule_liveChannelRunId_idx" ON "LiveSchedule"("liveChannelRunId");

-- ---------------------------------------------------------------------------
-- 2. Source identity seal
-- ---------------------------------------------------------------------------

-- All nullable: providers genuinely disagree about which selectors they have
-- (etag: S3 + Azure; versionId: S3/Azure on a versioned bucket; generation:
-- GCS only), and every row written before this migration has none of them.
-- Values are stored VERBATIM — S3 returns quoted ETags and expects the same
-- quoted form back in If-Match, so normalizing here would be a silent
-- always-mismatch that fails closed for the wrong reason.
ALTER TABLE "FeederSession" ADD COLUMN     "sourceEtag" TEXT,
ADD COLUMN     "sourceVersionId" TEXT,
ADD COLUMN     "sourceGeneration" TEXT,
ADD COLUMN     "sourceSize" BIGINT,
ADD COLUMN     "sourceSha256" TEXT;

-- ---------------------------------------------------------------------------
-- 3. Backfill — DELIBERATELY NOT PERFORMED HERE. Read the pre-deploy note in
--    docs/DATABASE-UPGRADES.md, 'Bind armed schedules', BEFORE deploying.
-- ---------------------------------------------------------------------------
--
-- The bind cannot be inferred correctly by SQL alone for every ARMED row, and
-- guessing in either direction has an opposite failure mode:
--
--   * bind too eagerly (give every ARMED row the channel's latest run) and a
--     creation-time row on a STOPPED channel is nailed to an airing that
--     already ended — its own programme would then be refused as stale;
--   * leave everything NULL and the audit's case (a row armed DURING an
--     airing) stays unbound — which is exactly today's behaviour and no
--     worse than it: the row binds lazily the first time it fires.
--
-- So the rule is: bind ARMED rows whose channel is RUNNING (there IS a
-- current airing, and the row was armed against it), leave every other row
-- NULL. That is a decision about live data, so it is an OPERATOR step with a
-- query to read first — not an unattended UPDATE inside a migration. The
-- query and the statement are both in docs/DATABASE-UPGRADES.md.
