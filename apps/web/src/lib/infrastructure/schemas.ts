import { AGGREGATE_CLOUD_REGIONS, BITMOVIN_CLOUD_REGIONS } from "@bitovp/core";
import { z } from "zod";

/**
 * Cloud Connect / Static IP / Prewarmed-pool wire schemas for the web-only
 * Infrastructure surface. Client forms and server routes share these; the
 * server additionally allowlist-sanitizes every Bitmovin response through
 * the *_PUBLIC_FIELDS tables below, so cloud secrets (AWS keys, GCE private
 * keys, Akamai API tokens) can never round-trip to the browser.
 *
 * Kept in apps/web (not packages/core) deliberately: these are proxy-route
 * contracts consumed only by this app's routes + Settings UI, and the
 * parallel core-agent owns packages/core during this phase.
 *
 * Region enums are copied from @bitmovin/api-sdk 1.269.0 (the SDK is
 * server-side only — importing it here would pull it into the client
 * bundle). Regenerate on SDK bumps, mirroring core's BITMOVIN_CLOUD_REGIONS.
 */

export const CLOUD_PROVIDERS = [
	"aws",
	"gce",
	"azure",
	"akamai",
	"oci",
] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number];

export function isCloudProvider(value: string): value is CloudProviderId {
	return (CLOUD_PROVIDERS as readonly string[]).includes(value);
}

export const CLOUD_PROVIDER_LABELS: Record<CloudProviderId, string> = {
	aws: "AWS",
	gce: "Google Cloud (GCE)",
	azure: "Azure",
	akamai: "Akamai",
	oci: "OCI",
};

/** C6 — Bitmovin list endpoints hard-cap limit at 100. */
export const LIST_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// Provider region enums (path params of the region-settings sub-CRUD)
// ---------------------------------------------------------------------------

/** AwsCloudRegion — @bitmovin/api-sdk 1.269.0. */
export const AWS_REGIONS = [
	"US_EAST_1",
	"US_EAST_2",
	"US_WEST_1",
	"US_WEST_2",
	"EU_WEST_1",
	"EU_CENTRAL_1",
	"AP_SOUTHEAST_1",
	"AP_SOUTHEAST_2",
	"AP_NORTHEAST_1",
	"AP_NORTHEAST_2",
	"AP_SOUTH_1",
	"SA_EAST_1",
	"EU_WEST_2",
	"EU_WEST_3",
	"CA_CENTRAL_1",
	"EU_NORTH_1",
] as const;

/** GoogleCloudRegion — @bitmovin/api-sdk 1.269.0. */
export const GCE_REGIONS = [
	"US_CENTRAL_1",
	"US_EAST_1",
	"ASIA_EAST_1",
	"EUROPE_WEST_1",
	"US_WEST_1",
	"ASIA_EAST_2",
	"ASIA_NORTHEAST_1",
	"ASIA_SOUTH_1",
	"ASIA_SOUTHEAST_1",
	"AUSTRALIA_SOUTHEAST_1",
	"EUROPE_NORTH_1",
	"EUROPE_WEST_2",
	"EUROPE_WEST_3",
	"EUROPE_WEST_4",
	"NORTHAMERICA_NORTHEAST_1",
	"SOUTHAMERICA_EAST_1",
	"US_EAST_4",
	"US_WEST_2",
	"ME_CENTRAL_2",
] as const;

/** AzureCloudRegion — @bitmovin/api-sdk 1.269.0. */
export const AZURE_REGIONS = [
	"ASIA_EAST",
	"ASIA_SOUTHEAST",
	"AUSTRALIA_EAST",
	"AUSTRALIA_SOUTHEAST",
	"BRAZIL_SOUTH",
	"CANADA_CENTRAL",
	"EUROPE_NORTH",
	"EUROPE_WEST",
	"FRANCE_CENTRAL",
	"GERMANY_WESTCENTRAL",
	"INDIA_CENTRAL",
	"INDIA_SOUTH",
	"JAPAN_EAST",
	"JAPAN_WEST",
	"KOREA_CENTRAL",
	"UAE_NORTH",
	"US_CENTRAL",
	"US_EAST",
	"US_EAST2",
	"US_WEST",
	"US_WEST2",
	"US_SOUTH_CENTRAL",
	"US_NORTH_CENTRAL",
	"UK_SOUTH",
] as const;

