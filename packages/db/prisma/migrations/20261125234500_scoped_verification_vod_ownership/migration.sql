-- Verification cleanup reads VOD ownership through three independent identities:
-- the local job, its verification key, and each paid encoder in either durable
-- projection. Hold only those identities across a matching provider request.
CREATE FUNCTION bitovp_lock_reset_vod_owner_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_key text;
BEGIN
  -- Pre-upgrade cleanup workers still hold this tenant key exclusively. New
  -- workers only need a shared grant on it, which admits unrelated VOD jobs.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-ownership/' || NEW."organizationId"::text, 0));
  FOR owner_key IN
    SELECT DISTINCT identity
    FROM (
      SELECT 'job:' || NEW.id::text AS identity
      UNION ALL SELECT 'verification:' || NEW."verificationKey"
      UNION ALL SELECT 'encoding:' || NEW."bitmovinEncodingId"
      UNION ALL
      SELECT 'encoding:' || (entry->>'resourceId')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."stepLog") = 'array'
        THEN NEW."stepLog" ELSE '[]'::jsonb END) AS steps(entry)
      WHERE entry->>'kind' = 'CREATE_ENCODING' AND jsonb_typeof(entry->'resourceId') = 'string'
    ) AS identities
    WHERE identity IS NOT NULL ORDER BY identity
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('bitovp/reset-vod/' || NEW."organizationId"::text || '/' || owner_key, 0));
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER reset_owner_write ON "EncodingJob";
-- Deletion can release ownership but cannot introduce a new adoption.
CREATE TRIGGER reset_owner_write BEFORE INSERT OR UPDATE OF
  "id", "bitmovinEncodingId", "bitmovinAccountId", "plan", "stepLog", "verificationKey" ON "EncodingJob"
FOR EACH ROW EXECUTE FUNCTION bitovp_lock_reset_vod_owner_write();

-- Live history can contain unnamed older rentals or unparseable provider faults.
-- The full retained-airing inventory and account scope changes share their own
-- fence; ordinary VOD writes do not take it.
CREATE OR REPLACE FUNCTION bitovp_lock_reset_owner_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  organization text;
BEGIN
  IF TG_OP = 'DELETE' THEN organization := OLD."organizationId"::text;
  ELSE organization := NEW."organizationId"::text; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-ownership/' || organization, 0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-live/' || organization, 0));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Using this migration-owned function also makes a worker running ahead of
-- the migration unable to send. Try-locks defer cleanup behind active adoption.
CREATE FUNCTION bitovp_try_reset_verification_send(identities text[]) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  organization text := current_setting('bitovp.organization_id');
  identity text;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('bitovp/reset-ownership/' || organization, 0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('bitovp/reset-live/' || organization, 0)) THEN
    RETURN false;
  END IF;
  FOREACH identity IN ARRAY identities LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('bitovp/reset-vod/' || organization || '/' || identity, 0)) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
