ALTER TABLE "LiveSchedule" ADD COLUMN "startAdmissionFenceVersion" INTEGER,
  ADD CONSTRAINT "LiveSchedule_start_admission_check" CHECK (
    "startAdmissionFenceVersion" IS NULL OR
    (action = 'START' AND "liveChannelRunId" IS NOT NULL AND "startAdmissionFenceVersion" >= 0)
  );

ALTER TABLE "LiveChannelRun" ADD COLUMN "legacyProvisionAdmissionAt" TIMESTAMP(3);
ALTER TABLE "LiveChannel" ADD COLUMN "legacyAdmissionFenceVersion" INTEGER,
  ADD COLUMN "manualProvisionAdmissionFenceVersion" INTEGER;
-- Snapshot active admissions that can have a retained START or an exhausted pre-journal STOP.
-- A later admission always increments the live fence and cannot match this snapshot.
DO $$
DECLARE org UUID;
BEGIN
  FOR org IN SELECT id FROM "Organization" LOOP
    PERFORM set_config('bitovp.organization_id', org::text, true);
    UPDATE "LiveChannel" SET "legacyAdmissionFenceVersion" = "liveEffectFenceVersion"
    WHERE "organizationId" = org AND status IN ('CREATED', 'PROVISIONING', 'STOPPING');
    -- An unbound FIRED row may precede an unrelated manual admission. Only
    -- the run binding committed by the old scheduler can identify its airing.
    -- A dispatch from before a later same-run revival is likewise not its job.
    -- Unstamped queue delivery requires the same PostgreSQL transaction on
    -- schedule and run (both written by the old scheduler); timestamp proximity
    -- alone is insufficient. Read xmin before installing the run snapshot.
    WITH pending_runs AS (
      SELECT r.id, r."liveChannelId", r."updatedAt", r.xmin AS run_tx, c."legacyAdmissionFenceVersion" AS generation
      FROM "LiveChannelRun" r JOIN "LiveChannel" c ON c.id = r."liveChannelId"
      WHERE c."organizationId" = org AND r."organizationId" = org
        AND c.status = 'PROVISIONING' AND r.status = 'PROVISIONING'
        AND r."legacyProvisionAdmissionAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "LiveChannelRun" later WHERE later."liveChannelId" = c.id AND later.seq > r.seq)
    ), candidates AS (
      SELECT r.id AS run_id, r.generation, s.id AS schedule_id, s.xmin = r.run_tx AS proven
      FROM pending_runs r JOIN "LiveSchedule" s ON s."liveChannelRunId" = r.id AND s."liveChannelId" = r."liveChannelId"
      WHERE s."organizationId" = org AND s.action = 'START' AND s.status = 'FIRED'
        AND s.outcome IN ('PENDING','UNKNOWN') AND s."startAdmissionFenceVersion" IS NULL AND s."firedAt" IS NOT NULL
        AND ((s."dispatchedAt" IS NOT NULL AND s."dispatchJobId" = 'sched-' || s.id::text AND s."dispatchedAt" >= r."updatedAt")
          OR (s."dispatchedAt" IS NULL AND s."dispatchJobId" IS NULL AND s.xmin = r.run_tx))
    ), owners AS (
      SELECT r.id, r."updatedAt", r.generation, CASE WHEN count(m.schedule_id) = 1 THEN array_agg(m.schedule_id) FILTER (WHERE m.proven) END AS schedules
      FROM pending_runs r LEFT JOIN candidates m ON m.run_id = r.id
      GROUP BY r.id,r."updatedAt",r.generation
    ), stamp_schedules AS (
      UPDATE "LiveSchedule" s SET "startAdmissionFenceVersion" = o.generation FROM owners o
      WHERE s.id = o.schedules[1]
    )
    -- An ACK writes a new schedule tuple, including when a different manual
    -- revival already won. Its timestamp alone cannot prove START ownership.
    -- All admitted airings retain their own generation for anonymous recovery.
    -- Only a positively attributed schedule can take credit for this execution.
    UPDATE "LiveChannelRun" r SET "legacyProvisionAdmissionAt" = o."updatedAt"
    FROM owners o WHERE r.id = o.id;
    -- Old acknowledgements can be committed after a different START revives
    -- the same run. Preserve the earlier schedule's uncertainty even if its
    -- last queue delivery was already evicted before this upgrade.
    UPDATE "LiveSchedule" s SET outcome = 'UNKNOWN', "outcomeAt" = CURRENT_TIMESTAMP,
      "outcomeEvidenceVersion" = 1, "outcomeEvidenceKind" = 'JOB_TERMINAL_UNKNOWN',
      "outcomeEvidenceAt" = CURRENT_TIMESTAMP,
      "outcomeNote" = 'The pre-upgrade START could not be attributed to the current airing. Check the channel before scheduling another start.'
    FROM "LiveChannelRun" r JOIN "LiveChannel" c ON c.id = r."liveChannelId"
    WHERE s."organizationId" = org AND r."organizationId" = org AND c."organizationId" = org
      AND s."liveChannelRunId" = r.id AND s."liveChannelId" = c.id
      AND r."legacyProvisionAdmissionAt" IS NOT NULL AND c.status = 'PROVISIONING'
      AND s.action = 'START' AND s.status = 'FIRED' AND s.outcome = 'PENDING'
      AND s."startAdmissionFenceVersion" IS NULL AND s."dispatchJobId" = 'sched-' || s.id::text
      AND NOT EXISTS (SELECT 1 FROM "LiveChannelRun" later WHERE later."liveChannelId" = c.id AND later.seq > r.seq);
  END LOOP;
END $$;