/** AkamaiCloudRegion — @bitmovin/api-sdk 1.269.0. */
export const AKAMAI_REGIONS = [
	"BR_GRU",
	"ES_MAD",
	"FR_PAR",
	"ID_CGK",
	"IN_MAA",
	"IT_MIL",
	"JP_OSA",
	"NL_AMS",
	"SE_STO",
	"US_LAX",
	"US_MIA",
	"US_ORD",
	"US_SEA",
] as const;

/** OciCloudRegion — @bitmovin/api-sdk 1.269.0 (only these two exist). */
export const OCI_REGIONS = ["EU_FRANKFURT_1", "US_ASHBURN_1"] as const;

export const PROVIDER_REGIONS: Record<CloudProviderId, readonly string[]> = {
	aws: AWS_REGIONS,
	gce: GCE_REGIONS,
	azure: AZURE_REGIONS,
	akamai: AKAMAI_REGIONS,
	oci: OCI_REGIONS,
};

/**
 * Generic CloudRegion values that are NOT a concrete data center — the
 * scheduler aggregates (continents/providers) plus AUTO/EXTERNAL. Prewarmed
 * pools must pin a specific region; the Bitmovin API rejects these.
 */
// Derived from core's hoisted aggregate list  — the
// pool context APPENDS "EXTERNAL" deliberately: a prewarmed pool cannot
// live in a customer's own datacenter, while core's static-IP list keeps
// EXTERNAL out for its own stated reason.
export const NON_SPECIFIC_CLOUD_REGIONS = [
	...AGGREGATE_CLOUD_REGIONS,
	"EXTERNAL",
] as const;

/** Full generic CloudRegion enum (StaticIp.region takes any of these). */
export const CLOUD_REGIONS = BITMOVIN_CLOUD_REGIONS;

export const SPECIFIC_CLOUD_REGIONS = BITMOVIN_CLOUD_REGIONS.filter(
	(region) =>
		!(NON_SPECIFIC_CLOUD_REGIONS as readonly string[]).includes(region),
) as [string, ...string[]];

// ---------------------------------------------------------------------------
// Cloud Connect account create schemas (no update API — delete + re-create)
// ---------------------------------------------------------------------------

/**
 * customData is user-entered and non-secret by contract (it deliberately
 * stays visible in sanitized responses — see RESOURCE_PUBLIC_FIELDS), but it
 * is otherwise unbounded JSON: cap the serialized size on input so it cannot
 * become a payload/response bloat vector.
 */
export const CUSTOM_DATA_MAX_JSON_LENGTH = 8192;

const customDataSchema = z
	.record(z.string(), z.unknown())
	.superRefine((value, ctx) => {
		const serialized = JSON.stringify(value).length;
		if (serialized > CUSTOM_DATA_MAX_JSON_LENGTH) {
			ctx.addIssue({
				code: "custom",
				message: `customData is too large (${serialized} chars serialized; max ${CUSTOM_DATA_MAX_JSON_LENGTH})`,
			});
		}
	});

/** BitmovinResource base fields shared by accounts, region settings, pools. */
const bitmovinResourceFields = {
	name: z.string().min(1).max(256).optional(),
	description: z.string().max(1024).optional(),
	customData: customDataSchema.optional(),
};

// Free-text bounds: cloud ids / network names cap at 512 chars; pasted key
// material at 8192 (16384 for a whole service-account JSON). All far above
// any real value, low enough to stop megabyte bodies transiting to Bitmovin.

/**
 * accessKey/secretKey are the DEPRECATED key path; the modern path is
 * accountNumber + roleName (Bitmovin assumes arn:aws:iam::{accountNumber}:role/{roleName}).
 * Strict: an unexpected field (e.g. a mistyped secret name) 400s instead of
 * being silently dropped.
 */
