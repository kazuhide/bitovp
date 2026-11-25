-- Compare a progress snapshot with its previous graph. Only the fields below
-- can change without changing the validity of an already parsed step. Unknown
-- or structurally changed history stays on the conservative ownership fence.
-- A non-null result contains the encoding identities whose receipts changed.
CREATE OR REPLACE FUNCTION bitovp_reset_live_journal_ids(prior jsonb, current_log jsonb)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  pair record;
  item jsonb;
  ids text[] := ARRAY[]::text[];
  progress_fields constant text[] := ARRAY['status','resourceId','request','response','startedAt','finishedAt','error','adoptExistingOnly','childCreateDispatch'];
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
        -- The optional child handoff and adoption markers do not name an
        -- encoder. Match stepLogEntrySchema exactly: malformed legacy values
        -- can make an inventory incomplete and must keep the broader lock.
        OR (item ? 'adoptExistingOnly' AND item->'adoptExistingOnly' <> 'true'::jsonb)
        OR (item ? 'childCreateDispatch' AND item->'childCreateDispatch'
            NOT IN ('"PREPARING"'::jsonb, '"DISPATCHING"'::jsonb))
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
