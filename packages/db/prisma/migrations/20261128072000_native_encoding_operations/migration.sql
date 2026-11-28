CREATE TABLE "NativeEncodingOperation" (
  "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
  "id" UUID NOT NULL,
  "bitmovinAccountId" UUID NOT NULL,
  "scopeVersion" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "targetId" UUID,
  "fingerprint" CHAR(64) NOT NULL,
  "state" TEXT NOT NULL,
  "providerId" UUID,
  "passed" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NativeEncodingOperation_pkey" PRIMARY KEY ("organizationId", "id"),
  CONSTRAINT "NativeEncodingOperation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NativeEncodingOperation_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "NativeEncodingOperation_state_check" CHECK (
    ("state" = 'ACCEPTED' AND "providerId" IS NOT NULL) OR
    ("state" IN ('PENDING', 'UNKNOWN', 'REJECTED') AND "providerId" IS NULL)
  ),
  CONSTRAINT "NativeEncodingOperation_probe_check" CHECK (
    ("state" = 'ACCEPTED' AND "action" = 'check-s3-output') = ("passed" IS NOT NULL)
  )
);
CREATE INDEX "NativeEncodingOperation_recent" ON "NativeEncodingOperation" ("organizationId", "bitmovinAccountId", "scopeVersion", "createdAt");
CREATE UNIQUE INDEX "NativeEncodingOperation_pending_target" ON "NativeEncodingOperation" ("organizationId", "bitmovinAccountId", "scopeVersion", "targetId") WHERE "targetId" IS NOT NULL AND "state" = 'PENDING';
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "NativeEncodingOperation" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "NativeEncodingOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeEncodingOperation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "NativeEncodingOperation" USING ("organizationId" = NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)
  WITH CHECK ("organizationId" = NULLIF(current_setting('bitovp.organization_id', true), '')::uuid);
