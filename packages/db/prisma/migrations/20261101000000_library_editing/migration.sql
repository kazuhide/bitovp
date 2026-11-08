-- ROLLOUT ORDER: deploy this additive schema while only VOD_JOB sources exist.
-- Keep derived-render doors disabled until every reader and analysis sweeper is
-- sourceKind-aware, and stop pre-sourceKind workers before enabling those doors.
-- Existing VOD provenance is retained. Derived outputs never fabricate a job.
BEGIN;

-- CreateEnum
CREATE TYPE "LibrarySourceKind" AS ENUM ('VOD_JOB', 'DERIVED_RENDER');

-- AlterTable
ALTER TABLE "LibrarySource" ADD COLUMN     "renderArtifactId" UUID,
ADD COLUMN     "sourceKind" "LibrarySourceKind" NOT NULL DEFAULT 'VOD_JOB',
ALTER COLUMN "originalJobId" DROP NOT NULL,
ALTER COLUMN "encodingId" DROP NOT NULL,
ALTER COLUMN "accountId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "LibraryMediaVersion" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "storage" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "sha256" TEXT,
    "durationUs" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "fpsNum" INTEGER,
    "fpsDen" INTEGER,
    "timeMap" JSONB,
    "probe" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryMediaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditProject" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "mediaVersionId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1,
    "currentRevisionId" UUID,
    "createdBy" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditRevision" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "parentRevisionId" UUID,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderRun" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "profile" JSONB NOT NULL,
    "requestKey" VARCHAR(200) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "error" TEXT,
    "outputCredentialId" UUID NOT NULL,
    "outputBucket" TEXT NOT NULL,
    "outputPrefix" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderArtifact" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "storage" JSONB NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "size" BIGINT NOT NULL,
    "probe" JSONB NOT NULL,
    "qc" JSONB,
    "reviewState" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentDerivation" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "variant" TEXT NOT NULL,
    "derivedContentId" UUID,
    "desiredGeneration" INTEGER NOT NULL DEFAULT 0,
    "activeGeneration" INTEGER NOT NULL DEFAULT 0,
    "activeArtifactId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentDerivation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryMediaVersion_state_availableAt_idx" ON "LibraryMediaVersion"("state", "availableAt");

-- CreateIndex
CREATE INDEX "LibraryMediaVersion_sourceId_idx" ON "LibraryMediaVersion"("sourceId");

-- CreateIndex
CREATE INDEX "LibraryMediaVersion_credentialId_idx" ON "LibraryMediaVersion"("credentialId");

-- CreateIndex
CREATE INDEX "LibraryMediaVersion_organizationId_idx" ON "LibraryMediaVersion"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryMediaVersion_organizationId_id_key" ON "LibraryMediaVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EditProject_currentRevisionId_key" ON "EditProject"("currentRevisionId");

-- CreateIndex
CREATE INDEX "EditProject_contentId_idx" ON "EditProject"("contentId");

-- CreateIndex
CREATE INDEX "EditProject_mediaVersionId_idx" ON "EditProject"("mediaVersionId");

