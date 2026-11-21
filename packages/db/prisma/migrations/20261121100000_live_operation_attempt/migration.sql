CREATE TYPE "OperationKind" AS ENUM ('LIVE_MOQ_PLAYBACK');
CREATE TYPE "OperationOutcome" AS ENUM ('FIRST_FRAME', 'FAILED', 'CANCELED');

CREATE TABLE "OperationAttempt" (
  "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
  "id" UUID NOT NULL,
  "operation" "OperationKind" NOT NULL,
  "ownerDigest" CHAR(64) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, CURRENT_TIMESTAMP),
  "outcome" "OperationOutcome",
  "elapsedMs" INTEGER,
  CONSTRAINT "OperationAttempt_pkey" PRIMARY KEY ("organizationId", "id"),
  CONSTRAINT "OperationAttempt_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OperationAttempt_ownerDigest_format" CHECK ("ownerDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OperationAttempt_terminal_result" CHECK (
    ("outcome" IS NULL AND "elapsedMs" IS NULL)
    OR ("outcome" IS NOT NULL AND "elapsedMs" IS NOT NULL AND "elapsedMs" BETWEEN 0 AND 600000)
  )
);

CREATE INDEX "OperationAttempt_organizationId_startedAt_idx" ON "OperationAttempt"("organizationId", "startedAt");

CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "OperationAttempt"
  FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "OperationAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "OperationAttempt" USING
  ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid))
  WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
