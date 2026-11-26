BEGIN;
ALTER TABLE "VodInputPreviewTask" DROP CONSTRAINT "VodInputPreviewTask_kind_check";
ALTER TABLE "VodInputPreviewTask" ADD CONSTRAINT "VodInputPreviewTask_kind_check"
  CHECK ("kind" IN ('PROBE', 'PREVIEW', 'IMAGE_PREPARE'));
COMMIT;
