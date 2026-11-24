ALTER TABLE "LiveSchedule" ADD COLUMN "startAdmissionFenceVersion" INTEGER,
  ADD CONSTRAINT "LiveSchedule_start_admission_check" CHECK (
    "startAdmissionFenceVersion" IS NULL OR
    (action = 'START' AND "liveChannelRunId" IS NOT NULL AND "startAdmissionFenceVersion" >= 0)
  );

ALTER TABLE "LiveChannel" ADD COLUMN "legacyAdmissionFenceVersion" INTEGER;
-- Snapshot active admissions that can have a retained START or an exhausted pre-journal STOP.
-- A later admission always increments the live fence and cannot match this snapshot.
DO $$
DECLARE org UUID;
BEGIN
  FOR org IN SELECT id FROM "Organization" LOOP
    PERFORM set_config('bitovp.organization_id', org::text, true);
    UPDATE "LiveChannel" SET "legacyAdmissionFenceVersion" = "liveEffectFenceVersion"
    WHERE "organizationId" = org AND status IN ('CREATED', 'PROVISIONING', 'STOPPING');
  END LOOP;
END $$;
