-- QC gate orchestration (ledger #86 PR2).
-- Two new EncodingJob states: AWAITING_QC (encoding done, deferred manifest
-- group parked on the QC verdict) and QC_FAILED (gate failed / measurement
-- failed — deliberately not ERROR). Postgres 12+ allows ADD VALUE inside a
-- transaction as long as the same transaction does not USE the value; this
-- migration only adds.
ALTER TYPE "EncodingJobStatus" ADD VALUE 'AWAITING_QC';
ALTER TYPE "EncodingJobStatus" ADD VALUE 'QC_FAILED';

-- Verdict columns, both nullable and additive: gateVerdict on the measurement
-- row (written atomically with FINISHED), qcVerdict denormalized onto the job
-- row for the list view (same writer, same transaction).
ALTER TABLE "VmafJob" ADD COLUMN "gateVerdict" JSONB;
ALTER TABLE "EncodingJob" ADD COLUMN "qcVerdict" JSONB;
