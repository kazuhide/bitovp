-- Ledger #83 PR1: live alerting — rules + open/resolve event lifecycle.

CREATE TYPE "AlertSeverity" AS ENUM ('WARN', 'CRIT');

CREATE TABLE "AlertRule" (
    "id" UUID NOT NULL,
    "liveChannelId" UUID,
    "metric" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "windowPolls" INTEGER NOT NULL DEFAULT 2,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARN',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlertRule_liveChannelId_idx" ON "AlertRule"("liveChannelId");

ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_liveChannelId_fkey"
    FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AlertEvent" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "liveChannelId" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "context" JSONB NOT NULL,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlertEvent_liveChannelId_openedAt_idx"
    ON "AlertEvent"("liveChannelId", "openedAt" DESC);

-- At most one OPEN event per (rule, channel). Prisma cannot express a
-- partial unique index declaratively (design §2; the #14 triggerKey
-- precedent) — the DB, not a check-then-act read, enforces open-dedup.
CREATE UNIQUE INDEX "AlertEvent_open_unique"
    ON "AlertEvent"("ruleId", "liveChannelId")
    WHERE "resolvedAt" IS NULL;

ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_liveChannelId_fkey"
    FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
