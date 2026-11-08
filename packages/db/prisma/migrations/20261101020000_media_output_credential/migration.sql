BEGIN;

ALTER TABLE "LibraryMediaVersion" ADD COLUMN "outputCredentialId" UUID;

-- Never guess an output credential from the input credential. Existing output
-- and prepared locators must resolve to one credential in the owning tenant.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "LibraryMediaVersion" media
        LEFT JOIN "Credential" credential
          ON credential."id"::text = lower(media."storage" #>> '{output,credentialId}')
         AND credential."organizationId" = media."organizationId"
        WHERE credential."id" IS NULL
           OR (media."storage" -> 'prepared' IS NOT NULL
               AND lower(media."storage" #>> '{prepared,credentialId}') IS DISTINCT FROM credential."id"::text)
    ) THEN
        RAISE EXCEPTION 'LIBRARY_MEDIA_OUTPUT_CREDENTIAL_UNVERIFIED';
    END IF;
END $$;

-- This transaction holds the ALTER TABLE lock, so immutable READY evidence is
-- protected from concurrent writers while its relational reference is backfilled.
ALTER TABLE "LibraryMediaVersion" DISABLE TRIGGER "ready_media_immutable";
UPDATE "LibraryMediaVersion" media
SET "outputCredentialId" = credential."id"
FROM "Credential" credential
WHERE credential."id"::text = lower(media."storage" #>> '{output,credentialId}')
  AND credential."organizationId" = media."organizationId";
ALTER TABLE "LibraryMediaVersion" ENABLE TRIGGER "ready_media_immutable";

ALTER TABLE "LibraryMediaVersion" ALTER COLUMN "outputCredentialId" SET NOT NULL;
CREATE INDEX "LibraryMediaVersion_outputCredentialId_idx" ON "LibraryMediaVersion"("outputCredentialId");
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_outputCredentialId_fkey"
    FOREIGN KEY ("outputCredentialId") REFERENCES "Credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_outputCredentialId_tenant_fkey"
    FOREIGN KEY ("organizationId","outputCredentialId") REFERENCES "Credential"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LibraryMediaVersion" ADD CONSTRAINT "LibraryMediaVersion_output_locator_check" CHECK (
    (lower("storage" #>> '{output,credentialId}') = "outputCredentialId"::text) IS TRUE
    AND ("storage" -> 'prepared' IS NULL
         OR (lower("storage" #>> '{prepared,credentialId}') = "outputCredentialId"::text) IS TRUE)
);

COMMIT;
