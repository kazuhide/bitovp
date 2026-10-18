-- Row #256 (PR-C): the normalized loop profile the feeder pushes (period, fps,
-- co-terminous audio), read by the live VMAF processor as the reference period.
-- AlterTable
ALTER TABLE "FeederSession" ADD COLUMN     "loopProfile" JSONB;
