-- Expand the existing task kind check before a new Web can enqueue preparations.
-- Keep all old kinds and the existing tenant/intent/status constraints unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "VodInputPreviewTask" DROP CONSTRAINT "VodInputPreviewTask_kind_check";
ALTER TABLE "VodInputPreviewTask" ADD CONSTRAINT "VodInputPreviewTask_kind_check"
  CHECK ("kind" IN ('PROBE', 'PREVIEW', 'IMAGE_PREPARE', 'TIMELINE_PREPARE'));
COMMIT;
