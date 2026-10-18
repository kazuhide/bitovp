-- Row #242: feeder ownership is process-local, so a rolling deploy or a second
-- replica loses the push (audit 2026-08-29 live-scheduling HIGH-5).
--
-- The supervisor registry is a `Map` in one process, and the code said so
-- ("Single-worker assumption"). A session recorded WHO could signal its pid
-- (`ownerHost`, migration 20260829170000) but never WHO was supervising it, so:
--
--   * nothing could tell a live push from an abandoned one except the BullMQ
--     job state, which only a worker sharing that queue can classify;
--   * no second worker could take a session over, because there was no token
--     to take;
--   * a superseded worker's late write had nothing to lose against.
--
-- Three columns, no backfill:
--   ownerId         — the worker INSTANCE (host + pid + per-boot nonce) that
--                     is supervising the push. NULL = unclaimed.
--   ownerLeaseAt    — last renewal. NULL = never claimed, which is NOT the
--                     same as "claimed by a dead worker": the takeover sweep
--                     requires a NON-NULL stale lease, so rows written before
--                     this migration and freshly CREATED rows are out of its
--                     scope by construction (the `provisionClaimedAt`
--                     precedent, ledger #216).
--   ownerGeneration — the fencing token, bumped by every claim and takeover.
--                     NOT NULL DEFAULT 0 rather than nullable so the first
--                     compare-and-swap has a value to compare against on
--                     every existing row.
ALTER TABLE "FeederSession" ADD COLUMN "ownerId" TEXT,
ADD COLUMN     "ownerLeaseAt" TIMESTAMP(3),
ADD COLUMN     "ownerGeneration" INTEGER NOT NULL DEFAULT 0;

-- The takeover sweep's population: non-terminal rows whose lease went stale.
-- Status leads because it is the selective half — terminal rows are the
-- overwhelming majority of this table and never take part.
CREATE INDEX "FeederSession_status_ownerLeaseAt_idx" ON "FeederSession"("status", "ownerLeaseAt");
