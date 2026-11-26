-- A retained pre-upgrade job can occupy the bare schedule key even when the
-- old scheduler never persisted its queue handoff. Allocate the new delivery
-- identity before the outbox can publish the migrated admission.
DO $$
DECLARE org uuid;
BEGIN
  FOR org IN SELECT id FROM "Organization" LOOP
    PERFORM set_config('bitovp.organization_id', org::text, true);
    UPDATE "LiveSchedule" s
       SET "stopDeliveryToken" = gen_random_uuid()
      FROM "LiveChannel" c
      JOIN "LiveChannelRun" r
        ON r."liveChannelId" = c.id AND r."organizationId" = c."organizationId"
     WHERE s."organizationId" = org AND c."organizationId" = org
       AND s."liveChannelId" = c.id AND s."liveChannelRunId" = r.id
       AND c.origin = 'MANAGED' AND c.status = 'STOPPING' AND r.status = 'STOPPING'
       -- The earlier migration is the only pre-token writer of a fence 1
       -- admission from an unchanged, zero-fence channel.
       AND c."liveEffectFenceVersion" = 1 AND s."stopAdmissionFenceVersion" = 1
       AND s."stopProviderEncodingId" = c."bitmovinEncodingId"
       AND r."bitmovinEncodingId" = c."bitmovinEncodingId"
       AND btrim(c."bitmovinEncodingId") <> ''
       AND r."archivedRtmpAttempt" = 0 AND cardinality(r."previousProviderEncodingIds") = 0
       AND s.action = 'STOP' AND s.status = 'FIRED' AND s.outcome = 'PENDING'
       AND s."firedAt" IS NOT NULL AND s."dispatchedAt" IS NULL AND s."dispatchJobId" IS NULL
       AND s."stopDeliveryToken" IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM "LiveChannelRun" newer
          WHERE newer."liveChannelId" = c.id AND newer.seq > r.seq
       )
       AND NOT EXISTS (
         SELECT 1 FROM "LiveEffectClaim" claim
          WHERE claim."organizationId" = org AND claim."liveChannelId" = c.id
            AND claim."liveChannelRunId" = r.id AND claim.action = 'STOP'
            AND (claim."scheduleId" = s.id OR claim."idempotencyKey" = 'schedule:' || s.id::text || ':stop')
       );
  END LOOP;
END $$;
