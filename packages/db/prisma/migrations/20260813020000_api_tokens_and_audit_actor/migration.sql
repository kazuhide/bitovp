-- Ledger #81 (API-TOKENS-DESIGN §2) + the AuditLog.actor column SHARED with
-- MULTI-USER-DESIGN (#32) — both designs name this migration; it lands once.

ALTER TABLE "AuditLog" ADD COLUMN "actor" TEXT;

CREATE TABLE "ApiToken" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OPERATOR',
    "createdBy" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiToken_prefix_key" ON "ApiToken"("prefix");
