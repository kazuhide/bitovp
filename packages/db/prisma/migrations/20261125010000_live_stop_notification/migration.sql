ALTER TABLE "LiveChannelRun"
  ADD COLUMN "stopNotificationKind" TEXT,
  ADD COLUMN "stopNotificationAt" TIMESTAMP(3),
  ADD COLUMN "stopNotificationState" TEXT,
  ADD CONSTRAINT "LiveChannelRun_stopNotification_shape" CHECK (
    ("stopNotificationKind" IS NULL AND "stopNotificationAt" IS NULL AND "stopNotificationState" IS NULL)
    OR ("stopNotificationKind" IS NOT NULL AND "stopNotificationKind" IN ('CHANNEL_STOPPED','CHANNEL_ERROR')
        AND "stopNotificationAt" IS NOT NULL AND "stopNotificationState" IS NOT NULL
        AND "stopNotificationState" IN ('PENDING','PROCESSED','FAILED','LEGACY_UNKNOWN'))
  );

CREATE TABLE "LiveStopNotification" (
  "id" UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)
    REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "channelId" UUID NOT NULL,
  "channelName" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('CHANNEL_STOPPED','CHANNEL_ERROR')),
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "failures" INTEGER NOT NULL DEFAULT 0 CHECK ("failures" BETWEEN 0 AND 4),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID
);

CREATE INDEX "LiveStopNotification_organizationId_nextAttemptAt_id_idx"
  ON "LiveStopNotification" ("organizationId", "nextAttemptAt", "id");
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LiveStopNotification"
  FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LiveStopNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveStopNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LiveStopNotification" USING
  ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid))
  WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
