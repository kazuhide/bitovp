ALTER TABLE "LiveChannelRun"
  ADD COLUMN "stopNotificationKind" TEXT,
  ADD COLUMN "stopNotificationAt" TIMESTAMP(3),
  ADD COLUMN "stopNotificationQueuedAt" TIMESTAMP(3),
  ADD CONSTRAINT "LiveChannelRun_stopNotification_shape" CHECK (
    ("stopNotificationKind" IS NULL AND "stopNotificationAt" IS NULL AND "stopNotificationQueuedAt" IS NULL)
    OR ("stopNotificationKind" IS NOT NULL AND "stopNotificationKind" IN ('CHANNEL_STOPPED','CHANNEL_ERROR') AND "stopNotificationAt" IS NOT NULL)
  );

CREATE INDEX "LiveChannelRun_pendingStopNotification" ON "LiveChannelRun" ("organizationId", "id")
  WHERE "stopNotificationAt" IS NOT NULL AND "stopNotificationQueuedAt" IS NULL;
