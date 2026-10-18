ALTER TYPE "LiveEffectClaimState" ADD VALUE 'RESOLVED';

ALTER TABLE "LiveEffectClaim"
ADD COLUMN "requestSha256" TEXT,
ADD COLUMN "providerResultId" TEXT;