export const awsAccountCreateSchema = z
	.strictObject({
		...bitmovinResourceFields,
		accountNumber: z.string().min(1, "AWS account number is required").max(512),
		roleName: z.string().min(1).max(512).optional(),
		externalId: z.string().min(1).max(512).optional(),
		accessKey: z.string().min(1).max(8192).optional(),
		secretKey: z.string().min(1).max(8192).optional(),
	})
	.superRefine((value, ctx) => {
		if ((value.accessKey === undefined) !== (value.secretKey === undefined)) {
			ctx.addIssue({
				code: "custom",
				message: "accessKey and secretKey must be provided together",
				path: [value.accessKey === undefined ? "accessKey" : "secretKey"],
			});
		}
	});

/**
 * One-of: EITHER the whole service-account JSON, OR the
 * email + privateKey + projectId triple — never a mix.
 */
export const gceAccountCreateSchema = z
	.strictObject({
		...bitmovinResourceFields,
		serviceAccountCredentials: z.string().min(1).max(16384).optional(),
		serviceAccountEmail: z.string().min(1).max(512).optional(),
		privateKey: z.string().min(1).max(8192).optional(),
		projectId: z.string().min(1).max(512).optional(),
	})
	.superRefine((value, ctx) => {
		const hasJson = value.serviceAccountCredentials !== undefined;
		const tripleCount = [
			value.serviceAccountEmail,
			value.privateKey,
			value.projectId,
		].filter((field) => field !== undefined).length;
		if (hasJson && tripleCount > 0) {
			ctx.addIssue({
				code: "custom",
				message:
					"Provide EITHER serviceAccountCredentials OR serviceAccountEmail/privateKey/projectId — not both",
				path: ["serviceAccountCredentials"],
			});
		}
		if (!hasJson && tripleCount !== 3) {
			ctx.addIssue({
				code: "custom",
				message:
					"Provide serviceAccountCredentials, or ALL of serviceAccountEmail, privateKey and projectId",
				path: ["serviceAccountCredentials"],
			});
			// Also flag each missing triple field so split-mode forms (which
			// don't render the JSON field) surface the error somewhere visible.
			for (const field of [
				"serviceAccountEmail",
				"privateKey",
				"projectId",
			] as const) {
				if (value[field] === undefined) {
					ctx.addIssue({
						code: "custom",
						message: "Required unless serviceAccountCredentials is provided",
						path: [field],
					});
				}
			}
		}
	});

export const azureAccountCreateSchema = z.strictObject({
	...bitmovinResourceFields,
	subscriptionId: z.string().min(1, "Subscription id is required").max(512),
	resourceGroupId: z.string().min(1, "Resource group id is required").max(512),
	tenantId: z.string().min(1, "Tenant id is required").max(512),
});

export const ociAccountCreateSchema = z.strictObject({
	...bitmovinResourceFields,
	tenancyId: z.string().min(1, "Tenancy OCID is required").max(512),
	compartmentId: z.string().min(1, "Compartment OCID is required").max(512),
});

export const akamaiAccountCreateSchema = z.strictObject({
	...bitmovinResourceFields,
	apiToken: z.string().min(1, "API token is required").max(8192),
});

export const CLOUD_ACCOUNT_CREATE_SCHEMAS: Record<CloudProviderId, z.ZodType> =
	{
		aws: awsAccountCreateSchema,
		gce: gceAccountCreateSchema,
		azure: azureAccountCreateSchema,
		akamai: akamaiAccountCreateSchema,
		oci: ociAccountCreateSchema,
	};

/**
 * Request-body fields that pass through to Bitmovin and are NEVER persisted,
 * logged, or echoed back (audit snapshots carry `<field>Provided: true`).
 */
export const CLOUD_ACCOUNT_SECRET_FIELDS: Record<
	CloudProviderId,
	readonly string[]
> = {
	aws: ["accessKey", "secretKey"],
	gce: ["serviceAccountCredentials", "privateKey"],
	azure: [],
	akamai: ["apiToken"],
	oci: [],
};

// ---------------------------------------------------------------------------
// Per-provider region settings (sub-CRUD; region is a path param)
// ---------------------------------------------------------------------------

