-- Compare a progress snapshot with its previous graph. Only the fields below
-- can change without changing the validity of an already parsed step. Unknown
-- or structurally changed history stays on the conservative ownership fence.
-- A non-null result contains the encoding identities whose receipts changed.
CREATE FUNCTION bitovp_reset_live_journal_ids(prior jsonb, current_log jsonb)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  pair record;
  item jsonb;
  ids text[] := ARRAY[]::text[];
  progress_fields constant text[] := ARRAY['status','resourceId','request','response','startedAt','finishedAt','error'];
BEGIN
  IF prior IS NOT DISTINCT FROM current_log THEN RETURN ids; END IF;
  IF jsonb_typeof(prior) IS DISTINCT FROM 'array' OR jsonb_typeof(current_log) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  IF jsonb_array_length(prior) <> jsonb_array_length(current_log) THEN RETURN NULL; END IF;
  FOR pair IN
    SELECT a.old_step, current_log->(a.position::integer-1) AS new_step
    FROM jsonb_array_elements(prior) WITH ORDINALITY AS a(old_step, position)
    WHERE a.old_step IS DISTINCT FROM current_log->(a.position::integer-1)
  LOOP
    IF jsonb_typeof(pair.old_step) <> 'object' OR jsonb_typeof(pair.new_step) <> 'object' THEN RETURN NULL; END IF;
    IF (pair.old_step - progress_fields) <> (pair.new_step - progress_fields) THEN RETURN NULL; END IF;
    FOREACH item IN ARRAY ARRAY[pair.old_step,pair.new_step] LOOP
      IF coalesce(item->>'status','') NOT IN ('PENDING','RUNNING','DONE','FAILED')
        OR EXISTS (SELECT 1 FROM jsonb_each(item) AS field
          WHERE key IN ('resourceId','error','startedAt','finishedAt') AND jsonb_typeof(value) <> 'string')
      THEN RETURN NULL; END IF;
    END LOOP;
    IF pair.old_step->>'kind' IN ('CREATE_ENCODING','RESOLVE_AISA_LIVE_ENCODING')
       AND pair.old_step->'resourceId' IS DISTINCT FROM pair.new_step->'resourceId' THEN
      ids := ids || ARRAY[pair.old_step->>'resourceId',pair.new_step->>'resourceId'];
    END IF;
  END LOOP;
  RETURN ids;
END;
$$;

CREATE OR REPLACE FUNCTION bitovp_lock_reset_owner_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  organization text;
  stable_owner boolean := false;
  affected_ids text[];
  target text;
BEGIN
  IF TG_OP = 'DELETE' THEN organization := OLD."organizationId"::text;
  ELSE organization := NEW."organizationId"::text; END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('LiveChannel','LiveChannelRun') THEN
    IF TG_TABLE_NAME = 'LiveChannel' THEN
      stable_owner := ROW(OLD.id, OLD."bitmovinAccountId", OLD.plan, OLD.error, OLD."verificationKey", OLD."resetOrphanEncoderEvidence")
        IS NOT DISTINCT FROM ROW(NEW.id, NEW."bitmovinAccountId", NEW.plan, NEW.error, NEW."verificationKey", NEW."resetOrphanEncoderEvidence");
    ELSE
      stable_owner := ROW(OLD."liveChannelId", OLD.seq, OLD."previousProviderEncodingIds", OLD."archivedRtmpAttempt", OLD.error, OLD."rtmpRetirementEvidence", OLD."aisaAnalysisId")
        IS NOT DISTINCT FROM ROW(NEW."liveChannelId", NEW.seq, NEW."previousProviderEncodingIds", NEW."archivedRtmpAttempt", NEW.error, NEW."rtmpRetirementEvidence", NEW."aisaAnalysisId");
    END IF;
    IF stable_owner THEN
      affected_ids := bitovp_reset_live_journal_ids(OLD."stepLog", NEW."stepLog");
      IF OLD."bitmovinEncodingId" IS DISTINCT FROM NEW."bitmovinEncodingId" AND affected_ids IS NOT NULL THEN
        -- Introducing a first ownership pointer can bring an entire legacy
        -- airing (including an unreadable journal) into the retained inventory.
        IF OLD."bitmovinEncodingId" IS NULL AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD."stepLog") = 'array'
            THEN OLD."stepLog" ELSE '[]'::jsonb END) AS steps(entry)
          WHERE entry->>'kind' IN ('CREATE_ENCODING','RESOLVE_AISA_LIVE_ENCODING','START_LIVE_ENCODING','CREATE_INPUT_RTMP')
        ) THEN affected_ids := NULL;
        ELSE affected_ids := affected_ids || ARRAY[OLD."bitmovinEncodingId",NEW."bitmovinEncodingId"]; END IF;
      END IF;
      -- The ownership inventory is byte-equivalent for cleanup's purposes.
      -- Other rows, including both mirrors of a successful Live startup, can
      -- finish recording progress while an earlier VOD STOP awaits its reply.
      IF cardinality(affected_ids) = 0 THEN RETURN NEW; END IF;
    END IF;
  END IF;

  -- Honor a rolling deployment with earlier native verification senders.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-ownership/' || organization, 0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-live/' || organization, 0));
  IF affected_ids IS NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-live-unclassified/' || organization, 0));
  ELSE
    FOR target IN SELECT DISTINCT id FROM unnest(affected_ids) AS known(id) WHERE id IS NOT NULL ORDER BY id LOOP
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-vod/' || organization || '/encoding:' || target, 0));
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Live verification intents can have additional local/verification ownership
-- aliases. Preserve the original guard for those and for older callers.
CREATE FUNCTION bitovp_try_reset_verification_send(identities text[], vod boolean) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  organization text := current_setting('bitovp.organization_id');
  identity text;
BEGIN
  IF NOT vod THEN RETURN bitovp_try_reset_verification_send(identities); END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('bitovp/reset-ownership/' || organization, 0))
    OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('bitovp/reset-live/' || organization, 0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('bitovp/reset-live-unclassified/' || organization, 0)) THEN
    RETURN false;
  END IF;
  FOREACH identity IN ARRAY identities LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('bitovp/reset-vod/' || organization || '/' || identity, 0)) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
