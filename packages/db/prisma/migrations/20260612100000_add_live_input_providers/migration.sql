-- SRT passphrases and Zixi password/decryption keys join the vault
-- (P3 live lifecycle batch; resolved by the channel worker at execution
-- only — DRM_CENC precedent).
ALTER TYPE "CredentialProvider" ADD VALUE 'SRT_PASSPHRASE';
ALTER TYPE "CredentialProvider" ADD VALUE 'ZIXI';