export const awsRegionSettingsSchema = z.strictObject({
	...bitmovinResourceFields,
	limitParallelEncodings: z.number().int().min(1).optional(),
	securityGroupId: z.string().min(1, "Security group id is required").max(512),
	subnetId: z.string().min(1, "Subnet id is required").max(512),
	sshPort: z.number().int().min(1).max(65535).optional(),
});

export const gceRegionSettingsSchema = z.strictObject({
	...bitmovinResourceFields,
	network: z.string().min(1, "Network is required").max(512),
	subnetId: z.string().min(1, "Subnet id is required").max(512),
});

export const azureRegionSettingsSchema = z.strictObject({
	...bitmovinResourceFields,
	networkName: z.string().min(1, "Network name is required").max(512),
	subnetName: z.string().min(1, "Subnet name is required").max(512),
});

export const ociRegionSettingsSchema = z.strictObject({
	...bitmovinResourceFields,
	subnetId: z.string().min(1, "Subnet OCID is required").max(512),
});

/** Akamai is the one provider whose ids are NUMBERS on the wire. */
export const akamaiRegionSettingsSchema = z.strictObject({
	...bitmovinResourceFields,
	subnetId: z.number("Akamai subnet id is a number").int(),
	firewallId: z.number("Akamai firewall id is a number").int(),
});

export const REGION_SETTINGS_SCHEMAS: Record<CloudProviderId, z.ZodType> = {
	aws: awsRegionSettingsSchema,
	gce: gceRegionSettingsSchema,
	azure: azureRegionSettingsSchema,
	akamai: akamaiRegionSettingsSchema,
	oci: ociRegionSettingsSchema,
};

// ---------------------------------------------------------------------------
// Static IPs (BitmovinResponse only — no name/description)
// ---------------------------------------------------------------------------

export const staticIpCreateSchema = z.strictObject({
	region: z.enum(CLOUD_REGIONS, "region must be a Bitmovin CloudRegion"),
	/** Only for AWS Cloud Connect infrastructures; blank = managed cloud. */
	infrastructureId: z.uuid().optional(),
});

export const STATIC_IP_STATUSES = [
	"CREATING",
	"UNUSED",
	"ERROR",
	"USED",
] as const;
export type StaticIpStatus = (typeof STATIC_IP_STATUSES)[number];

// ---------------------------------------------------------------------------
// Prewarmed encoder pools + schedules
// ---------------------------------------------------------------------------

/** Wire values are the GB figures as strings. */
export const PREWARMED_DISK_SIZES = ["500", "1000", "2000"] as const;

/**
 * Pool region choices: every specific data-center region plus EXTERNAL for
 * Cloud Connect (BYOC) pools. EXTERNAL-for-BYOC-pools is inferred from the
 * C18 encoding contract (encodings on an infrastructure run with cloudRegion
 * EXTERNAL) — unverified against a real Cloud Connect entitlement (STATUS 🧪).
 * AUTO and the continent/provider aggregates stay rejected either way.
 */
export const POOL_CLOUD_REGIONS = [...SPECIFIC_CLOUD_REGIONS, "EXTERNAL"] as [
	string,
	...string[],
];

export const prewarmedPoolCreateSchema = z
	.strictObject({
		...bitmovinResourceFields,
		encoderVersion: z.string().min(1, "Encoder version is required").max(512),
		cloudRegion: z.enum(
			POOL_CLOUD_REGIONS,
			"cloudRegion must be a specific region (or EXTERNAL for a Cloud Connect pool) — AUTO, continent and provider aggregates are rejected by the Bitmovin API",
		),
		infrastructureId: z.uuid().optional(),
		diskSize: z.enum(
			PREWARMED_DISK_SIZES,
			"diskSize must be 500, 1000 or 2000 (GB)",
		),
		targetPoolSize: z
			.number()
			.int()
			.min(1, "targetPoolSize must be at least 1")
			.max(100, "targetPoolSize must be at most 100"),
		/** Dynamic growth caps at 10 instances — surfaced in UI copy. */
		dynamicPool: z.boolean().optional(),
		gpuEnabled: z.boolean().optional(),
	})
	.superRefine((value, ctx) => {
		if (
			value.cloudRegion === "EXTERNAL" &&
			value.infrastructureId === undefined
		) {
			const message =
				"cloudRegion EXTERNAL requires infrastructureId (the pool runs inside YOUR Cloud Connect infrastructure); a managed-cloud pool must pin a specific region instead";
			// Flag both fields: the select that triggered it and the input to fix.
			ctx.addIssue({ code: "custom", message, path: ["cloudRegion"] });
			ctx.addIssue({ code: "custom", message, path: ["infrastructureId"] });
		}
	});

