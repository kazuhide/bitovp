-- A capped log tail cannot prove that no feeder restart occurred. Keep a
-- monotonic, durable counter on the session so paid live audits can fail
-- closed on any unexpected respawn.
ALTER TABLE "FeederSession"
ADD COLUMN "restartCount" INTEGER NOT NULL DEFAULT 0;
