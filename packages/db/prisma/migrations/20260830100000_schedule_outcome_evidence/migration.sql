-- Versioned schedule-outcome evidence.
--
-- Idempotent by construction: the enum/columns are guarded, and the rewrite
-- targets only positive rows whose evidence version is NULL. Re-running this
-- artifact changes zero rows and reports that fact.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LiveScheduleOutcomeEvidenceKind') THEN
    CREATE TYPE "LiveScheduleOutcomeEvidenceKind" AS ENUM (
      'PROVIDER_RUNNING',
      'PROVIDER_TERMINAL',
      'PROVIDER_STATUS_UNKNOWN',
      'HEARTBEAT_INGEST_CONNECTED',
      'FEEDER_PROCESS_PUSHING',
      'SLATE_ARMED',
      'EFFECT_FAILED',
      'JOB_TERMINAL_UNKNOWN',
      'STALE_GENERATION_REFUSAL'
    );
  END IF;
END $$;

ALTER TABLE "LiveSchedule"
  ADD COLUMN IF NOT EXISTS "outcomeEvidenceVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "outcomeEvidenceKind" "LiveScheduleOutcomeEvidenceKind",
  ADD COLUMN IF NOT EXISTS "outcomeEvidenceAt" TIMESTAMP(3);

DO $$
DECLARE
  delivered_before BIGINT;
  ingest_before BIGINT;
  changed_count BIGINT;
BEGIN
  SELECT count(*) INTO delivered_before
    FROM "LiveSchedule"
   WHERE outcome = 'DELIVERED' AND "outcomeEvidenceVersion" IS NULL;
  SELECT count(*) INTO ingest_before
    FROM "LiveSchedule"
   WHERE outcome = 'INGEST_CONNECTED' AND "outcomeEvidenceVersion" IS NULL;

  -- No historical promotion is guessed. A local RUNNING/STOPPED row or an
  -- old ffmpeg PUSHING stamp is not a uniquely joined provider/media witness.
  UPDATE "LiveSchedule"
     SET outcome = 'UNKNOWN',
         "outcomeNote" = 'Legacy data — delivery was not verified under the current evidence contract',
         "outcomeEvidenceVersion" = NULL,
         "outcomeEvidenceKind" = NULL,
         "outcomeEvidenceAt" = NULL
   WHERE outcome IN ('DELIVERED', 'INGEST_CONNECTED')
     AND "outcomeEvidenceVersion" IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  RAISE NOTICE 'SC-02 schedule evidence migration: legacy DELIVERED=%, legacy INGEST_CONNECTED=%, promoted=0, changed-to-UNKNOWN=%; feeder pushes promoted=0',
    delivered_before, ingest_before, changed_count;
END $$;
