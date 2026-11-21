BEGIN;

-- CreateEnum
CREATE TYPE "EncodingExperimentState" AS ENUM ('RUNNING', 'PAUSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "EncodingExperimentTrialState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "ApiToken" ADD COLUMN     "scope" TEXT;

-- CreateTable
CREATE TABLE "EncodingExperimentCampaign" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capabilityId" CHAR(64) NOT NULL,
    "runtime" JSONB NOT NULL,
    "state" "EncodingExperimentState" NOT NULL DEFAULT 'RUNNING',
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "resultSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EncodingExperimentCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncodingExperimentTrial" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "trialKey" CHAR(64) NOT NULL,
    "sourceSha256" CHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "status" "EncodingExperimentTrialState" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "resultSequence" INTEGER,
    "result" JSONB,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EncodingExperimentTrial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncodingExperimentBatch" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "campaignId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,

    CONSTRAINT "EncodingExperimentBatch_pkey" PRIMARY KEY ("organizationId","campaignId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "EncodingExperimentCampaign_organizationId_id_key" ON "EncodingExperimentCampaign"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ExperimentTrial_queue" ON "EncodingExperimentTrial"("organizationId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentTrial_dedup" ON "EncodingExperimentTrial"("organizationId", "campaignId", "trialKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentTrial_export" ON "EncodingExperimentTrial"("organizationId", "campaignId", "resultSequence");

-- AddForeignKey
ALTER TABLE "EncodingExperimentCampaign" ADD CONSTRAINT "EncodingExperimentCampaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncodingExperimentTrial" ADD CONSTRAINT "EncodingExperimentTrial_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncodingExperimentTrial" ADD CONSTRAINT "EncodingExperimentTrial_organizationId_campaignId_fkey" FOREIGN KEY ("organizationId","campaignId") REFERENCES "EncodingExperimentCampaign"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "EncodingExperimentBatch" ADD CONSTRAINT "EncodingExperimentBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncodingExperimentBatch" ADD CONSTRAINT "EncodingExperimentBatch_organizationId_campaignId_fkey" FOREIGN KEY ("organizationId","campaignId") REFERENCES "EncodingExperimentCampaign"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_experiment_scope" CHECK ("scope" IS NULL OR "scope" = 'encoding-experiments');

-- The signature retains the fixed-column pre-scope authentication lookup.
DROP FUNCTION bitovp_auth_token(TEXT);
CREATE FUNCTION bitovp_auth_token(token_prefix TEXT)
RETURNS TABLE ("id" UUID, "tokenHash" TEXT, "role" TEXT, "revokedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3), "organizationId" UUID, "createdBy" TEXT, "userId" UUID, "scope" TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT "id", "tokenHash", "role", "revokedAt", "expiresAt", "organizationId", "createdBy", "userId", "scope"
  FROM public."ApiToken" WHERE "prefix" = token_prefix
$$;

CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "EncodingExperimentCampaign"
  FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "EncodingExperimentCampaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EncodingExperimentCampaign" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "EncodingExperimentCampaign" USING
  ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid))
  WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));

CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "EncodingExperimentTrial"
  FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "EncodingExperimentTrial" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EncodingExperimentTrial" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "EncodingExperimentTrial" USING
  ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid))
  WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));

CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "EncodingExperimentBatch"
  FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "EncodingExperimentBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EncodingExperimentBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "EncodingExperimentBatch" USING
  ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid))
  WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));

COMMIT;