-- CreateIndex
CREATE INDEX "EditProject_archived_updatedAt_idx" ON "EditProject"("archived", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "EditProject_organizationId_idx" ON "EditProject"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EditProject_organizationId_id_key" ON "EditProject"("organizationId", "id");

-- CreateIndex
CREATE INDEX "EditRevision_parentRevisionId_idx" ON "EditRevision"("parentRevisionId");

-- CreateIndex
CREATE INDEX "EditRevision_organizationId_idx" ON "EditRevision"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EditRevision_projectId_revision_key" ON "EditRevision"("projectId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "EditRevision_organizationId_projectId_id_key" ON "EditRevision"("organizationId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EditRevision_organizationId_id_key" ON "EditRevision"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RenderRun_state_availableAt_idx" ON "RenderRun"("state", "availableAt");

-- CreateIndex
CREATE INDEX "RenderRun_revisionId_idx" ON "RenderRun"("revisionId");

-- CreateIndex
CREATE INDEX "RenderRun_outputCredentialId_idx" ON "RenderRun"("outputCredentialId");

-- CreateIndex
CREATE INDEX "RenderRun_organizationId_idx" ON "RenderRun"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderRun_organizationId_projectId_requestKey_key" ON "RenderRun"("organizationId", "projectId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "RenderRun_organizationId_id_key" ON "RenderRun"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RenderArtifact_runId_key" ON "RenderArtifact"("runId");

-- CreateIndex
CREATE INDEX "RenderArtifact_organizationId_idx" ON "RenderArtifact"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderArtifact_organizationId_id_key" ON "RenderArtifact"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ContentDerivation_derivedContentId_key" ON "ContentDerivation"("derivedContentId");

-- CreateIndex
CREATE INDEX "ContentDerivation_activeArtifactId_idx" ON "ContentDerivation"("activeArtifactId");

-- CreateIndex
CREATE INDEX "ContentDerivation_organizationId_idx" ON "ContentDerivation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentDerivation_organizationId_projectId_variant_key" ON "ContentDerivation"("organizationId", "projectId", "variant");

-- CreateIndex
CREATE UNIQUE INDEX "ContentDerivation_organizationId_id_key" ON "ContentDerivation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LibrarySource_renderArtifactId_key" ON "LibrarySource"("renderArtifactId");

-- AddForeignKey
ALTER TABLE "LibrarySource" ADD CONSTRAINT "LibrarySource_renderArtifactId_fkey" FOREIGN KEY ("renderArtifactId") REFERENCES "RenderArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LibrarySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_mediaVersionId_fkey" FOREIGN KEY ("mediaVersionId") REFERENCES "LibraryMediaVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "EditRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditRevision" ADD CONSTRAINT "EditRevision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditRevision" ADD CONSTRAINT "EditRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditRevision" ADD CONSTRAINT "EditRevision_parentRevisionId_fkey" FOREIGN KEY ("parentRevisionId") REFERENCES "EditRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "EditRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_outputCredentialId_fkey" FOREIGN KEY ("outputCredentialId") REFERENCES "Credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RenderRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_derivedContentId_fkey" FOREIGN KEY ("derivedContentId") REFERENCES "Content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_activeArtifactId_fkey" FOREIGN KEY ("activeArtifactId") REFERENCES "RenderArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A source has one real origin; optional navigation job links remain VOD-only.
ALTER TABLE "LibrarySource" ADD CONSTRAINT "LibrarySource_kind_check" CHECK (
    ("sourceKind" = 'VOD_JOB' AND "originalJobId" IS NOT NULL AND "encodingId" IS NOT NULL AND "accountId" IS NOT NULL AND "renderArtifactId" IS NULL)
 OR ("sourceKind" = 'DERIVED_RENDER' AND "jobId" IS NULL AND "originalJobId" IS NULL AND "encodingId" IS NULL AND "accountId" IS NULL AND "renderArtifactId" IS NOT NULL)
);
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_state_check" CHECK ("state" IN ('PENDING','RUNNING','READY','ERROR'));
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_ready_check" CHECK (
    "state" <> 'READY' OR (("sha256" ~ '^[0-9a-f]{64}$' AND "durationUs" > 0 AND "durationUs" <= 9007199254740991 AND "width" > 0 AND "height" > 0 AND "fpsNum" > 0 AND "fpsDen" > 0 AND jsonb_typeof("timeMap") = 'object' AND jsonb_typeof("probe") = 'object') IS TRUE)
);
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_draft_revision_check" CHECK ("draftRevision" > 0);
ALTER TABLE "EditRevision" ADD CONSTRAINT "EditRevision_number_check" CHECK ("revision" > 0);
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_state_check" CHECK ("state" IN ('QUEUED','PREPARING','RENDERING','VALIDATING','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELED'));
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_request_check" CHECK ("requestKey" ~ '^[A-Za-z0-9._:-]{1,200}$' AND "requestHash" ~ '^[0-9a-f]{64}$' AND "attempts" >= 0);
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_generation_check" CHECK (
    (("profile"->>'kind' = 'PREVIEW' AND "generation" = 0)
 OR ("profile"->>'kind' = 'EXPORT' AND "generation" > 0)) IS TRUE
);
CREATE UNIQUE INDEX "RenderRun_export_generation_key" ON "RenderRun"("projectId","generation") WHERE "generation" > 0;
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_evidence_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND "size" > 0 AND "size" <= 9007199254740991 AND "reviewState" IN ('UNREVIEWED','ACCEPTED','REJECTED'));
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_generation_check" CHECK ("activeGeneration" >= 0 AND "desiredGeneration" >= 0 AND "activeGeneration" <= "desiredGeneration" AND (("activeGeneration" = 0 AND "activeArtifactId" IS NULL) OR ("activeGeneration" > 0 AND "activeArtifactId" IS NOT NULL)));

