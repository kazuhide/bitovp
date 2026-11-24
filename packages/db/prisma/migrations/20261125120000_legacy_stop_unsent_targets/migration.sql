ALTER TABLE "LiveEffectClaim" ADD COLUMN "legacyUnsentStopIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
