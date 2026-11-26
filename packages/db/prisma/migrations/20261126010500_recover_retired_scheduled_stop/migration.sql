-- The pre-upgrade worker could retire a refired schedule while refusing the
-- earlier job under the same Redis key. Recover observation of the current
-- airing. UNKNOWN never authorizes the outbox to enqueue another provider STOP.
DO $$
DECLARE org uuid;
BEGIN
  FOR org IN SELECT id FROM "Organization" LOOP
    PERFORM set_config('bitovp.organization_id', org::text, true);
    UPDATE "LiveSchedule" s
       SET status = 'FIRED', outcome = 'UNKNOWN',
           "outcomeNote" = 'An earlier scheduled STOP was refused. Delivery of the refired schedule could not be confirmed.',
           "outcomeAt" = statement_timestamp(), "outcomeEvidenceAt" = statement_timestamp(),
           "outcomeEvidenceKind" = 'JOB_TERMINAL_UNKNOWN', "outcomeEvidenceVersion" = 1,
           "updatedAt" = statement_timestamp()
      FROM "LiveChannel" c JOIN "LiveChannelRun" r
        ON r."liveChannelId" = c.id AND r."organizationId" = c."organizationId"
     WHERE c."organizationId" = org AND s."organizationId" = org
       AND s."liveChannelId" = c.id AND s."liveChannelRunId" = r.id
       AND c.origin = 'MANAGED' AND c.status = 'STOPPING'
       AND c."legacyAdmissionFenceVersion" = c."liveEffectFenceVersion"
       AND r.status IN ('RUNNING', 'STOPPING', 'ERROR')
       AND r."bitmovinEncodingId" = c."bitmovinEncodingId" AND btrim(c."bitmovinEncodingId") <> ''
       AND NOT EXISTS (SELECT 1 FROM "LiveChannelRun" newer WHERE newer."liveChannelId" = c.id AND newer.seq > r.seq)
       AND s.action = 'STOP' AND s.status = 'SKIPPED_STALE_GENERATION' AND s.outcome = 'FAILED'
       AND s."firedAt" IS NOT NULL AND s."stopAdmissionFenceVersion" IS NULL AND s."stopProviderEncodingId" IS NULL
       AND (s."dispatchJobId" IS NULL OR s."dispatchJobId" = 'sched-' || s.id::text)
       AND s."outcomeEvidenceKind" = 'STALE_GENERATION_REFUSAL'
       AND s."outcomeNote" IN (
         'the live effect generation changed after admission',
         'the live effect generation changed while the claim was acquired',
         'the planned live run or provider encoding is no longer current'
       )
       AND NOT EXISTS (
         SELECT 1 FROM "LiveSchedule" other WHERE other."liveChannelId" = c.id AND other."liveChannelRunId" = r.id
           AND other.action = 'STOP' AND other.status = 'FIRED' AND other.outcome IN ('PENDING', 'UNKNOWN')
       )
       AND NOT EXISTS (
         SELECT 1 FROM "LiveEffectClaim" claim WHERE claim."liveChannelId" = c.id
           AND (claim.state IN ('CLAIMED', 'DISPATCHING', 'AMBIGUOUS') OR claim.generation >= c."liveEffectFenceVersion")
       );
  END LOOP;
END $$;
