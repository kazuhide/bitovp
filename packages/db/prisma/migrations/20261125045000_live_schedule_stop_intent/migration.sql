ALTER TABLE "LiveSchedule"
  ADD COLUMN "stopProviderEncodingId" TEXT,
  ADD COLUMN "stopAdmissionFenceVersion" INTEGER,
  ADD CONSTRAINT "LiveSchedule_stop_envelope_check" CHECK (
    ("stopProviderEncodingId" IS NULL AND "stopAdmissionFenceVersion" IS NULL)
    OR (action = 'STOP' AND "stopProviderEncodingId" IS NOT NULL
        AND "stopAdmissionFenceVersion" IS NOT NULL AND "stopAdmissionFenceVersion" >= 0)
  );

ALTER TABLE "LiveStopNotification"
  ADD COLUMN "scheduleId" UUID UNIQUE,
  DROP CONSTRAINT "LiveStopNotification_kind_check",
  ADD CONSTRAINT "LiveStopNotification_kind_check" CHECK (
    ("kind" IN ('CHANNEL_STOPPED', 'CHANNEL_ERROR') AND "scheduleId" IS NULL)
    OR ("kind" = 'SCHEDULE_FIRED' AND "scheduleId" IS NOT NULL)
  );
