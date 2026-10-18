-- Row #314: a daily snapshot of Bitmovin encoding statistics per account and kind.
-- CreateEnum
CREATE TYPE "UsageStatisticKind" AS ENUM ('VOD', 'LIVE');

-- CreateTable
CREATE TABLE "UsageDailyStatistic" (
    "id" UUID NOT NULL,
    "bitmovinAccountId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "UsageStatisticKind" NOT NULL,
    "bytesEncoded" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timeEncodedS" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bytesEgress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "billableMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageDailyStatistic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageDailyStatistic_date_idx" ON "UsageDailyStatistic"("date");

-- CreateIndex
CREATE UNIQUE INDEX "UsageDailyStatistic_bitmovinAccountId_date_kind_key" ON "UsageDailyStatistic"("bitmovinAccountId", "date", "kind");

-- AddForeignKey
ALTER TABLE "UsageDailyStatistic" ADD CONSTRAINT "UsageDailyStatistic_bitmovinAccountId_fkey" FOREIGN KEY ("bitmovinAccountId") REFERENCES "BitmovinAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row #314 (rev426 R1): the sweep's per-(account, kind) watermark.
-- CreateTable
CREATE TABLE "UsageSweepCursor" (
    "id" UUID NOT NULL,
    "bitmovinAccountId" UUID NOT NULL,
    "kind" "UsageStatisticKind" NOT NULL,
    "sweptThrough" DATE NOT NULL,
    "sweptAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageSweepCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageSweepCursor_bitmovinAccountId_kind_key" ON "UsageSweepCursor"("bitmovinAccountId", "kind");

-- AddForeignKey
ALTER TABLE "UsageSweepCursor" ADD CONSTRAINT "UsageSweepCursor_bitmovinAccountId_fkey" FOREIGN KEY ("bitmovinAccountId") REFERENCES "BitmovinAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
