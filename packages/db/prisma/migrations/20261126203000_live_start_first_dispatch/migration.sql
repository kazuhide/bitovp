ALTER TABLE "LiveSchedule" ADD COLUMN "firstStartDispatchAt" TIMESTAMP(3);

-- Preserve historical START acknowledgments under the same tenant scope
-- required by LiveSchedule's row-level security policy.
DO $$
DECLARE org UUID;
BEGIN
  FOR org IN SELECT id FROM "Organization" LOOP
    PERFORM set_config('bitovp.organization_id', org::text, true);
    UPDATE "LiveSchedule"
    SET "firstStartDispatchAt" = "dispatchedAt"
    WHERE "organizationId" = org AND action = 'START'
      AND "dispatchedAt" IS NOT NULL AND "firstStartDispatchAt" IS NULL;
  END LOOP;
END $$;
