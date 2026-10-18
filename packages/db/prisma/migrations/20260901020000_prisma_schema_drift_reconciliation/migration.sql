-- Reconcile the deployed schema with schema.prisma after two migration-only
-- restart counters and four PostgreSQL-truncated object names drifted from the
-- current datamodel. The counters have no current reader or writer. Refuse to
-- discard them if any row nevertheless contains evidence that cannot be
-- represented by the current schema.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FeederSession" WHERE "restartCount" <> 0) THEN
    RAISE EXCEPTION 'schema drift repair refused: FeederSession.restartCount contains nonzero values';
  END IF;

  IF EXISTS (SELECT 1 FROM "LiveChannelRun" WHERE "encoderRestartCount" <> 0) THEN
    RAISE EXCEPTION 'schema drift repair refused: LiveChannelRun.encoderRestartCount contains nonzero values';
  END IF;
END $$;

ALTER TABLE "FeederSession" DROP COLUMN "restartCount";
ALTER TABLE "LiveChannelRun" DROP COLUMN "encoderRestartCount";

-- PostgreSQL silently truncated the overlength names in the three migrations
-- that created these objects. Prisma keeps its semantic suffix (`_idx`,
-- `_key`, `_fkey`) by truncating the field-derived prefix instead. Rename the
-- deployed 63-byte names to those exact Prisma targets.
ALTER INDEX "LiveChannelRun_providerTerminalAt_providerFeederStopsEnqueuedAt" RENAME TO "LiveChannelRun_providerTerminalAt_providerFeederStopsEnqueu_idx";
ALTER INDEX "VerificationLiveEvidence_verificationRunId_scenario_liveChan_ke" RENAME TO "VerificationLiveEvidence_verificationRunId_scenario_liveCha_key";
ALTER INDEX "VerificationResourceIntentEvent_verificationResourceIntentId_se" RENAME TO "VerificationResourceIntentEvent_verificationResourceIntentI_key";
ALTER TABLE "VerificationResourceIntentEvent" RENAME CONSTRAINT "VerificationResourceIntentEvent_verificationResourceIntentId_fk" TO "VerificationResourceIntentEvent_verificationResourceIntent_fkey";

COMMIT;
