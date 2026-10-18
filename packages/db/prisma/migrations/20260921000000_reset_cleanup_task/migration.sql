CREATE TABLE "ResetCleanupTask" (
    "id" UUID NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "entityKeys" TEXT[] NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResetCleanupTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResetCleanupTask_entityKeys_idx" ON "ResetCleanupTask" USING GIN ("entityKeys");
CREATE INDEX "ResetCleanupTask_settledAt_nextAttemptAt_idx" ON "ResetCleanupTask"("settledAt", "nextAttemptAt");
