BEGIN;
ALTER TABLE "LibraryEvidenceReceipt"
 DROP CONSTRAINT "LibraryEvidenceReceipt_kind_check";
ALTER TABLE "LibraryEvidenceReceipt"
 ADD CONSTRAINT "LibraryEvidenceReceipt_kind_check"
 CHECK ("kind" IN (
  'INPUT_CAPTURE','ANALYSIS_CAPTURE','NORMALIZATION_CAPTURE',
  'EDITOR_ATTESTATION','STORY_GRAPH_V1'
 ));
COMMIT;
