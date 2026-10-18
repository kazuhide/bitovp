-- live-to-VOD record (P5 PR-3). Bitmovin has no live-to-VOD API — this
-- column is OUR record of the workflow (default VOD manifests generated
-- over the stopped channel's own encoding with manifestGenerator LEGACY).
-- Additive and nullable: existing channels read as "never run".
-- AlterTable
ALTER TABLE "LiveChannel" ADD COLUMN     "liveToVod" JSONB;
