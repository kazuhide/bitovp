-- Retain profile IDs after reset so environment fallback cannot resurrect them.
ALTER TABLE "VmafExecutionProfile" ADD COLUMN "resetAt" TIMESTAMP(3);
