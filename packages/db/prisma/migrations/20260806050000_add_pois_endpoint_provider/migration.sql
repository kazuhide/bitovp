-- POIS (ESAM) endpoint basic-auth pairs join the vault (P5 PR-3 live
-- long tail). Both halves — username AND password — are vault material
-- (username is PII-ish; KANTAR plan precedent), resolved by the channel
-- worker at START_LIVE_ENCODING only; plans carry poisCredentialId refs.
ALTER TYPE "CredentialProvider" ADD VALUE 'POIS_ENDPOINT';
