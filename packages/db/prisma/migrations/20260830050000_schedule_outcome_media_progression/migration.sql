-- A schedule row's delivery was one binary leap — PENDING → DELIVERED — so `DELIVERED` was
-- written the moment a feeder's ffmpeg started pushing (~16s before the
-- provider bound the ingest) and the moment a slate's provider entry was
-- ARMED (with no witness it aired). "Delivered" claimed media before any media
-- flowed.
--
-- These three values split that leap into a media progression,
-- so a green now means media was OBSERVED, not merely requested:
--
--   PROCESS_PUSHING  — our ffmpeg is pushing, provider not yet confirmed.
--   INGEST_CONNECTED — the provider's live encoder reports a fresh CONNECTED
--                      ingest while we push (the feeder's terminal-positive).
--   SLATE_ARMED      — the provider ARMED a scheduled insertion (no airing
--                      witness — the SDK has no played/finished status).
--
-- Additive only. Postgres cannot remove an enum value, so this is one-way by
-- construction; nothing is renamed and no existing row is rewritten — every
-- prior PENDING / DELIVERED / FAILED / UNKNOWN value stays valid and unchanged.
-- Positioned BEFORE 'DELIVERED' so the DB enum order matches schema.prisma's
-- logical progression (PG >= 12; the ADD VALUE only ADDS, never USES the value
-- in this transaction, which is what the in-transaction restriction guards).
ALTER TYPE "LiveScheduleOutcome" ADD VALUE IF NOT EXISTS 'PROCESS_PUSHING' BEFORE 'DELIVERED';
ALTER TYPE "LiveScheduleOutcome" ADD VALUE IF NOT EXISTS 'INGEST_CONNECTED' BEFORE 'DELIVERED';
ALTER TYPE "LiveScheduleOutcome" ADD VALUE IF NOT EXISTS 'SLATE_ARMED' BEFORE 'DELIVERED';
