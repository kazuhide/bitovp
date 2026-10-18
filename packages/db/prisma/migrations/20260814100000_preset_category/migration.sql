-- Delivery presets (ledger #82): gallery grouping + spec metadata for
-- imported delivery specs. Both additive nullable; `body` deliberately stays
-- a bare EncodingPlan (the wizard's userPreset load parses it as the plan).
ALTER TABLE "Preset" ADD COLUMN "category" TEXT;
ALTER TABLE "Preset" ADD COLUMN "spec" JSONB;
