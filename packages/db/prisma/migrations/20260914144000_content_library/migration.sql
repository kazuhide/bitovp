-- CreateTable
CREATE TABLE "LibrarySource" (
    "id" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "jobId" UUID,
    "originalJobId" UUID NOT NULL,
    "encodingId" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "locales" TEXT[],
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibrarySource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneAnalysisRevision" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "rawHash" TEXT NOT NULL,
    "providerVersion" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "document" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneAnalysisRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Content" (
    "id" UUID NOT NULL,
    "registrationKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[],
    "locale" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentRevision" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "sourceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[],
    "locale" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LibrarySource_sourceKey_key" ON "LibrarySource"("sourceKey");

-- CreateIndex
CREATE INDEX "LibrarySource_state_availableAt_idx" ON "LibrarySource"("state", "availableAt");

-- CreateIndex
CREATE INDEX "LibrarySource_jobId_idx" ON "LibrarySource"("jobId");

-- CreateIndex
CREATE INDEX "LibrarySource_originalJobId_idx" ON "LibrarySource"("originalJobId");

-- CreateIndex
CREATE INDEX "SceneAnalysisRevision_sourceId_locale_createdAt_idx" ON "SceneAnalysisRevision"("sourceId", "locale", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SceneAnalysisRevision_sourceId_locale_rawHash_key" ON "SceneAnalysisRevision"("sourceId", "locale", "rawHash");

-- CreateIndex
CREATE UNIQUE INDEX "Content_registrationKey_key" ON "Content"("registrationKey");

-- CreateIndex
CREATE INDEX "Content_archived_updatedAt_idx" ON "Content"("archived", "updatedAt");

-- CreateIndex
CREATE INDEX "ContentRevision_sourceId_idx" ON "ContentRevision"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentRevision_contentId_revision_key" ON "ContentRevision"("contentId", "revision");

-- AddForeignKey
ALTER TABLE "LibrarySource" ADD CONSTRAINT "LibrarySource_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "EncodingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneAnalysisRevision" ADD CONSTRAINT "SceneAnalysisRevision_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LibrarySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRevision" ADD CONSTRAINT "ContentRevision_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRevision" ADD CONSTRAINT "ContentRevision_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LibrarySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
