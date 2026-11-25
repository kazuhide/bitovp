-- The old scheduler wrote FIRED before advancing the channel fence and mirroring STOPPING.
-- Complete that interrupted admission only while both original ownership rows still predate
-- the fire. A later owner or an unprovable identity is left for the existing operator flow.
DO $$
DECLARE
  org uuid;
  target record;
  admitted integer;
BEGIN
  FOR org IN SELECT id FROM "Organization" LOOP
    PERFORM set_config('bitovp.organization_id', org::text, true);
    FOR target IN
      SELECT c.id AS channel_id, r.id AS run_id, s.id AS schedule_id,
             c."bitmovinEncodingId" AS encoder, c."liveEffectFenceVersion" AS fence
        FROM "LiveChannel" c
        JOIN "LiveChannelRun" r ON r."liveChannelId" = c.id AND r."organizationId" = org
        JOIN "LiveSchedule" s ON s."liveChannelRunId" = r.id AND s."liveChannelId" = c.id
                             AND s."organizationId" = org
       WHERE c."organizationId" = org AND c.origin = 'MANAGED'
         AND c.status IN ('RUNNING','ERROR') AND r.status IN ('RUNNING','ERROR')
         AND c."bitmovinEncodingId" = r."bitmovinEncodingId" AND btrim(c."bitmovinEncodingId") <> ''
         AND s.action = 'STOP' AND s.status = 'FIRED' AND s.outcome = 'PENDING'
         AND s."firedAt" IS NOT NULL AND s."dispatchedAt" IS NULL AND s."dispatchJobId" IS NULL
         AND s."stopAdmissionFenceVersion" IS NULL AND s."stopProviderEncodingId" IS NULL
         AND c."updatedAt" < s."firedAt" AND r."updatedAt" < s."firedAt"
         AND age(c.xmin) > age(s.xmin) AND age(r.xmin) > age(s.xmin)
         AND NOT EXISTS (SELECT 1 FROM "LiveChannelRun" n WHERE n."liveChannelId" = c.id AND n.seq > r.seq)
       ORDER BY c.id, s."firedAt", s.id
       FOR UPDATE OF c, r, s
    LOOP
      UPDATE "LiveChannel" SET status = 'STOPPING', "liveEffectFenceVersion" = target.fence + 1
       WHERE id = target.channel_id AND status IN ('RUNNING','ERROR')
         AND "liveEffectFenceVersion" = target.fence AND "bitmovinEncodingId" = target.encoder
       RETURNING "liveEffectFenceVersion" INTO admitted;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE "LiveChannelRun" SET status = 'STOPPING' WHERE id = target.run_id;
      UPDATE "LiveSchedule" SET "stopProviderEncodingId" = target.encoder, "stopAdmissionFenceVersion" = admitted
       WHERE id = target.schedule_id;
    END LOOP;
  END LOOP;
END $$;
