ALTER TABLE "VmafComputeTask" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "progress" JSONB;
DROP INDEX "VmafComputeTask_vmafJobId_targetKey_key";
CREATE UNIQUE INDEX "VmafComputeTask_vmafJobId_targetKey_attempt_key" ON "VmafComputeTask"("vmafJobId", "targetKey", "attempt");
