-- Ledger #96: feeder-chain schedule rows
ALTER TYPE "LiveScheduleAction" ADD VALUE 'FEEDER_START';
ALTER TYPE "LiveScheduleAction" ADD VALUE 'FEEDER_SWITCH';
ALTER TABLE "LiveSchedule" ADD COLUMN "feederSource" JSONB;
