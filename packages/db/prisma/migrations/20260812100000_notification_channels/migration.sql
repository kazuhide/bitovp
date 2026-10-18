-- Ledger #88 PR1 (WEBHOOK-DISPATCH-DESIGN §3): outbound notification
-- channels + event rules. The webhook URL is vault material — the channel
-- row carries only the Credential reference (provider NOTIFICATION_WEBHOOK).

ALTER TYPE "CredentialProvider" ADD VALUE 'NOTIFICATION_WEBHOOK';

CREATE TABLE "NotificationChannel" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "credentialId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationRule" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "events" TEXT[],
    "filter" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationChannel_credentialId_idx" ON "NotificationChannel"("credentialId");

CREATE INDEX "NotificationRule_channelId_idx" ON "NotificationRule"("channelId");

ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "NotificationChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
