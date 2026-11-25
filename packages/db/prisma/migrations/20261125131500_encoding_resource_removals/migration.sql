BEGIN;
CREATE TABLE "EncodingResourceRemoval" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id',true),'')::uuid) REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceKind" TEXT NOT NULL CHECK ("sourceKind" IN ('VOD','LIVE')),
  "sourceId" UUID NOT NULL,
  "channelId" UUID,
  "step" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "providerId" TEXT NOT NULL,
  "accountId" UUID NOT NULL,
  "scopeVersion" UUID NOT NULL,
  "token" UUID NOT NULL,
  "state" TEXT NOT NULL CHECK ("state" IN ('SENDING','UNKNOWN','REFUSED','REMOVED')),
  "pendingJobId" UUID,
  "pendingRunId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EncodingResourceRemoval_pendingJob_fkey" FOREIGN KEY ("organizationId","pendingJobId") REFERENCES "EncodingJob"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "EncodingResourceRemoval_pendingRun_fkey" FOREIGN KEY ("organizationId","pendingRunId") REFERENCES "LiveChannelRun"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "EncodingResourceRemoval_ownership" CHECK (
    ("state" IN ('REMOVED','REFUSED') AND "pendingJobId" IS NULL AND "pendingRunId" IS NULL) OR
    ("state" IN ('SENDING','UNKNOWN') AND (("sourceKind"='VOD' AND "pendingJobId" = "sourceId" AND "pendingJobId" IS NOT NULL AND "pendingRunId" IS NULL) OR
    ("sourceKind"='LIVE' AND "pendingRunId" = "sourceId" AND "pendingRunId" IS NOT NULL AND "pendingJobId" IS NULL)))),
  CONSTRAINT "EncodingResourceRemoval_source_key" UNIQUE ("organizationId","sourceKind","sourceId","step","attempt","providerId")
);
CREATE INDEX "EncodingResourceRemoval_channel_state" ON "EncodingResourceRemoval"("organizationId","channelId","state");
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "EncodingResourceRemoval" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "EncodingResourceRemoval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EncodingResourceRemoval" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "EncodingResourceRemoval" USING ("organizationId" = NULLIF(current_setting('bitovp.organization_id',true),'')::uuid)
WITH CHECK ("organizationId" = NULLIF(current_setting('bitovp.organization_id',true),'')::uuid);

-- Source journals use a shared lock only while a transaction publishes a plan or journal.
-- The reservation takes the same row exclusively, and commits before contacting Bitmovin.
-- Touching the row also makes an older repeatable-read publisher retry its stale snapshot.
INSERT INTO "PlatformSetting" ("key","value","updatedAt")
VALUES ('internal.encoding_resource_removal_epoch', 'null'::jsonb, clock_timestamp());
CREATE INDEX "EncodingResourceRemoval_active_provider" ON "EncodingResourceRemoval"("providerId")
WHERE state IN ('SENDING','UNKNOWN');

