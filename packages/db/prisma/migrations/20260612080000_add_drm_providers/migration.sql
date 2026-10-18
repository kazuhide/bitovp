-- DRM content keys and NexGuard licenses join the vault (P2 DRM batch).
ALTER TYPE "CredentialProvider" ADD VALUE 'DRM_CENC';
ALTER TYPE "CredentialProvider" ADD VALUE 'NEXGUARD';