export const POOL_ACTIONS = ["start", "stop"] as const;

export const poolScheduleCreateSchema = z.strictObject({
	action: z.enum(["START", "STOP"]),
	/** UTC ISO 8601; Bitmovin ignores the seconds component. */
	triggerDate: z.iso.datetime(
		"triggerDate must be a UTC ISO 8601 timestamp (e.g. 2026-08-06T14:00:00Z)",
	),
});

// ---------------------------------------------------------------------------
// Response sanitizers — allowlists, applied to EVERY Bitmovin response the
// routes return. Even if Bitmovin ever echoed a secret, it cannot pass.
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

// customData is echoed back deliberately: it is user-entered and non-secret
// by contract (secrets have dedicated write-only fields), and its size is
// capped on input (CUSTOM_DATA_MAX_JSON_LENGTH).
const RESOURCE_PUBLIC_FIELDS = [
	"id",
	"name",
	"description",
	"customData",
	"createdAt",
	"modifiedAt",
] as const;

const CLOUD_ACCOUNT_PUBLIC_FIELDS: Record<CloudProviderId, readonly string[]> =
	{
		aws: [...RESOURCE_PUBLIC_FIELDS, "accountNumber", "roleName", "externalId"],
		gce: [...RESOURCE_PUBLIC_FIELDS, "serviceAccountEmail", "projectId"],
		azure: [
			...RESOURCE_PUBLIC_FIELDS,
			"subscriptionId",
			"resourceGroupId",
			"tenantId",
		],
		akamai: [...RESOURCE_PUBLIC_FIELDS],
		oci: [...RESOURCE_PUBLIC_FIELDS, "tenancyId", "compartmentId"],
	};

const REGION_SETTINGS_PUBLIC_FIELDS: Record<
	CloudProviderId,
	readonly string[]
> = {
	aws: [
		...RESOURCE_PUBLIC_FIELDS,
		"region",
		"limitParallelEncodings",
		"securityGroupId",
		"subnetId",
		"sshPort",
	],
	gce: [...RESOURCE_PUBLIC_FIELDS, "region", "network", "subnetId"],
	azure: [...RESOURCE_PUBLIC_FIELDS, "region", "networkName", "subnetName"],
	akamai: [...RESOURCE_PUBLIC_FIELDS, "region", "subnetId", "firewallId"],
	oci: [...RESOURCE_PUBLIC_FIELDS, "region", "subnetId"],
};

const STATIC_IP_PUBLIC_FIELDS = [
	"id",
	"region",
	"infrastructureId",
	"ipAddress",
	"status",
	"createdAt",
	"modifiedAt",
] as const;

const POOL_PUBLIC_FIELDS = [
	...RESOURCE_PUBLIC_FIELDS,
	"encoderVersion",
	"cloudRegion",
	"infrastructureId",
	"diskSize",
	"targetPoolSize",
	"dynamicPool",
	"gpuEnabled",
	"status",
] as const;

const SCHEDULE_PUBLIC_FIELDS = ["id", "action", "triggerDate"] as const;

function pick(raw: unknown, keys: readonly string[]): UnknownRecord {
	const source = (raw ?? {}) as UnknownRecord;
	const out: UnknownRecord = {};
	for (const key of keys) {
		if (source[key] !== undefined) {
			out[key] = source[key];
		}
	}
	return out;
}

export function sanitizeCloudAccount(
	provider: CloudProviderId,
	raw: unknown,
): UnknownRecord {
	return pick(raw, CLOUD_ACCOUNT_PUBLIC_FIELDS[provider]);
}

