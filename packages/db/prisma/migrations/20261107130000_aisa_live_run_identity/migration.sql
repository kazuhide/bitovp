ALTER TABLE "LiveChannel" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'MANAGED';
ALTER TABLE "LiveChannelRun"
  ADD COLUMN "aisaAnalysisId" UUID,
  ADD COLUMN "aisaStatus" TEXT,
  ADD COLUMN "aisaSnapshot" JSONB,
  ADD COLUMN "aisaObservedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "LiveChannelRun_organizationId_aisaAnalysisId_key" ON "LiveChannelRun"("organizationId", "aisaAnalysisId");
