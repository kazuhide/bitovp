-- Ledger #131: app-wide operator settings, one row per key. No seed row: an
-- absent key means "every flag at its core-side default" (QC/VMAF OFF), so a
-- fresh install and a deleted row are the same state.
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