-- Keep project-local references project-local even inside the same organization.
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_current_revision_ownership" FOREIGN KEY ("organizationId","id","currentRevisionId") REFERENCES "EditRevision"("organizationId","projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditRevision" ADD CONSTRAINT "EditRevision_parent_ownership" FOREIGN KEY ("organizationId","projectId","parentRevisionId") REFERENCES "EditRevision"("organizationId","projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_revision_ownership" FOREIGN KEY ("organizationId","projectId","revisionId") REFERENCES "EditRevision"("organizationId","projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bitovp_keep_edit_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Edit revisions are immutable' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "edit_revision_immutable" BEFORE UPDATE ON "EditRevision" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_edit_revision();
CREATE FUNCTION bitovp_keep_render_artifact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (to_jsonb(NEW) - 'reviewState') IS DISTINCT FROM (to_jsonb(OLD) - 'reviewState') THEN RAISE EXCEPTION 'Render artifact evidence is immutable' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "render_artifact_immutable" BEFORE UPDATE ON "RenderArtifact" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_render_artifact();
CREATE FUNCTION bitovp_keep_ready_media() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."state" = 'READY' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Prepared media versions are immutable' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "ready_media_immutable" BEFORE UPDATE ON "LibraryMediaVersion" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_ready_media();
CREATE FUNCTION bitovp_keep_derivation_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."desiredGeneration" < OLD."desiredGeneration" OR NEW."activeGeneration" < OLD."activeGeneration" THEN RAISE EXCEPTION 'Derivative generation cannot move backwards' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "derivation_generation_monotonic" BEFORE UPDATE ON "ContentDerivation" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_derivation_generation();
ALTER TABLE "LibrarySource" ADD CONSTRAINT "LibrarySource_renderArtifactId_tenant_fkey" FOREIGN KEY ("organizationId","renderArtifactId") REFERENCES "RenderArtifact"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_sourceId_tenant_fkey" FOREIGN KEY ("organizationId","sourceId") REFERENCES "LibrarySource"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_credentialId_tenant_fkey" FOREIGN KEY ("organizationId","credentialId") REFERENCES "Credential"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_contentId_tenant_fkey" FOREIGN KEY ("organizationId","contentId") REFERENCES "Content"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_mediaVersionId_tenant_fkey" FOREIGN KEY ("organizationId","mediaVersionId") REFERENCES "LibraryMediaVersion"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_currentRevisionId_tenant_fkey" FOREIGN KEY ("organizationId","currentRevisionId") REFERENCES "EditRevision"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditRevision" ADD CONSTRAINT "EditRevision_projectId_tenant_fkey" FOREIGN KEY ("organizationId","projectId") REFERENCES "EditProject"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EditRevision" ADD CONSTRAINT "EditRevision_parentRevisionId_tenant_fkey" FOREIGN KEY ("organizationId","parentRevisionId") REFERENCES "EditRevision"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_projectId_tenant_fkey" FOREIGN KEY ("organizationId","projectId") REFERENCES "EditProject"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_revisionId_tenant_fkey" FOREIGN KEY ("organizationId","revisionId") REFERENCES "EditRevision"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "RenderRun" ADD CONSTRAINT "RenderRun_outputCredentialId_tenant_fkey" FOREIGN KEY ("organizationId","outputCredentialId") REFERENCES "Credential"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "RenderArtifact" ADD CONSTRAINT "RenderArtifact_runId_tenant_fkey" FOREIGN KEY ("organizationId","runId") REFERENCES "RenderRun"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_projectId_tenant_fkey" FOREIGN KEY ("organizationId","projectId") REFERENCES "EditProject"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_derivedContentId_tenant_fkey" FOREIGN KEY ("organizationId","derivedContentId") REFERENCES "Content"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ContentDerivation" ADD CONSTRAINT "ContentDerivation_activeArtifactId_tenant_fkey" FOREIGN KEY ("organizationId","activeArtifactId") REFERENCES "RenderArtifact"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LibraryMediaVersion" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LibraryMediaVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryMediaVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LibraryMediaVersion" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "EditProject" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "EditProject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EditProject" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "EditProject" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "EditRevision" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "EditRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EditRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "EditRevision" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "RenderRun" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "RenderRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RenderRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "RenderRun" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "RenderArtifact" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "RenderArtifact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RenderArtifact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "RenderArtifact" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "ContentDerivation" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "ContentDerivation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentDerivation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "ContentDerivation" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));

COMMIT;
