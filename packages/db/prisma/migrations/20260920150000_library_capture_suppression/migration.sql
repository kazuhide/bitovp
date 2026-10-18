-- Existing jobs retain automatic capture. Deploy the updated worker before
-- offering selective library reset; older workers do not honor suppression.
ALTER TABLE "EncodingJob"
ADD COLUMN "libraryCaptureSuppressed" BOOLEAN NOT NULL DEFAULT false;
