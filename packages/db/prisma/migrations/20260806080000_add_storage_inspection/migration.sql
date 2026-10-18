-- Storage object INSPECTION (P5 PR-5): an ffprobe read of one object in the
-- customer's bucket, executed by the worker (which owns the ffprobe binary).
-- Bounded by design: the processor reads a capped HEAD and, for a
-- non-faststart MP4, a capped TAIL — never the whole object.
-- Additive: new enum + new table, no changes to existing models.
-- CreateEnum
CREATE TYPE "StorageInspectionStatus" AS ENUM ('PENDING', 'RUNNING', 'FINISHED', 'ERROR');

-- CreateTable
CREATE TABLE "StorageInspection" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "status" "StorageInspectionStatus" NOT NULL DEFAULT 'PENDING',
    "probe" JSONB,
    "bytesRead" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageInspection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorageInspection_createdAt_idx" ON "StorageInspection"("createdAt" DESC);
