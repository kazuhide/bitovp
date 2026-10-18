-- Additive only: existing environment profiles and task snapshots remain valid.
CREATE TABLE "VmafComputeCredential" (
 "id" UUID NOT NULL,
 "label" TEXT NOT NULL,
 "provider" TEXT NOT NULL,
 "encryptedSecret" TEXT NOT NULL,
 "disabledAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "VmafComputeCredential_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "VmafExecutionProfile" (
 "id" TEXT NOT NULL,
 "label" TEXT NOT NULL,
 "config" JSONB NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1,
 "enabled" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "VmafExecutionProfile_pkey" PRIMARY KEY ("id")
);
