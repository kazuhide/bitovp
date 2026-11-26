ALTER TABLE "LiveChannelRun" ADD COLUMN "archivedRtmpAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "previousProviderEncodingIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "LiveEffectClaim" ADD COLUMN "stopProtocolVersion" INTEGER,
    ADD COLUMN "stopSendEncodingIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "stopOutcomeEvidence" JSONB;

ALTER TABLE "LiveEffectClaim"
  ADD COLUMN "legacyStopErrorNotificationPossible" BOOLEAN NOT NULL DEFAULT FALSE;
