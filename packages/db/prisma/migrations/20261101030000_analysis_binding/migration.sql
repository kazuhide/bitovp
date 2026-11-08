-- Add proof as a new record. READY media and immutable analysis are never updated.
-- The migration wrapper prepares runtime grants/default privileges before and
-- after deployment; runtime roles remain subject to forced organization RLS.
BEGIN;

CREATE TABLE "LibraryAnalysisBinding" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "id" UUID NOT NULL,
    "mediaVersionId" UUID NOT NULL,
    "analysisRevisionId" UUID NOT NULL,
    "proof" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LibraryAnalysisBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LibraryAnalysisBinding_pair_key" ON "LibraryAnalysisBinding"("organizationId", "mediaVersionId", "analysisRevisionId");
CREATE UNIQUE INDEX "LibraryAnalysisBinding_organizationId_id_key" ON "LibraryAnalysisBinding"("organizationId", "id");
CREATE INDEX "LibraryAnalysisBinding_organizationId_idx" ON "LibraryAnalysisBinding"("organizationId");
CREATE INDEX "LibraryAnalysisBinding_mediaVersionId_idx" ON "LibraryAnalysisBinding"("mediaVersionId");
CREATE INDEX "LibraryAnalysisBinding_analysisRevisionId_idx" ON "LibraryAnalysisBinding"("analysisRevisionId");

ALTER TABLE "LibraryAnalysisBinding" ADD CONSTRAINT "LibraryAnalysisBinding_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LibraryAnalysisBinding" ADD CONSTRAINT "LibraryAnalysisBinding_mediaVersionId_tenant_fkey"
    FOREIGN KEY ("organizationId","mediaVersionId") REFERENCES "LibraryMediaVersion"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LibraryAnalysisBinding" ADD CONSTRAINT "LibraryAnalysisBinding_analysisRevisionId_tenant_fkey"
    FOREIGN KEY ("organizationId","analysisRevisionId") REFERENCES "SceneAnalysisRevision"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bitovp_keep_analysis_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Analysis binding proofs are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "analysis_binding_immutable" BEFORE UPDATE ON "LibraryAnalysisBinding" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_analysis_binding();
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LibraryAnalysisBinding" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LibraryAnalysisBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryAnalysisBinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LibraryAnalysisBinding" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));

COMMIT;