-- Return a boolean only for an actual DONE producer belonging to the authenticated organization.
-- Another tenant's row, account and identifier are never returned. Differing explicit upstream
-- organizations distinguish same-ID records only while both account bindings remain proven.
CREATE FUNCTION bitovp_resource_exclusive(p_kind text,p_source uuid,p_step text,p_attempt integer,p_resource text,p_account uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET row_security=off AS $$
DECLARE
  caller_org uuid := NULLIF(current_setting('bitovp.organization_id',true),'')::uuid;
  old_timeout text := current_setting('lock_timeout');
  locked boolean;
BEGIN
  IF caller_org IS NULL OR current_setting('transaction_isolation') <> 'read committed' OR NOT (
    (p_kind='VOD' AND EXISTS(SELECT FROM public."EncodingJob" WHERE id=p_source AND "organizationId"=caller_org)) OR
    (p_kind='LIVE' AND EXISTS(SELECT FROM public."LiveChannelRun" WHERE id=p_source AND "organizationId"=caller_org))
  ) THEN RETURN false; END IF;
  -- Ordinary short-lived publishers finish first. A long uncommitted writer keeps priority
  -- without holding a web request or other account reservations indefinitely.
  BEGIN
    PERFORM set_config('lock_timeout','1500ms',true);
    SELECT true INTO locked FROM public."PlatformSetting" WHERE key='internal.encoding_resource_removal_epoch' FOR UPDATE;
    PERFORM set_config('lock_timeout',old_timeout,true);
    IF locked IS DISTINCT FROM true THEN RETURN false; END IF;
  EXCEPTION WHEN lock_not_available THEN RETURN false;
  END;
  UPDATE public."PlatformSetting" SET "updatedAt"=clock_timestamp() WHERE key='internal.encoding_resource_removal_epoch';
  RETURN (
WITH all_sources AS (
  SELECT true AS producer,'VOD' AS kind,j.id,j."organizationId" AS org,j."createdAt" AS since,j.plan,j."stepLog" AS log,
    COALESCE(j.plan#>>'{bitmovin,accountId}',j."bitmovinAccountId"::text) AS account
    FROM public."EncodingJob" j
  UNION ALL
  SELECT true,'LIVE',r.id,r."organizationId",c."createdAt",c.plan,r."stepLog",
    COALESCE(c.plan#>>'{bitmovin,accountId}',c."bitmovinAccountId"::text)
    FROM public."LiveChannelRun" r JOIN public."LiveChannel" c ON c.id=r."liveChannelId" AND c."organizationId"=r."organizationId"
  UNION ALL
  SELECT false,CASE WHEN latest.id IS NULL THEN 'CHANNEL' ELSE 'LIVE' END,COALESCE(latest.id,c.id),c."organizationId",c."createdAt",c.plan,c."stepLog",
    COALESCE(c.plan#>>'{bitmovin,accountId}',c."bitmovinAccountId"::text)
    FROM public."LiveChannel" c LEFT JOIN LATERAL (SELECT r.id FROM public."LiveChannelRun" r WHERE r."liveChannelId"=c.id AND r."organizationId"=c."organizationId" ORDER BY r.seq DESC LIMIT 1) latest ON true
), own AS (
 SELECT s.org,a."tenantOrgId" AS upstream FROM all_sources s
 JOIN public."BitmovinAccount" a ON a.id=p_account AND a."organizationId"=s.org
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.log)='array' THEN s.log ELSE '[]'::jsonb END) e
 WHERE s.producer AND s.org=NULLIF(current_setting('bitovp.organization_id',true),'')::uuid AND s.kind=p_kind AND s.id=p_source
 AND e->>'step'=p_step AND e->>'status'='DONE' AND e->>'resourceId'=p_resource AND COALESCE(e->>'attempt','0')=p_attempt::text
 AND NOT jsonb_path_exists(s.plan,'$.** ? (@ == $id)',jsonb_build_object('id',p_resource))
 AND COALESCE(e#>>'{resourceAccount,id}',s.account)=a.id::text
 AND (e#>>'{resourceAccount,version}'=a."resourceScopeVersion"::text OR (NOT (e ? 'resourceAccount') AND COALESCE(a."resourceScopeSince",a."updatedAt")<s.since))
)
SELECT EXISTS(SELECT 1 FROM own) AND NOT EXISTS(
 SELECT 1 FROM own CROSS JOIN all_sources s LEFT JOIN public."BitmovinAccount" a ON a.id::text=s.account AND a."organizationId"=s.org
 WHERE (s.org,s.kind,s.id) IS DISTINCT FROM (own.org,p_kind,p_source)
 AND NOT COALESCE(own.upstream<>a."tenantOrgId" AND COALESCE(a."resourceScopeSince",a."updatedAt")<s.since
   AND NOT EXISTS(SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.log)='array' THEN s.log ELSE '[]'::jsonb END) entry
     WHERE entry ? 'resourceAccount' AND (entry#>>'{resourceAccount,id}' IS DISTINCT FROM a.id::text OR
       entry#>>'{resourceAccount,version}' IS DISTINCT FROM a."resourceScopeVersion"::text)),false)
 AND (jsonb_path_exists(s.log,'$.** ? (@ == $id)',jsonb_build_object('id',p_resource)) OR
      jsonb_path_exists(s.plan,'$.** ? (@ == $id)',jsonb_build_object('id',p_resource)))
)
  );
END;
$$;

-- Inspect only the few pending receipts when a source publishes new reference-bearing data.
-- The exception is deliberately generic: other organizations' source, resource and account
-- identifiers must never be returned to this publisher.
CREATE FUNCTION bitovp_guard_pending_resource_reference() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET row_security=off AS $$
DECLARE
  source_plan jsonb;
  source_log jsonb := NEW."stepLog";
  source_account text;
  source_since timestamp;
BEGIN
  IF TG_TABLE_NAME='LiveChannelRun' THEN
    IF TG_OP='UPDATE' AND NEW."stepLog" IS NOT DISTINCT FROM OLD."stepLog"
      AND NEW."liveChannelId"=OLD."liveChannelId" THEN RETURN NEW; END IF;
    SELECT c.plan, COALESCE(c.plan#>>'{bitmovin,accountId}',c."bitmovinAccountId"::text),c."createdAt"
    INTO source_plan,source_account,source_since FROM public."LiveChannel" c
    WHERE c.id=NEW."liveChannelId" AND c."organizationId"=NEW."organizationId";
  ELSE
    IF TG_OP='UPDATE' AND NEW."stepLog" IS NOT DISTINCT FROM OLD."stepLog"
      AND NEW.plan IS NOT DISTINCT FROM OLD.plan AND NEW."bitmovinAccountId" IS NOT DISTINCT FROM OLD."bitmovinAccountId"
      THEN RETURN NEW; END IF;
    source_plan := NEW.plan;
    source_account := COALESCE(source_plan#>>'{bitmovin,accountId}',NEW."bitmovinAccountId"::text);
    source_since := NEW."createdAt";
  END IF;

  PERFORM 1 FROM public."PlatformSetting" WHERE key='internal.encoding_resource_removal_epoch' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource reservation epoch unavailable'; END IF;
  IF EXISTS (
    SELECT FROM public."EncodingResourceRemoval" r
    LEFT JOIN public."BitmovinAccount" owner_account ON owner_account.id=r."accountId" AND owner_account."organizationId"=r."organizationId"
      AND owner_account."resourceScopeVersion"=r."scopeVersion"
    LEFT JOIN public."BitmovinAccount" new_account ON new_account.id::text=source_account AND new_account."organizationId"=NEW."organizationId"
    WHERE r.state IN ('SENDING','UNKNOWN') AND (
      jsonb_path_exists(source_plan,'$.** ? (@ == $id)',jsonb_build_object('id',r."providerId")) OR
      jsonb_path_exists(source_log, '$.** ? (@ == $id)',jsonb_build_object('id',r."providerId")))
    AND NOT COALESCE(owner_account."tenantOrgId" <> new_account."tenantOrgId"
      AND COALESCE(new_account."resourceScopeSince",new_account."updatedAt") < source_since
      AND NOT EXISTS(SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(source_log)='array' THEN source_log ELSE '[]'::jsonb END) e
        WHERE e ? 'resourceAccount' AND (e#>>'{resourceAccount,id}' IS DISTINCT FROM new_account.id::text OR
          e#>>'{resourceAccount,version}' IS DISTINCT FROM new_account."resourceScopeVersion"::text)),false)
  ) THEN RAISE EXCEPTION 'A referenced provider resource has a pending removal' USING ERRCODE='23514',CONSTRAINT='EncodingResourceRemoval_reference_pending'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bitovp_guard_pending_resource_reference BEFORE INSERT OR UPDATE OF plan,"stepLog","bitmovinAccountId" ON "EncodingJob"
FOR EACH ROW EXECUTE FUNCTION bitovp_guard_pending_resource_reference();
CREATE TRIGGER bitovp_guard_pending_resource_reference BEFORE INSERT OR UPDATE OF plan,"stepLog","bitmovinAccountId" ON "LiveChannel"
FOR EACH ROW EXECUTE FUNCTION bitovp_guard_pending_resource_reference();
CREATE TRIGGER bitovp_guard_pending_resource_reference BEFORE INSERT OR UPDATE OF "stepLog","liveChannelId" ON "LiveChannelRun"
FOR EACH ROW EXECUTE FUNCTION bitovp_guard_pending_resource_reference();

-- An uncertain send must remain verifiable with its original upstream scope. Renames and
-- rekeys for the same explicit upstream organization keep the binding usable.
CREATE FUNCTION bitovp_guard_pending_resource_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET row_security=off AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW."tenantOrgId" IS NOT DISTINCT FROM OLD."tenantOrgId" AND
     (NEW."tenantOrgId" IS NOT NULL OR NEW."encryptedApiKey" IS NOT DISTINCT FROM OLD."encryptedApiKey")
    THEN RETURN NEW; END IF;
  PERFORM 1 FROM public."PlatformSetting" WHERE key='internal.encoding_resource_removal_epoch' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource reservation epoch unavailable'; END IF;
  IF EXISTS (SELECT FROM public."EncodingResourceRemoval" WHERE "accountId"=OLD.id AND state IN ('SENDING','UNKNOWN')) THEN
    RAISE EXCEPTION 'Resolve the pending provider resource removal before changing the original account scope'
      USING ERRCODE='23514', CONSTRAINT='EncodingResourceRemoval_account_pending';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bitovp_guard_pending_resource_account BEFORE DELETE OR UPDATE OF "tenantOrgId","encryptedApiKey" ON "BitmovinAccount"
FOR EACH ROW EXECUTE FUNCTION bitovp_guard_pending_resource_account();

-- Start/retry and a provider deletion serialize on the same source row. A fresh Live airing
-- can start after removal finishes; a VOD retry would resume the already-deleted graph.
CREATE FUNCTION bitovp_guard_resource_resume() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'EncodingJob' THEN
    IF EXISTS(SELECT 1 FROM "EncodingResourceRemoval" r WHERE r."sourceKind"='VOD' AND r."sourceId"=NEW.id AND r.state IN ('SENDING','UNKNOWN','REMOVED'))
       THEN RETURN NULL; END IF;
  ELSIF EXISTS(SELECT 1 FROM "EncodingResourceRemoval" r WHERE r."channelId"=NEW.id AND r.state IN ('SENDING','UNKNOWN'))
       THEN RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bitovp_guard_resource_resume BEFORE UPDATE OF status ON "EncodingJob" FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('QUEUED','RUNNING')) EXECUTE FUNCTION bitovp_guard_resource_resume();
CREATE TRIGGER bitovp_guard_resource_resume BEFORE UPDATE OF status ON "LiveChannel" FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('CREATED','PROVISIONING','RUNNING')) EXECUTE FUNCTION bitovp_guard_resource_resume();
COMMIT;
