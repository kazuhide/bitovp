-- A live run keeps a heartbeat SUMMARY once it ends, so the run outlives its
-- per-poll LiveHeartbeat rows (retention prunes those after 7 days). Both
-- columns are additive and nullable: existing rows are not backfilled — the
-- sweep's summarizer fills every ended run that still has rows, and a run
-- whose rows were already pruned is summarized as "rows pruned" rather than
-- invented. `heartbeatSummaryAt` is the write-once lock (a plain IS NULL, the
-- `ingestMediaRecordedAt` precedent); a revive clears it with `endedAt`.
ALTER TABLE "LiveChannelRun"
    ADD COLUMN "heartbeatSummary" JSONB,
    ADD COLUMN "heartbeatSummaryAt" TIMESTAMP(3);
