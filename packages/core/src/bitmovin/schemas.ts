import { z } from "zod";
import { rateCardSchema } from "../live/cost";

/**
 * Bitmovin account settings (REQUIREMENTS §3.3). Region/version values are
 * deliberately open strings with curated suggestions — the SDK enum churns
 * weekly and the API is the validator of record (API-parity rule).
 */

export const ENCODER_VERSION_PRESETS = ["STABLE", "BETA"] as const;

/**
 * Full CloudRegion list verified against @bitmovin/api-sdk 1.284.0 (names ==
 * wire values for this enum). AUTO first,
 * then provider groups in SDK order. Regenerate from the SDK on bumps.
 */
export const BITMOVIN_CLOUD_REGIONS = [
	"AUTO",
	"AWS_US_EAST_1",
	"AWS_US_EAST_2",
	"AWS_US_WEST_1",
	"AWS_US_WEST_2",
	"AWS_EU_WEST_1",
	"AWS_EU_CENTRAL_1",
	"AWS_AP_SOUTHEAST_1",
	"AWS_AP_SOUTHEAST_2",
	"AWS_AP_NORTHEAST_1",
	"AWS_AP_NORTHEAST_2",
	"AWS_AP_SOUTH_1",
	"AWS_SA_EAST_1",
	"AWS_EU_WEST_2",
	"AWS_EU_WEST_3",
	"AWS_CA_CENTRAL_1",
	"AWS_EU_NORTH_1",
	"GOOGLE_US_CENTRAL_1",
	"GOOGLE_US_EAST_1",
	"GOOGLE_ASIA_EAST_1",
	"GOOGLE_EUROPE_WEST_1",
	"GOOGLE_US_WEST_1",
	"GOOGLE_ASIA_EAST_2",
	"GOOGLE_ASIA_NORTHEAST_1",
	"GOOGLE_ASIA_SOUTH_1",
	"GOOGLE_ASIA_SOUTHEAST_1",
	"GOOGLE_AUSTRALIA_SOUTHEAST_1",
	"GOOGLE_EUROPE_NORTH_1",
	"GOOGLE_EUROPE_WEST_2",
	"GOOGLE_EUROPE_WEST_3",
	"GOOGLE_EUROPE_WEST_4",
	"GOOGLE_NORTHAMERICA_NORTHEAST_1",
	"GOOGLE_SOUTHAMERICA_EAST_1",
	"GOOGLE_US_EAST_4",
	"GOOGLE_US_WEST_2",
	"GOOGLE_ME_CENTRAL_2",
	"AZURE_ASIA_EAST",
	"AZURE_ASIA_SOUTHEAST",
	"AZURE_AUSTRALIA_EAST",
	"AZURE_AUSTRALIA_SOUTHEAST",
	"AZURE_BRAZIL_SOUTH",
	"AZURE_CANADA_CENTRAL",
	"AZURE_EUROPE_NORTH",
	"AZURE_EUROPE_WEST",
	"AZURE_FRANCE_CENTRAL",
	"AZURE_GERMANY_WESTCENTRAL",
	"AZURE_INDIA_CENTRAL",
	"AZURE_INDIA_SOUTH",
	"AZURE_JAPAN_EAST",
	"AZURE_JAPAN_WEST",
	"AZURE_KOREA_CENTRAL",
	"AZURE_UAE_NORTH",
	"AZURE_US_CENTRAL",
	"AZURE_US_EAST",
	"AZURE_US_EAST2",
	"AZURE_US_WEST",
	"AZURE_US_WEST2",
	"AZURE_US_SOUTH_CENTRAL",
	"AZURE_US_NORTH_CENTRAL",
	"AZURE_UK_SOUTH",
	"AKAMAI_AU_MEL",
	"AKAMAI_BR_GRU",
	"AKAMAI_ES_MAD",
	"AKAMAI_FR_PAR",
	"AKAMAI_ID_CGK",
	"AKAMAI_IN_MAA",
	"AKAMAI_IT_MIL",
	"AKAMAI_JP_OSA",
	"AKAMAI_NL_AMS",
	"AKAMAI_SE_STO",
	"AKAMAI_US_LAX",
	"AKAMAI_US_MIA",
	"AKAMAI_US_ORD",
	"AKAMAI_US_SEA",
	"OCI_EU_FRANKFURT_1",
	"OCI_US_ASHBURN_1",
	"NORTH_AMERICA",
	"SOUTH_AMERICA",
	"EUROPE",
	"AFRICA",
	"ASIA",
	"AUSTRALIA",
	"AWS",
	"GOOGLE",
	"EXTERNAL",
] as const;

export const bitmovinAccountDefaultsSchema = z.object({
	encoderVersion: z.string().min(1).default("STABLE"),
	cloudRegion: z.string().min(1).default("AUTO"),
	fallbackRegions: z.array(z.string().min(1)).default([]),
	schedulingPriority: z.number().int().min(0).max(100).optional(),
	prewarmedPoolIds: z.array(z.string().min(1)).default([]),
	/**
	 * Operator rate card  — MUST live in this schema even
	 * though live/cost.ts owns its shape: z.object STRIPS unknown keys, and
	 * both the settings form's save and applyAccountDefaultsToPlan parse
	 * defaults through here — an unlisted rateCard would be silently wiped
	 * by the next settings save. Validated strictly at WRITE time (a junk
	 * card fails the account save loudly); reads still go through
	 * rateCardFromDefaults, which degrades stored junk to "no estimate".
	 */
	rateCard: rateCardSchema.optional(),
});

export type BitmovinAccountDefaults = z.infer<
	typeof bitmovinAccountDefaultsSchema
>;

export const createBitmovinAccountSchema = z.object({
	label: z.string().min(1, "Label is required").max(120),
	apiKey: z.string().min(1, "API key is required"),
	tenantOrgId: z.string().min(1).optional(),
	defaults: bitmovinAccountDefaultsSchema.default({
		encoderVersion: "STABLE",
		cloudRegion: "AUTO",
		fallbackRegions: [],
		prewarmedPoolIds: [],
	}),
});

export type CreateBitmovinAccountRequest = z.infer<
	typeof createBitmovinAccountSchema
>;

export const updateBitmovinAccountSchema = z.object({
	label: z.string().min(1).max(120).optional(),
	apiKey: z.string().min(1).optional(),
	tenantOrgId: z.string().min(1).nullable().optional(),
	defaults: bitmovinAccountDefaultsSchema.optional(),
});

export type UpdateBitmovinAccountRequest = z.infer<
	typeof updateBitmovinAccountSchema
>;

/** Wire shape of an account summary as served by the API (dates ISO). */
export const bitmovinAccountSummaryWireSchema = z.object({
	/** Server-computed opt-in capability; absence is denied. */
	internalHevcV2: z.boolean().optional(),
	id: z.uuid(),
	label: z.string(),
	tenantOrgId: z.string().nullable(),
	defaults: bitmovinAccountDefaultsSchema.partial(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type BitmovinAccountSummaryWire = z.infer<
	typeof bitmovinAccountSummaryWireSchema
>;

export const testConnectionResultSchema = z.object({
	ok: z.boolean(),
	latencyMs: z.number().int().nonnegative().optional(),
	accountEmail: z.string().optional(),
	message: z.string().optional(),
});

export type TestConnectionResult = z.infer<typeof testConnectionResultSchema>;
