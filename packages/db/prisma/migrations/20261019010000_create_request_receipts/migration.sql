-- Receipts survive resource deletion and operational reset.
CREATE TABLE "CreateRequest" (
    "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
    "kind" TEXT NOT NULL,
    "requestKey" VARCHAR(200) NOT NULL,
    "requestSha256" CHAR(64) NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreateRequest_pkey" PRIMARY KEY ("organizationId", "kind", "requestKey"),
    CONSTRAINT "CreateRequest_kind_check" CHECK ("kind" IN ('VOD_JOB', 'LIVE_CHANNEL')),
    CONSTRAINT "CreateRequest_key_check" CHECK ("requestKey" ~ '^[A-Za-z0-9._:-]{1,200}$'),
    CONSTRAINT "CreateRequest_sha256_check" CHECK ("requestSha256" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "CreateRequest_organizationId_idx" ON "CreateRequest"("organizationId");
ALTER TABLE "CreateRequest" ADD CONSTRAINT "CreateRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "CreateRequest" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "CreateRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreateRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "CreateRequest" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
