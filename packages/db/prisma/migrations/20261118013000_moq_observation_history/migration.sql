ALTER TABLE "LiveChannelRun"
  ADD COLUMN "moqObservations" JSONB NOT NULL DEFAULT '{"version":1,"sessions":[]}';

-- Existing tenant RLS and run ownership apply to the additive private document.
ALTER TABLE "LiveChannelRun" ADD CONSTRAINT "LiveChannelRun_moqObservations_bound"
  CHECK (
    jsonb_typeof("moqObservations") = 'object'
    AND COALESCE("moqObservations"->>'version' = '1', false)
    AND COALESCE(jsonb_typeof("moqObservations"->'sessions') = 'array', false)
    AND jsonb_array_length("moqObservations"->'sessions') <= 5
    AND octet_length("moqObservations"::text) <= 1048576
  );
