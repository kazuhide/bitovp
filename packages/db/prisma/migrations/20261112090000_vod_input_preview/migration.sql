BEGIN;
CREATE TABLE "VodInputPreviewTask" (
  "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
  "id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "stage" TEXT NOT NULL DEFAULT 'QUEUED',
  "requestHash" CHAR(64) NOT NULL,
  "request" JSONB NOT NULL,
  "result" JSONB,
  "error" JSONB,
  "probeId" UUID,
  "artifactPath" TEXT,
  "artifactToken" UUID,
  "artifactSize" BIGINT,
  "artifactSha256" CHAR(64),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMP(3),
  "cancelRequestedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VodInputPreviewTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VodInputPreviewTask_kind_check" CHECK ("kind" IN ('PROBE', 'PREVIEW')),
  CONSTRAINT "VodInputPreviewTask_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  CONSTRAINT "VodInputPreviewTask_artifact_check" CHECK ("artifactPath" IS NULL OR ("status" = 'SUCCEEDED' AND "artifactToken" IS NOT NULL AND "artifactSha256" IS NOT NULL AND "artifactSize" > 0)),
  CONSTRAINT "VodInputPreviewTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VodInputPreviewTask_organizationId_id_key" ON "VodInputPreviewTask"("organizationId", "id");
CREATE INDEX "VodInputPreviewTask_organizationId_kind_requestHash_idx" ON "VodInputPreviewTask"("organizationId", "kind", "requestHash");
CREATE INDEX "VodInputPreviewTask_status_createdAt_idx" ON "VodInputPreviewTask"("status", "createdAt");
CREATE INDEX "VodInputPreviewTask_expiresAt_idx" ON "VodInputPreviewTask"("expiresAt");
CREATE INDEX "VodInputPreviewTask_organizationId_probeId_idx" ON "VodInputPreviewTask"("organizationId", "probeId");
ALTER TABLE "VodInputPreviewTask" ADD CONSTRAINT "VodInputPreviewTask_probeId_tenant_fkey" FOREIGN KEY ("organizationId","probeId") REFERENCES "VodInputPreviewTask"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "VodInputPreviewTask" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "VodInputPreviewTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VodInputPreviewTask" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "VodInputPreviewTask" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE FUNCTION bitovp_keep_vod_input_preview_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."request" IS DISTINCT FROM OLD."request" OR NEW."probeId" IS DISTINCT FROM OLD."probeId" THEN
    RAISE EXCEPTION 'VOD input preview intent is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "vod_input_preview_intent_immutable" BEFORE UPDATE ON "VodInputPreviewTask" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_vod_input_preview_intent();
COMMIT;
