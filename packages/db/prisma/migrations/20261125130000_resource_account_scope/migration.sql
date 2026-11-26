ALTER TABLE "BitmovinAccount"
  ADD COLUMN "resourceScopeVersion" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "resourceScopeSince" TIMESTAMP(3);

-- Existing rows fall back to their previous update timestamp until the next change.
ALTER TABLE "BitmovinAccount" ALTER COLUMN "resourceScopeSince" SET DEFAULT CURRENT_TIMESTAMP;

CREATE FUNCTION bitovp_resource_account_scope_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantOrgId" IS DISTINCT FROM OLD."tenantOrgId"
     OR (NEW."tenantOrgId" IS NULL AND NEW."encryptedApiKey" IS DISTINCT FROM OLD."encryptedApiKey") THEN
    NEW."resourceScopeVersion" := gen_random_uuid();
    NEW."resourceScopeSince" := clock_timestamp() AT TIME ZONE 'UTC';
  ELSE
    NEW."resourceScopeVersion" := OLD."resourceScopeVersion";
    NEW."resourceScopeSince" := COALESCE(OLD."resourceScopeSince", OLD."updatedAt");
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bitovp_resource_account_scope_change BEFORE UPDATE ON "BitmovinAccount"
FOR EACH ROW EXECUTE FUNCTION bitovp_resource_account_scope_change();
