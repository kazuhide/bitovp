-- Additive: legacy rows retain LOOP and no dispatch/completion claim.
-- Deploy the new Web/Worker together before admitting ONCE inputs; an older
-- worker does not understand single-pass playback and must never consume one.
ALTER TABLE "FeederSession"
  ADD COLUMN "playbackMode" TEXT NOT NULL DEFAULT 'LOOP',
  ADD COLUMN "playbackDispatchedAt" TIMESTAMP(3),
  ADD COLUMN "playbackReceipt" JSONB,
  ADD CONSTRAINT "FeederSession_playbackMode_check"
    CHECK ("playbackMode" IN ('LOOP', 'ONCE'));
