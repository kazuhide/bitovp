-- Existing credential rows have no trustworthy record of earlier provider scopes.
ALTER TABLE "BitmovinAccount" ADD COLUMN "resetPriorTenantScopes" TEXT[] NOT NULL DEFAULT ARRAY['']::text[];
ALTER TABLE "BitmovinAccount" ALTER COLUMN "resetPriorTenantScopes" SET DEFAULT ARRAY[]::text[];

CREATE FUNCTION bitovp_keep_reset_account_scopes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."resetPriorTenantScopes" := OLD."resetPriorTenantScopes";
  IF OLD."tenantOrgId" IS DISTINCT FROM NEW."tenantOrgId" AND
     NOT (coalesce(OLD."tenantOrgId", '') = ANY(NEW."resetPriorTenantScopes")) THEN
    NEW."resetPriorTenantScopes" := array_append(NEW."resetPriorTenantScopes", coalesce(OLD."tenantOrgId", ''));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER keep_reset_account_scopes BEFORE UPDATE OF "tenantOrgId", "resetPriorTenantScopes" ON "BitmovinAccount"
FOR EACH ROW EXECUTE FUNCTION bitovp_keep_reset_account_scopes();

-- Normal ownership writes share this tenant key. Verification cleanup takes it
-- exclusively only after SDK discovery, for its final check and one mutation.
CREATE FUNCTION bitovp_lock_reset_owner_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-ownership/' || OLD."organizationId"::text, 0));
    RETURN OLD;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('bitovp/reset-ownership/' || NEW."organizationId"::text, 0));
  RETURN NEW;
END;
$$;
CREATE TRIGGER reset_owner_write BEFORE INSERT OR DELETE OR UPDATE OF "id", "bitmovinEncodingId", "bitmovinAccountId", "plan", "stepLog", "verificationKey" ON "EncodingJob"
FOR EACH ROW EXECUTE FUNCTION bitovp_lock_reset_owner_write();
CREATE TRIGGER reset_owner_write BEFORE INSERT OR DELETE OR UPDATE OF "id", "bitmovinEncodingId", "bitmovinAccountId", "plan", "stepLog", "error", "verificationKey", "resetOrphanEncoderEvidence" ON "LiveChannel"
FOR EACH ROW EXECUTE FUNCTION bitovp_lock_reset_owner_write();
CREATE TRIGGER reset_owner_write BEFORE INSERT OR DELETE OR UPDATE OF "liveChannelId", "seq", "bitmovinEncodingId", "previousProviderEncodingIds", "archivedRtmpAttempt", "stepLog", "error", "rtmpRetirementEvidence", "aisaAnalysisId" ON "LiveChannelRun"
FOR EACH ROW EXECUTE FUNCTION bitovp_lock_reset_owner_write();
CREATE TRIGGER reset_owner_write BEFORE INSERT OR DELETE OR UPDATE OF "liveChannelId", "liveChannelRunId", "action", "providerEncodingId", "stopSendEncodingIds", "legacyUnsentStopIds", "stopOutcomeEvidence", "stopProtocolVersion", "failure" ON "LiveEffectClaim"
FOR EACH ROW EXECUTE FUNCTION bitovp_lock_reset_owner_write();
CREATE TRIGGER reset_owner_write BEFORE INSERT OR DELETE OR UPDATE OF "tenantOrgId" ON "BitmovinAccount"
FOR EACH ROW EXECUTE FUNCTION bitovp_lock_reset_owner_write();
