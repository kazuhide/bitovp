-- Ledger #94: program-slot scheduling at channel creation.
-- LiveSchedule: creation-time slates carry a SOURCE (content is per-encoding
-- and cannot exist yet), a fire-time duration bound, and a registration claim.
ALTER TABLE "LiveSchedule" ADD COLUMN "slateSource" JSONB;
ALTER TABLE "LiveSchedule" ADD COLUMN "slateUntil" TIMESTAMP(3);
ALTER TABLE "LiveSchedule" ADD COLUMN "contentClaimedAt" TIMESTAMP(3);
-- LiveChannel: the scheduled program window (alert gating + timeline).
ALTER TABLE "LiveChannel" ADD COLUMN "programStartAt" TIMESTAMP(3);
ALTER TABLE "LiveChannel" ADD COLUMN "programEndAt" TIMESTAMP(3);