export function sanitizeRegionSettings(
	provider: CloudProviderId,
	raw: unknown,
): UnknownRecord {
	return pick(raw, REGION_SETTINGS_PUBLIC_FIELDS[provider]);
}

export function sanitizeStaticIp(raw: unknown): UnknownRecord {
	return pick(raw, STATIC_IP_PUBLIC_FIELDS);
}

export function sanitizePrewarmedPool(raw: unknown): UnknownRecord {
	return pick(raw, POOL_PUBLIC_FIELDS);
}

export function sanitizePoolSchedule(raw: unknown): UnknownRecord {
	return pick(raw, SCHEDULE_PUBLIC_FIELDS);
}

/** Drops Bitmovin's previous/next link fields; items go through mapItem. */
export function sanitizePage(
	page: unknown,
	mapItem: (item: unknown) => UnknownRecord,
): {
	totalCount?: number;
	offset?: number;
	limit?: number;
	items: UnknownRecord[];
} {
	const p = (page ?? {}) as {
		totalCount?: number;
		offset?: number;
		limit?: number;
		items?: unknown[];
	};
	return {
		...(p.totalCount !== undefined ? { totalCount: p.totalCount } : {}),
		...(p.offset !== undefined ? { offset: p.offset } : {}),
		...(p.limit !== undefined ? { limit: p.limit } : {}),
		items: (p.items ?? []).map(mapItem),
	};
}

/**
 * Audit-log request snapshot: secret fields are replaced by
 * `<field>Provided: true` presence flags (vault precedent — secrets are
 * write-only and never appear in any persisted record).
 */
export function auditSnapshot(
	body: UnknownRecord,
	secretFields: readonly string[],
): UnknownRecord {
	const out: UnknownRecord = {};
	for (const [key, value] of Object.entries(body)) {
		if (secretFields.includes(key)) {
			if (value !== undefined) {
				out[`${key}Provided`] = true;
			}
		} else if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Route query helpers
// ---------------------------------------------------------------------------

export const accountQuerySchema = z.object({
	bitmovinAccountId: z.uuid("bitmovinAccountId must be a UUID"),
});

/**
 * limit CLAMPS to 100 rather than erroring: C6 is Bitmovin's hard cap, and a
 * proxy caller asking for more simply gets the cap plus offset paging.
 */
export const listQuerySchema = accountQuerySchema.extend({
	offset: z.coerce.number().int().min(0).default(0),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.default(25)
		.transform((value) => Math.min(value, LIST_LIMIT_MAX)),
});

// ---------------------------------------------------------------------------
// Wire DTOs for the Settings UI
// ---------------------------------------------------------------------------

export type PageDto<T> = {
	totalCount?: number;
	offset?: number;
	limit?: number;
	items: T[];
};

export type CloudAccountDto = {
	id: string;
	name?: string;
	description?: string;
	customData?: Record<string, unknown>;
	createdAt?: string;
	modifiedAt?: string;
	// aws
	accountNumber?: string;
	roleName?: string;
	externalId?: string;
	// gce
	serviceAccountEmail?: string;
	projectId?: string;
	// azure
	subscriptionId?: string;
	resourceGroupId?: string;
	tenantId?: string;
	// oci
	tenancyId?: string;
	compartmentId?: string;
};

export type RegionSettingsDto = {
	id?: string;
	name?: string;
	region?: string;
	limitParallelEncodings?: number;
	securityGroupId?: string;
	subnetId?: string | number;
	sshPort?: number;
	network?: string;
	networkName?: string;
	subnetName?: string;
	firewallId?: number;
};

export type StaticIpDto = {
	id: string;
	region?: string;
	infrastructureId?: string;
	ipAddress?: string;
	status?: StaticIpStatus;
};

export type PrewarmedPoolDto = {
	id: string;
	name?: string;
	description?: string;
	encoderVersion?: string;
	cloudRegion?: string;
	infrastructureId?: string;
	diskSize?: string;
	targetPoolSize?: number;
	dynamicPool?: boolean;
	gpuEnabled?: boolean;
	status?: "STARTED" | "STOPPED";
};

export type PoolScheduleDto = {
	id: string;
	action?: "START" | "STOP";
	triggerDate?: string;
};
