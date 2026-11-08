-- Keep uploaded bytes addressable across any number of worker lease takeovers.
ALTER TABLE "RenderRun" ADD COLUMN "pendingArtifactToken" UUID;

-- The first editing worker used its UUID lease token as the upload directory.
UPDATE "RenderRun"
SET "pendingArtifactToken" = "leaseToken"::uuid
WHERE "state" = 'VALIDATING'
  AND "leaseToken" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
