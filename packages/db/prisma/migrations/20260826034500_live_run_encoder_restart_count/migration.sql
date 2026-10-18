-- A run ordinal and capped audit timeline cannot prove that no provider
-- restart call occurred. Persist a monotonic, run-scoped count; the worker
-- increments it before each SDK restart attempt so failures stay visible.
ALTER TABLE "LiveChannelRun"
ADD COLUMN "encoderRestartCount" INTEGER NOT NULL DEFAULT 0;
