-- review-293 I3: the run-health route filters LiveHeartbeat by run id every
-- page poll; the only existing index is (liveChannelId, at).
CREATE INDEX "LiveHeartbeat_liveChannelRunId_at_idx" ON "LiveHeartbeat"("liveChannelRunId", "at");
