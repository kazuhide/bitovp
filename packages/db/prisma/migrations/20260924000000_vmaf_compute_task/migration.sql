CREATE TABLE "VmafComputeTask" (
 "id" UUID NOT NULL,
 "vmafJobId" UUID NOT NULL,
 "targetKey" TEXT NOT NULL,
 "profileId" TEXT NOT NULL,
 "profile" JSONB NOT NULL,
 "providerId" TEXT,
 "state" TEXT NOT NULL DEFAULT 'PREPARING',
 "reservedUsd" DOUBLE PRECISION NOT NULL,
 "stagingKeys" JSONB NOT NULL DEFAULT '[]',
 "receipt" JSONB,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "queueExpiresAt" TIMESTAMP(3) NOT NULL,
 "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "cleanedAt" TIMESTAMP(3),
 "error" TEXT,
 CONSTRAINT "VmafComputeTask_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VmafComputeTask_vmafJobId_targetKey_key" ON "VmafComputeTask"("vmafJobId", "targetKey");
CREATE INDEX "VmafComputeTask_cleanedAt_expiresAt_idx" ON "VmafComputeTask"("cleanedAt", "expiresAt");
CREATE INDEX "VmafComputeTask_profileId_cleanedAt_idx" ON "VmafComputeTask"("profileId", "cleanedAt");
