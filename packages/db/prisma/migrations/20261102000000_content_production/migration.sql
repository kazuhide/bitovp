BEGIN;
CREATE TABLE "LibraryEvidenceReceipt" (
 "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
 "id" UUID NOT NULL PRIMARY KEY, "sourceId" UUID, "mediaVersionId" UUID, "analysisRevisionId" UUID,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('INPUT_CAPTURE','ANALYSIS_CAPTURE','NORMALIZATION_CAPTURE','EDITOR_ATTESTATION')),
 "jobId" UUID, "encodingId" TEXT, "proof" JSONB NOT NULL, "proofHash" CHAR(64) NOT NULL CHECK ("proofHash" ~ '^[a-f0-9]{64}$'),
 "createdBy" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (("kind" = 'INPUT_CAPTURE' AND "jobId" IS NOT NULL AND "encodingId" IS NOT NULL) OR ("kind" <> 'INPUT_CAPTURE' AND "sourceId" IS NOT NULL))
);
CREATE TABLE "LibraryMediaTask" (
 "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
 "id" UUID NOT NULL PRIMARY KEY, "mediaVersionId" UUID NOT NULL, "analysisRevisionId" UUID, "parentTaskId" UUID,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('TRANSCRIBE','TRACK','GENERATE')),
 "requestKey" VARCHAR(200) NOT NULL, "requestHash" CHAR(64) NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
 "cacheKey" CHAR(64) NOT NULL CHECK ("cacheKey" ~ '^[a-f0-9]{64}$'), "parameters" JSONB NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','RUNNING','SUCCEEDED','ERROR','CANCELED')),
 "phase" TEXT NOT NULL DEFAULT 'QUEUED', "progress" JSONB, "result" JSONB,
 "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0), "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseToken" UUID, "leaseUntil" TIMESTAMP(3), "cancelRequestedAt" TIMESTAMP(3), "error" TEXT,
 "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3), "createdBy" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CHECK ("state" <> 'SUCCEEDED' OR ("result" IS NOT NULL AND "finishedAt" IS NOT NULL))
);
CREATE TABLE "LibraryImageAsset" (
 "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
 "id" UUID NOT NULL PRIMARY KEY, "projectId" UUID NOT NULL, "storage" JSONB NOT NULL,
 "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'), "size" BIGINT NOT NULL CHECK ("size" > 0 AND "size" <= 8388608),
 "width" INTEGER NOT NULL CHECK ("width" BETWEEN 1 AND 2048), "height" INTEGER NOT NULL CHECK ("height" BETWEEN 1 AND 2048),
 "createdBy" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "LibraryEvidenceReceipt_organizationId_id_key" ON "LibraryEvidenceReceipt"("organizationId", "id");
CREATE INDEX "LibraryEvidenceReceipt_organizationId_idx" ON "LibraryEvidenceReceipt"("organizationId");
ALTER TABLE "LibraryEvidenceReceipt" ADD CONSTRAINT "LibraryEvidenceReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LibraryEvidenceReceipt" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LibraryEvidenceReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryEvidenceReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LibraryEvidenceReceipt" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE UNIQUE INDEX "LibraryMediaTask_organizationId_id_key" ON "LibraryMediaTask"("organizationId", "id");
CREATE INDEX "LibraryMediaTask_organizationId_idx" ON "LibraryMediaTask"("organizationId");
ALTER TABLE "LibraryMediaTask" ADD CONSTRAINT "LibraryMediaTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LibraryMediaTask" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LibraryMediaTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryMediaTask" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LibraryMediaTask" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE UNIQUE INDEX "LibraryImageAsset_organizationId_id_key" ON "LibraryImageAsset"("organizationId", "id");
CREATE INDEX "LibraryImageAsset_organizationId_idx" ON "LibraryImageAsset"("organizationId");
ALTER TABLE "LibraryImageAsset" ADD CONSTRAINT "LibraryImageAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LibraryImageAsset" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LibraryImageAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryImageAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LibraryImageAsset" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
ALTER TABLE "LibraryEvidenceReceipt" ADD CONSTRAINT "LibraryEvidenceReceipt_sourceId_tenant_fkey" FOREIGN KEY ("organizationId","sourceId") REFERENCES "LibrarySource"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "LibraryEvidenceReceipt_sourceId_idx" ON "LibraryEvidenceReceipt"("sourceId");
ALTER TABLE "LibraryEvidenceReceipt" ADD CONSTRAINT "LibraryEvidenceReceipt_mediaVersionId_tenant_fkey" FOREIGN KEY ("organizationId","mediaVersionId") REFERENCES "LibraryMediaVersion"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "LibraryEvidenceReceipt_mediaVersionId_idx" ON "LibraryEvidenceReceipt"("mediaVersionId");
ALTER TABLE "LibraryEvidenceReceipt" ADD CONSTRAINT "LibraryEvidenceReceipt_analysisRevisionId_tenant_fkey" FOREIGN KEY ("organizationId","analysisRevisionId") REFERENCES "SceneAnalysisRevision"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "LibraryEvidenceReceipt_analysisRevisionId_idx" ON "LibraryEvidenceReceipt"("analysisRevisionId");
ALTER TABLE "LibraryMediaTask" ADD CONSTRAINT "LibraryMediaTask_mediaVersionId_tenant_fkey" FOREIGN KEY ("organizationId","mediaVersionId") REFERENCES "LibraryMediaVersion"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "LibraryMediaTask_mediaVersionId_idx" ON "LibraryMediaTask"("mediaVersionId");
ALTER TABLE "LibraryMediaTask" ADD CONSTRAINT "LibraryMediaTask_analysisRevisionId_tenant_fkey" FOREIGN KEY ("organizationId","analysisRevisionId") REFERENCES "SceneAnalysisRevision"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "LibraryMediaTask_analysisRevisionId_idx" ON "LibraryMediaTask"("analysisRevisionId");
ALTER TABLE "LibraryMediaTask" ADD CONSTRAINT "LibraryMediaTask_parentTaskId_tenant_fkey" FOREIGN KEY ("organizationId","parentTaskId") REFERENCES "LibraryMediaTask"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "LibraryMediaTask_parentTaskId_idx" ON "LibraryMediaTask"("parentTaskId");
ALTER TABLE "LibraryImageAsset" ADD CONSTRAINT "LibraryImageAsset_projectId_tenant_fkey" FOREIGN KEY ("organizationId","projectId") REFERENCES "EditProject"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "LibraryImageAsset_projectId_idx" ON "LibraryImageAsset"("projectId");
ALTER TABLE "LibraryEvidenceReceipt" ADD CONSTRAINT "LibraryEvidenceReceipt_jobId_tenant_fkey" FOREIGN KEY ("organizationId","jobId") REFERENCES "EncodingJob"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX "LibraryEvidenceReceipt_organizationId_kind_proofHash_key" ON "LibraryEvidenceReceipt"("organizationId","kind","proofHash");
CREATE INDEX "LibraryEvidenceReceipt_sourceId_kind_idx" ON "LibraryEvidenceReceipt"("sourceId","kind");
CREATE UNIQUE INDEX "LibraryMediaTask_organizationId_requestKey_key" ON "LibraryMediaTask"("organizationId","requestKey");
CREATE INDEX "LibraryMediaTask_state_availableAt_idx" ON "LibraryMediaTask"("state","availableAt");
CREATE INDEX "LibraryMediaTask_organizationId_kind_cacheKey_state_idx" ON "LibraryMediaTask"("organizationId","kind","cacheKey","state");
CREATE FUNCTION bitovp_keep_evidence_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Evidence receipts are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "receipt_immutable" BEFORE UPDATE ON "LibraryEvidenceReceipt" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_evidence_receipt();
CREATE FUNCTION bitovp_keep_image_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Image assets are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "image_asset_immutable" BEFORE UPDATE ON "LibraryImageAsset" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_image_asset();
CREATE FUNCTION bitovp_keep_media_task_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW."organizationId",NEW."id",NEW."mediaVersionId",NEW."analysisRevisionId",NEW."parentTaskId",NEW."kind",NEW."requestKey",NEW."requestHash",NEW."cacheKey",NEW."parameters",NEW."createdBy",NEW."createdAt")
 IS DISTINCT FROM (OLD."organizationId",OLD."id",OLD."mediaVersionId",OLD."analysisRevisionId",OLD."parentTaskId",OLD."kind",OLD."requestKey",OLD."requestHash",OLD."cacheKey",OLD."parameters",OLD."createdBy",OLD."createdAt") THEN
  RAISE EXCEPTION 'Media task inputs are immutable' USING ERRCODE = '23514';
 END IF;
 IF OLD."state" IN ('SUCCEEDED','CANCELED') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Completed media task results are immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "media_task_intent_immutable" BEFORE UPDATE ON "LibraryMediaTask" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_media_task_intent();
