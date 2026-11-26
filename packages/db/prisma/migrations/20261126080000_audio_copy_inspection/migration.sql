ALTER TABLE "StorageInspection"
 ADD COLUMN "verifyAudioCopy" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "sourceIdentity" JSONB;
