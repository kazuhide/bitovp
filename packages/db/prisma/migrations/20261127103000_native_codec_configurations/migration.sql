CREATE TABLE "NativeCodecConfiguration" (
  "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
  "id" UUID NOT NULL,
  "bitmovinAccountId" UUID NOT NULL,
  "scopeVersion" UUID NOT NULL,
  "providerScopeIdentity" CHAR(64) NOT NULL,
  "codec" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownerToken" UUID NOT NULL,
  "requestSha256" CHAR(64) NOT NULL,
  "pendingCreateRequest" JSONB,
  "providerId" UUID,
  "state" TEXT NOT NULL,
  "deleteToken" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NativeCodecConfiguration_pkey" PRIMARY KEY ("organizationId", "id"),
  CONSTRAINT "NativeCodecConfiguration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NativeCodecConfiguration_provider_key" UNIQUE ("organizationId", "bitmovinAccountId", "scopeVersion", "providerId"),
  CONSTRAINT "NativeCodecConfiguration_state_check" CHECK (
    ("state" IN ('CREATING', 'REJECTED') AND "providerId" IS NULL AND "deleteToken" IS NULL)
    OR ("state" IN ('ACTIVE', 'REMOVED') AND "providerId" IS NOT NULL AND "deleteToken" IS NULL)
    OR ("state" = 'DELETING' AND "providerId" IS NOT NULL AND "deleteToken" IS NOT NULL)
  ),
  CONSTRAINT "NativeCodecConfiguration_request_check" CHECK ("requestSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "NativeCodecConfiguration_pending_create_check" CHECK (
    "pendingCreateRequest" IS NULL OR (
      "state" = 'CREATING' AND jsonb_typeof("pendingCreateRequest") = 'object'
    )
  ),
  CONSTRAINT "NativeCodecConfiguration_kind_check" CHECK ("codec" IN (
    'dts', 'dts-passthrough', 'dtsx', 'mp2', 'mp3', 'vorbis', 'dvb-subtitle', 'h262', 'mjpeg', 'vp8'
  ))
);
CREATE INDEX "NativeCodecConfiguration_recent" ON "NativeCodecConfiguration" ("organizationId", "bitmovinAccountId", "createdAt");
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "NativeCodecConfiguration" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "NativeCodecConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeCodecConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "NativeCodecConfiguration" USING ("organizationId" = NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)
  WITH CHECK ("organizationId" = NULLIF(current_setting('bitovp.organization_id', true), '')::uuid);
