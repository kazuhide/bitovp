ALTER TABLE "LiveChannelRun"
  ADD COLUMN "stopNotificationKind" TEXT,
  ADD COLUMN "stopNotificationAt" TIMESTAMP(3),
  ADD COLUMN "stopNotificationState" TEXT,
  ADD CONSTRAINT "LiveChannelRun_stopNotification_shape" CHECK (
    ("stopNotificationKind" IS NULL AND "stopNotificationAt" IS NULL AND "stopNotificationState" IS NULL)
    OR ("stopNotificationKind" IS NOT NULL AND "stopNotificationKind" IN ('CHANNEL_STOPPED','CHANNEL_ERROR')
        AND "stopNotificationAt" IS NOT NULL AND "stopNotificationState" IS NOT NULL
        AND "stopNotificationState" IN ('PENDING','PROCESSED','FAILED','LEGACY_UNKNOWN','NO_DESTINATION'))
  );

CREATE TABLE "LiveStopNotification" (
  "id" UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)
    REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "channelId" UUID NOT NULL,
  "channelName" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('CHANNEL_STOPPED','CHANNEL_ERROR')),
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "failures" INTEGER NOT NULL DEFAULT 0 CHECK ("failures" BETWEEN 0 AND 5),
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID,
  "finishedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "skipped" BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (NOT "skipped" OR ("finishedAt" IS NOT NULL AND "failureReason" IS NULL)),
  CHECK (("finishedAt" IS NULL AND "nextAttemptAt" IS NOT NULL AND "failureReason" IS NULL AND "failures" < 5)
    OR ("finishedAt" IS NOT NULL AND "nextAttemptAt" IS NULL AND "leaseToken" IS NULL AND
        (("failureReason" IS NULL AND "failures" < 5) OR ("failureReason" IS NOT NULL AND "failures" BETWEEN 1 AND 5))))
);

CREATE INDEX "LiveStopNotification_organizationId_nextAttemptAt_id_idx"
  ON "LiveStopNotification" ("organizationId", "nextAttemptAt", "id");
CREATE INDEX "LiveStopNotification_organizationId_finishedAt_id_idx"
  ON "LiveStopNotification" ("organizationId", "finishedAt", "id");
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LiveStopNotification"
  FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LiveStopNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveStopNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LiveStopNotification" USING
  ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid))
  WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
