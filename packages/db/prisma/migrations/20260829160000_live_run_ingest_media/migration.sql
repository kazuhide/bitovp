-- AlterTable
ALTER TABLE "LiveChannelRun" ADD COLUMN     "ingestMedia" JSONB,
ADD COLUMN     "ingestMediaRecordedAt" TIMESTAMP(3);
