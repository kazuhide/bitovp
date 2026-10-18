-- AlterEnum
ALTER TYPE "PresetKind" ADD VALUE 'LIVE_PLAN';

-- AlterTable
ALTER TABLE "EncodingJob" ADD COLUMN     "presetId" UUID,
ADD COLUMN     "presetRevision" INTEGER;

-- AlterTable
ALTER TABLE "LiveChannel" ADD COLUMN     "presetId" UUID,
ADD COLUMN     "presetRevision" INTEGER;

-- AlterTable
ALTER TABLE "Preset" ADD COLUMN     "launchDefaults" JSONB,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "EncodingJob_presetId_idx" ON "EncodingJob"("presetId");

-- CreateIndex
CREATE INDEX "LiveChannel_presetId_idx" ON "LiveChannel"("presetId");

-- AddForeignKey
ALTER TABLE "EncodingJob" ADD CONSTRAINT "EncodingJob_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "Preset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveChannel" ADD CONSTRAINT "LiveChannel_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "Preset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
