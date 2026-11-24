ALTER TABLE "LiveChannelRun" ADD COLUMN "previousProviderEncodingIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "LiveEffectClaim" ADD COLUMN "stopProtocolVersion" INTEGER,
    ADD COLUMN "stopSendEncodingIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "stopOutcomeEvidence" JSONB;
