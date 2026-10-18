-- Ledger #199 slice 2: what bytes each VMAF result actually scored — the
-- provider's version identity and a streaming SHA-256 of BOTH sides, captured
-- at download time. Nullable: rows scored before this column carry nothing,
-- and nothing must pretend otherwise.
ALTER TABLE "VmafResult" ADD COLUMN "provenance" JSONB;
