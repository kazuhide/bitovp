-- CreateEnum
CREATE TYPE "CredentialProvider" AS ENUM ('AWS_S3', 'AWS_S3_ROLE_BASED', 'AKAMAI_OBJECT_STORAGE', 'OCI_OBJECT_STORAGE', 'GENERIC_S3', 'GCS_HMAC', 'GCS_SERVICE_ACCOUNT', 'AZURE_BLOB');

-- CreateEnum
CREATE TYPE "StorageRole" AS ENUM ('INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "EncodingJobStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'FINISHED', 'ERROR', 'CANCELED');

-- CreateEnum
CREATE TYPE "ManifestType" AS ENUM ('HLS', 'DASH');

-- CreateEnum
CREATE TYPE "ManifestMode" AS ENUM ('DEFAULT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ManifestGeneration" AS ENUM ('JUST_IN_TIME', 'POST_ENCODING');

-- CreateEnum
CREATE TYPE "ManifestJobStatus" AS ENUM ('PENDING', 'RUNNING', 'FINISHED', 'ERROR');

-- CreateEnum
CREATE TYPE "LiveChannelState" AS ENUM ('CREATED', 'QUEUED', 'RUNNING', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "FeedState" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'ERROR');

-- CreateEnum
CREATE TYPE "VmafMode" AS ENUM ('VOD', 'LIVE');

-- CreateEnum
CREATE TYPE "VmafStatus" AS ENUM ('PENDING', 'RUNNING', 'FINISHED', 'ERROR');

-- CreateEnum
CREATE TYPE "PresetKind" AS ENUM ('FULL_PLAN', 'LADDER', 'CODEC_CONFIG', 'FILTER_CHAIN', 'DRM_SET', 'MANIFEST_LAYOUT');

-- CreateTable
CREATE TABLE "Credential" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "provider" "CredentialProvider" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "encryptedSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BitmovinAccount" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "tenantOrgId" TEXT,
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BitmovinAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageLocationPreset" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "role" "StorageRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageLocationPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncodingJob" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "EncodingJobStatus" NOT NULL DEFAULT 'DRAFT',
    "plan" JSONB NOT NULL,
    "stepLog" JSONB NOT NULL DEFAULT '[]',
    "bitmovinEncodingId" TEXT,
    "bitmovinAccountId" UUID,
    "snapshots" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EncodingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManifestJob" (
    "id" UUID NOT NULL,
    "encodingJobId" UUID NOT NULL,
    "type" "ManifestType" NOT NULL,
    "mode" "ManifestMode" NOT NULL,
    "generation" "ManifestGeneration" NOT NULL,
    "status" "ManifestJobStatus" NOT NULL DEFAULT 'PENDING',
    "bitmovinManifestId" TEXT,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManifestJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveChannel" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "state" "LiveChannelState" NOT NULL DEFAULT 'CREATED',
    "plan" JSONB NOT NULL,
    "bitmovinEncodingId" TEXT,
    "bitmovinAccountId" UUID,
    "ingest" JSONB,
    "dvr" JSONB,
    "stateTimeline" JSONB NOT NULL DEFAULT '[]',
    "lastHeartbeat" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PseudoLiveFeed" (
    "id" UUID NOT NULL,
    "liveChannelId" UUID,
    "sourceObject" JSONB NOT NULL,
    "ffmpegOptions" JSONB NOT NULL DEFAULT '{}',
    "state" "FeedState" NOT NULL DEFAULT 'STOPPED',
    "loopLog" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PseudoLiveFeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmafJob" (
    "id" UUID NOT NULL,
    "encodingJobId" UUID,
    "mode" "VmafMode" NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'vmaf_v0.6.1',
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" "VmafStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VmafJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmafResult" (
    "id" UUID NOT NULL,
    "vmafJobId" UUID NOT NULL,
    "renditionRef" JSONB NOT NULL,
    "pooled" JSONB NOT NULL,
    "frames" JSONB,
    "framesGzip" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VmafResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Preset" (
    "id" UUID NOT NULL,
    "kind" "PresetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'bitmovin',
    "eventType" TEXT,
    "externalEventId" TEXT,
    "raw" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bitmovinAccountId" UUID,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "request" JSONB,
    "response" JSONB,
    "error" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Credential_provider_idx" ON "Credential"("provider");

-- CreateIndex
CREATE INDEX "StorageLocationPreset_credentialId_idx" ON "StorageLocationPreset"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "EncodingJob_bitmovinEncodingId_key" ON "EncodingJob"("bitmovinEncodingId");

-- CreateIndex
CREATE INDEX "EncodingJob_status_createdAt_idx" ON "EncodingJob"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EncodingJob_createdAt_idx" ON "EncodingJob"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "EncodingJob_bitmovinAccountId_idx" ON "EncodingJob"("bitmovinAccountId");

-- CreateIndex
CREATE INDEX "ManifestJob_encodingJobId_idx" ON "ManifestJob"("encodingJobId");

-- CreateIndex
CREATE INDEX "ManifestJob_bitmovinManifestId_idx" ON "ManifestJob"("bitmovinManifestId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveChannel_bitmovinEncodingId_key" ON "LiveChannel"("bitmovinEncodingId");

-- CreateIndex
CREATE INDEX "LiveChannel_bitmovinAccountId_idx" ON "LiveChannel"("bitmovinAccountId");

-- CreateIndex
CREATE INDEX "PseudoLiveFeed_liveChannelId_idx" ON "PseudoLiveFeed"("liveChannelId");

-- CreateIndex
CREATE INDEX "VmafJob_encodingJobId_idx" ON "VmafJob"("encodingJobId");

-- CreateIndex
CREATE INDEX "VmafResult_vmafJobId_idx" ON "VmafResult"("vmafJobId");

-- CreateIndex
CREATE UNIQUE INDEX "Preset_kind_name_key" ON "Preset"("kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_externalEventId_key" ON "WebhookEvent"("externalEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_eventType_idx" ON "WebhookEvent"("eventType");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_bitmovinAccountId_idx" ON "AuditLog"("bitmovinAccountId");

-- AddForeignKey
ALTER TABLE "StorageLocationPreset" ADD CONSTRAINT "StorageLocationPreset_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncodingJob" ADD CONSTRAINT "EncodingJob_bitmovinAccountId_fkey" FOREIGN KEY ("bitmovinAccountId") REFERENCES "BitmovinAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestJob" ADD CONSTRAINT "ManifestJob_encodingJobId_fkey" FOREIGN KEY ("encodingJobId") REFERENCES "EncodingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveChannel" ADD CONSTRAINT "LiveChannel_bitmovinAccountId_fkey" FOREIGN KEY ("bitmovinAccountId") REFERENCES "BitmovinAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PseudoLiveFeed" ADD CONSTRAINT "PseudoLiveFeed_liveChannelId_fkey" FOREIGN KEY ("liveChannelId") REFERENCES "LiveChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VmafJob" ADD CONSTRAINT "VmafJob_encodingJobId_fkey" FOREIGN KEY ("encodingJobId") REFERENCES "EncodingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VmafResult" ADD CONSTRAINT "VmafResult_vmafJobId_fkey" FOREIGN KEY ("vmafJobId") REFERENCES "VmafJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_bitmovinAccountId_fkey" FOREIGN KEY ("bitmovinAccountId") REFERENCES "BitmovinAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
