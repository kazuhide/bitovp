-- Release evidence has one authority: a SEALED VerificationRun row stores the
-- exact report bytes covered by its digest and HMAC. Files are recoverable
-- exports and can never become green before this DB update succeeds.
ALTER TABLE "VerificationRun"
    ADD COLUMN "reportJson" TEXT,
    ADD COLUMN "reportMarkdown" TEXT;
