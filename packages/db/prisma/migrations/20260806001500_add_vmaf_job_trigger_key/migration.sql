-- AlterTable
ALTER TABLE "VmafJob" ADD COLUMN     "triggerKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "VmafJob_triggerKey_key" ON "VmafJob"("triggerKey");
