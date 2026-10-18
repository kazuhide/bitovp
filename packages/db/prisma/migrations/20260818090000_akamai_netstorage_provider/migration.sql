-- Ledger #138: Akamai NetStorage as an encoding input and output.
--
-- Additive only. Postgres cannot remove an enum value, so this is one-way by
-- construction; nothing is renamed and no row is rewritten, which is why it
-- needs no data backfill and no down-migration story beyond "leave the value".
--
-- Distinct from AKAMAI_OBJECT_STORAGE, already present: that is the Linode
-- S3-compatible service reached as GENERIC_S3 (C10). Same vendor, different
-- protocol, different credential shape (key pair vs upload account).
ALTER TYPE "CredentialProvider" ADD VALUE IF NOT EXISTS 'AKAMAI_NETSTORAGE';