ALTER TABLE "LibraryAnalysisBinding" ADD COLUMN "attestationReceiptId" UUID;
ALTER TABLE "LibraryAnalysisBinding" ADD CONSTRAINT "LibraryAnalysisBinding_attestationReceiptId_tenant_fkey" FOREIGN KEY ("organizationId","attestationReceiptId") REFERENCES "LibraryEvidenceReceipt"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LibraryAnalysisBinding" ADD CONSTRAINT "binding_attestation_kind" CHECK (
 (("proof"->>'kind' = 'EDITOR_ATTESTED') IS TRUE) = ("attestationReceiptId" IS NOT NULL)
 AND ("attestationReceiptId" IS NULL OR ("proof" #>> '{attestation,receiptId}') IS NOT DISTINCT FROM "attestationReceiptId"::text)
);
CREATE FUNCTION bitovp_check_attestation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt "LibraryEvidenceReceipt"%ROWTYPE;
BEGIN
 IF NEW."attestationReceiptId" IS NOT NULL THEN
  SELECT * INTO receipt FROM "LibraryEvidenceReceipt" WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."attestationReceiptId";
  IF NOT FOUND OR receipt."kind" <> 'EDITOR_ATTESTATION' OR receipt."mediaVersionId" IS DISTINCT FROM NEW."mediaVersionId" OR receipt."analysisRevisionId" IS DISTINCT FROM NEW."analysisRevisionId" THEN
   RAISE EXCEPTION 'Attestation receipt must match the media and analysis tuple' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "binding_attestation_receipt" BEFORE INSERT ON "LibraryAnalysisBinding" FOR EACH ROW EXECUTE FUNCTION bitovp_check_attestation_receipt();
CREATE TABLE "EditProjectResource" (
 "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
 "id" UUID NOT NULL PRIMARY KEY, "projectId" UUID NOT NULL, "mediaVersionId" UUID, "imageAssetId" UUID,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (("mediaVersionId" IS NOT NULL)::integer + ("imageAssetId" IS NOT NULL)::integer = 1)
);
CREATE UNIQUE INDEX "EditProjectResource_organizationId_id_key" ON "EditProjectResource"("organizationId","id");
CREATE UNIQUE INDEX "EditProjectResource_organizationId_projectId_mediaVersionId_key" ON "EditProjectResource"("organizationId","projectId","mediaVersionId");
CREATE UNIQUE INDEX "EditProjectResource_organizationId_projectId_imageAssetId_key" ON "EditProjectResource"("organizationId","projectId","imageAssetId");
CREATE INDEX "EditProjectResource_organizationId_idx" ON "EditProjectResource"("organizationId");
CREATE INDEX "EditProjectResource_mediaVersionId_idx" ON "EditProjectResource"("mediaVersionId");
CREATE INDEX "EditProjectResource_imageAssetId_idx" ON "EditProjectResource"("imageAssetId");
ALTER TABLE "EditProjectResource" ADD CONSTRAINT "EditProjectResource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "EditProjectResource" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
CREATE TRIGGER "project_resource_immutable" BEFORE UPDATE ON "EditProjectResource" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_evidence_receipt();
ALTER TABLE "EditProjectResource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EditProjectResource" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "EditProjectResource" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
ALTER TABLE "EditProjectResource" ADD CONSTRAINT "EditProjectResource_projectId_tenant_fkey" FOREIGN KEY ("organizationId","projectId") REFERENCES "EditProject"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditProjectResource" ADD CONSTRAINT "EditProjectResource_mediaVersionId_tenant_fkey" FOREIGN KEY ("organizationId","mediaVersionId") REFERENCES "LibraryMediaVersion"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditProjectResource" ADD CONSTRAINT "EditProjectResource_imageAssetId_tenant_fkey" FOREIGN KEY ("organizationId","imageAssetId") REFERENCES "LibraryImageAsset"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

COMMIT;
