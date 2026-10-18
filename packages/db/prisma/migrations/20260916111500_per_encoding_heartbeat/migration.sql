ALTER TABLE "WebhookRegistration" ADD COLUMN "configuration" JSONB;

-- Existing airings remain on their account hook; only later runs opt into AUTO.
INSERT INTO "AppSetting" ("key", "value", "updatedAt")
VALUES ('live:heartbeat-per-encoding-rollout', jsonb_build_object('enabledAt', CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
