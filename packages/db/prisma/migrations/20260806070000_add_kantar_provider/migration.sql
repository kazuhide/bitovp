-- Kantar audio-watermarking service login joins the vault (P5 PR-4). Both
-- halves — login AND password — are vault material: the SDK sends them in the
-- KantarWatermark body, so the plan carries only a credentialId and the
-- orchestrator resolves the pair at encoding-create time.
ALTER TYPE "CredentialProvider" ADD VALUE 'KANTAR';
