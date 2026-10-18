-- Row #313: the Bitmovin encoding id the provider was seen to report TERMINAL for
-- (a confirmed cancel/stop, or Settings → Reset's "check with Bitmovin"). The
-- reset's unstopped-encoder predicate ignores a row only while this equals its
-- bitmovinEncodingId, so a re-pointed row blocks again by construction.
-- AlterTable
ALTER TABLE "EncodingJob" ADD COLUMN     "encoderStoppedConfirmedFor" TEXT;

-- AlterTable
ALTER TABLE "LiveChannel" ADD COLUMN     "encoderStoppedConfirmedFor" TEXT;

-- AlterTable
ALTER TABLE "LiveChannelRun" ADD COLUMN     "encoderStoppedConfirmedFor" TEXT;
