-- CreateTable
CREATE TABLE "LiveHeartbeat" (
    "id" UUID NOT NULL,
    "liveChannelId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,
    "deltas" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveHeartbeat_liveChannelId_at_idx" ON "LiveHeartbeat"("liveChannelId", "at");

-- AddForeignKey
ALTER TABLE "LiveHeartbeat" ADD CONSTRAINT "LiveHeartbeat_liveChannelId_fkey" FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
