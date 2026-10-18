-- Override-and-deliver (ledger #86 PR4): the audited "deliver anyway" flag.
-- Additive nullable column; the override route writes it inside its atomic
-- QC_FAILED -> QUEUED claim so flag and resume can never disagree.
ALTER TABLE "EncodingJob" ADD COLUMN "qcOverriddenAt" TIMESTAMP(3);
