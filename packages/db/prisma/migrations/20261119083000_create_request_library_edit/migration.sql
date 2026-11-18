ALTER TABLE "CreateRequest"
  DROP CONSTRAINT "CreateRequest_kind_check",
  ADD CONSTRAINT "CreateRequest_kind_check"
    CHECK ("kind" IN ('VOD_JOB', 'LIVE_CHANNEL', 'LIBRARY_EDIT'));
