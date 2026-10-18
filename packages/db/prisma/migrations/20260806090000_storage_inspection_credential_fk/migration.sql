-- StorageInspection: real FK to Credential + an index matching the actual query.
--
-- Why the FK: `credentialId` was a bare UUID, so inspection rows — which hold
-- customer data (bucket name, object key, probed media metadata) — outlived the
-- credential whose authorization produced them. CASCADE matches
-- StorageLocationPreset, the only other Credential dependent: deleting a
-- credential revokes the access, so the records it produced go with it.
--
-- Orphan sweep first: rows written before this FK existed may point at a
-- credential that has since been deleted, and ADD CONSTRAINT would fail on
-- them. They are exactly the rows the FK is meant to prevent, so dropping them
-- is the intended outcome, not collateral.
DELETE FROM "StorageInspection" si
WHERE NOT EXISTS (
  SELECT 1 FROM "Credential" c WHERE c."id" = si."credentialId"
);

-- CreateIndex
-- Serves the table's only read: latest inspection of one object —
-- findFirst on (credentialId, bucket, objectKey) ordered by createdAt desc.
-- The pre-existing createdAt-only index is kept for the retention prune.
CREATE INDEX "StorageInspection_credentialId_bucket_objectKey_createdAt_idx" ON "StorageInspection"("credentialId", "bucket", "objectKey", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "StorageInspection" ADD CONSTRAINT "StorageInspection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
