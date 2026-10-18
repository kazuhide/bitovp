-- Fence a slow verification producer from creating/submitting paid-resource
-- intents or sealing after explicit restart recovery has begun. The generation
-- is captured at reservation and compared by every producer intent transaction
-- and the final SEALED/INCOMPLETE compare-and-swap.
--
-- ROLLOUT ORDER — MIXED-VERSION VERIFICATION EXECUTION IS FORBIDDEN. A
-- pre-fence verifier ignores these columns and can submit paid resources or
-- overwrite recovery authority after the migration:
--   1. close the verify run/recover entry points;
--   2. drain and STOP every pre-fence verifier process, including detached
--      CLIs/host workers, and read back the running image/process inventory;
--   3. apply this migration while those writers remain stopped;
--   4. require all three columns below to exist, recoveryGeneration to be NOT
--      NULL/default 0, and prisma migrate status/schema diff to be clean;
--   5. start only fence-aware images, then reopen verify run/recover.
-- There is no supported rolling handoff. If every old verifier cannot be
-- proved stopped, ABORT before migrate deploy.
ALTER TABLE "VerificationRun"
ADD COLUMN "recoveryOwner" TEXT,
ADD COLUMN "recoveryLeaseUntil" TIMESTAMP(3),
ADD COLUMN "recoveryGeneration" INTEGER NOT NULL DEFAULT 0;
