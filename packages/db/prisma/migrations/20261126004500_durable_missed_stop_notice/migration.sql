ALTER TABLE "LiveStopNotification"
  DROP CONSTRAINT "LiveStopNotification_kind_check",
  ADD CONSTRAINT "LiveStopNotification_kind_check" CHECK (
    ("kind" IN ('CHANNEL_STOPPED', 'CHANNEL_ERROR') AND "scheduleId" IS NULL)
    OR ("kind" IN ('SCHEDULE_FIRED', 'SCHEDULE_MISSED') AND "scheduleId" IS NOT NULL)
  );
