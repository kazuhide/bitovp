import {
	type SlateDifference,
	type SlateInputPath,
	type SlateMediaKind,
	type SlateNormalizationTarget,
	type SlatePreparation,
	type SlateStandDown,
	slateSourceSchema,
} from "@bitovp/core";
import { z } from "zod";

/**
 * Wire schemas + response sanitizers for the LIVE RUNTIME surface (P5 PR-3):
 * ESAM media points, scheduled insertable content, stream keys, DNS mappings,
 * live standby pools and the RTMP-input picker list.
 *
 * Same contract as `@/lib/infrastructure/schemas` (PR-2) and kept in apps/web
 * for the same reason: these are proxy-route contracts consumed only by this
 * app's routes + its client panels, and `packages/core` is owned by the
 * parallel core-agent this phase. Enum values are copied from
 * @bitmovin/api-sdk 1.269.0 — the SDK is server-side only, so importing it
 * here would drag it into the client bundle. Regenerate on SDK bumps.
 *
 * The generic paging/account query helpers (`listQuerySchema`,
 * `accountQuerySchema`, `sanitizePage`, `LIST_LIMIT_MAX`, `PageDto`) are
 * REUSED from the infrastructure module rather than forked.
 */

export {
	accountQuerySchema,
	LIST_LIMIT_MAX,
	listQuerySchema,
	type PageDto,
	sanitizePage,
} from "@/lib/infrastructure/schemas";

type UnknownRecord = Record<string, unknown>;

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

/** Allowlists a nested array field through its own per-item allowlist. */
function pickList(
	raw: unknown,
	key: string,
	itemKeys: readonly string[],
): UnknownRecord {
	const value = (raw as UnknownRecord | null)?.[key];
	return Array.isArray(value)
		? { [key]: value.map((item) => pick(item, itemKeys)) }
		: {};
}

const RESOURCE_PUBLIC_FIELDS = [
	"id",
	"name",
	"description",
	"createdAt",
	"modifiedAt",
] as const;

// ---------------------------------------------------------------------------
// ESAM media points (SCTE-250) — POST-only surface
// ---------------------------------------------------------------------------

/**
 * `binary` is a base64 SCTE-35 splice payload. Canonical-base64 form is the
 * decodability check (length a multiple of 4, alphabet + at-most-2 `=`) — it
 * rejects everything `atob` would and additionally rejects non-canonical
 * padding, without depending on Buffer/atob so client and server share it.
 */
const BASE64_CANONICAL = /^[A-Za-z0-9+/]+={0,2}$/;

export const ESAM_BINARY_MAX_LENGTH = 4096;

export function isCanonicalBase64(value: string): boolean {
	return (
		value.length % 4 === 0 &&
		BASE64_CANONICAL.test(value) &&
		// A canonical payload never pads more than the final quantum.
		!value.slice(0, -2).includes("=")
	);
}

/**
 * ISO 8601 duration, accurate to milliseconds, optionally negative (an ESAM
 * signal may sit before the matched point).
 */
const ISO_DURATION =
	/^-?P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d{1,3})?S)?)?$/;

export const esamSignalSchema = z.strictObject({
	offset: z
		.string()
		.regex(
			ISO_DURATION,
			"offset must be an ISO 8601 duration (e.g. PT10S, -PT1.500S)",
		)
		.optional(),
	binary: z
		.string()
		.min(1, "binary is required")
		.max(
			ESAM_BINARY_MAX_LENGTH,
			`binary must be at most ${ESAM_BINARY_MAX_LENGTH} base64 characters`,
		)
		.refine(isCanonicalBase64, "binary must be base64-encoded SCTE-35 data"),
});

export const esamMediaPointCreateSchema = z.strictObject({
	/** Absent ⇒ Bitmovin matches/inserts as soon as it can. */
	matchTime: z.iso
		.datetime("matchTime must be a UTC ISO 8601 timestamp")
		.optional(),
	signals: z.array(esamSignalSchema).min(1, "At least one signal is required"),
});

export function sanitizeEsamMediaPoint(raw: unknown): UnknownRecord {
	return {
		...pick(raw, ["matchTime"]),
		...pickList(raw, "signals", ["offset", "binary"]),
	};
}

// ---------------------------------------------------------------------------
// Scheduled insertable content
// ---------------------------------------------------------------------------

export const INSERTABLE_CONTENT_STATUSES = [
	"CREATED",
	"DOWNLOADING",
	"READY",
	"ERROR",
] as const;
export type InsertableContentStatus =
	(typeof INSERTABLE_CONTENT_STATUSES)[number];

export const SCHEDULED_CONTENT_STATUSES = [
	"CREATED",
	"SCHEDULED",
	"TO_BE_DESCHEDULED",
	"DESCHEDULED",
	"ERROR",
] as const;
export type ScheduledContentStatus =
	(typeof SCHEDULED_CONTENT_STATUSES)[number];

/**
 * Two shapes for the media, exactly one per request (C36 / WP-A1):
 *
 *  - `source` — the picker's `{credentialId, bucket, key}` (`slateSourceSchema`,
 *    the same triple a scheduled slate carries). The SERVER mints the Bitmovin
 *    input from the vaulted credential and runs the compatibility preflight
 *    against the object's inspection before anything is created.
 *  - `inputs` — the raw `{inputId, inputPath}` form, kept for API clients and
 *    the panel's advanced disclosure. The server resolves the input's bucket
 *    and preflights when a credential can read it; otherwise the check stands
 *    down with an explicit `UNVERIFIED` note.
 */
export const insertableContentInputSchema = z.strictObject({
	inputId: z.uuid("inputId must be a UUID"),
	inputPath: z.string().min(1, "inputPath is required").max(2048),
	description: z.string().max(1024).optional(),
});

export const insertableContentCreateSchema = z
	.strictObject({
		name: z.string().min(1).max(256).optional(),
		description: z.string().max(1024).optional(),
		inputs: z
			.array(insertableContentInputSchema)
			.min(1, "At least one input is required")
			.optional(),
		source: slateSourceSchema.optional(),
	})
	.refine(
		(value) => (value.inputs !== undefined) !== (value.source !== undefined),
		{
			message: "Provide exactly one of inputs or source",
			path: ["inputs"],
		},
	);

/** What the compatibility preflight could establish (C36). */
export const SLATE_PREFLIGHT_VERDICTS = [
	"OK",
	"INCOMPATIBLE",
	"UNVERIFIED",
] as const;
export type SlatePreflightVerdict = (typeof SLATE_PREFLIGHT_VERDICTS)[number];

/**
 * Why a verdict is UNVERIFIED — the core stand-downs plus the three the
 * route adds when it cannot reach a probe at all.
 */
export type SlatePreflightStandDown =
	| SlateStandDown
	| "NO_CREDENTIAL"
	| "INPUT_UNRESOLVED"
	| "INSPECTION_FAILED";

export type SlatePreflightDto = {
	/** PENDING: an inspection is running — poll again. */
	status: "PENDING" | "DONE";
	verdict?: SlatePreflightVerdict;
	/**
	 * One plain sentence for humans and logs — `OK`, `INCOMPATIBLE: …`,
	 * `UNVERIFIED (<standDown>): …`, `PENDING: …`. The same string is stamped
	 * on the provider content's `description` when a registration proceeds
	 * UNVERIFIED, so the fire path can name the stood-down check later.
	 */
	summary: string;
	standDown?: SlatePreflightStandDown;
	/** English diagnostic for the stand-down (logs/API clients); the UI localizes by code. */
	note?: string;
	inspectionId?: string;
	/** The object the verdict is about, once resolved. */
	candidate?: { credentialId: string; bucket: string; key: string };
	inputPath: SlateInputPath;
	kind?: SlateMediaKind;
	container?: string | null;
	differences?: SlateDifference[];
	/**
	 * What the verdict compared and what it could not (rev406 R1): an `OK` is
	 * a statement about `compared` only — a heartbeat-derived reference knows
	 * no profile, level, pixel format or channel count.
	 */
	compared?: string[];
	notComparable?: string[];
	/** Raw ffprobe JSON of the inspected object (for the summary table). */
	probe?: unknown;
	/**
	 * : what registration will DO with the object — register it as
	 * it is, convert it to an ingest-matching MPEG-TS, wait for the live
	 * input first, or refuse. Present on every DONE verdict.
	 */
	preparation?: SlatePreparation;
	/**
	 * Where a converted file will be written (`NORMALIZE` only): the channel's
	 * S3-family output storage when the plan has one, else next to the source
	 * (`sameAsSource`), which then needs a credential that can write there.
	 * No credential id — the client names the object, never the key material.
	 */
	conversionDestination?: {
		bucket: string;
		keyPrefix: string;
		sameAsSource: boolean;
	};
};

// ---------------------------------------------------------------------------
// Slate normalization rows
// ---------------------------------------------------------------------------

export const SLATE_NORMALIZATION_STATUSES = [
	"WAITING_FOR_INPUT",
	"QUEUED",
	"NORMALIZING",
	"REGISTERING",
	"READY",
	"ERROR",
] as const;
export type SlateNormalizationStatus =
	(typeof SLATE_NORMALIZATION_STATUSES)[number];

/** The panel's view of one registration in flight (or recently done). */
export type SlateNormalizationDto = {
	id: string;
	status: SlateNormalizationStatus;
	name: string | null;
	bucket: string;
	sourceKey: string;
	registeredKey: string | null;
	/** The converted file's bucket when it is not the source's; null = `bucket`. */
	registeredBucket: string | null;
	normalized: boolean;
	insertableContentId: string | null;
	target: SlateNormalizationTarget | null;
	/** English diagnostic from the worker; shown under "technical". */
	note: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
};

const SLATE_NORMALIZATION_PUBLIC_FIELDS = [
	"id",
	"status",
	"name",
	"bucket",
	"sourceKey",
	"registeredKey",
	"registeredBucket",
	"normalized",
	"insertableContentId",
	"target",
	"note",
	"error",
	"createdAt",
	"updatedAt",
] as const;

/** The row without its credential id: the panel names the object, never the key material's reference. */
export function sanitizeSlateNormalization(raw: unknown): UnknownRecord {
	return pick(raw, SLATE_NORMALIZATION_PUBLIC_FIELDS);
}

/**
 * `details` of the 422 `SLATE_INCOMPATIBLE` refusal — the same verdict the
 * preflight route returns, so the panel renders one shape for both.
 */
export type SlateIncompatibleDetails = {
	code: "SLATE_INCOMPATIBLE" | "SLATE_UNSUPPORTED_IMAGE";
	differences: SlateDifference[];
	kind?: SlateMediaKind;
	container?: string | null;
};

export const scheduleContentCreateSchema = z.strictObject({
	contentId: z.uuid("contentId must be a UUID"),
	/** Absent ⇒ played as soon as possible. */
	runAt: z.iso.datetime("runAt must be a UTC ISO 8601 timestamp").optional(),
	/** REQUIRED by Bitmovin for image content; optional for movie files. */
	durationInSeconds: z.number().int().min(1).max(86_400).optional(),
});

const INSERTABLE_CONTENT_PUBLIC_FIELDS = [
	...RESOURCE_PUBLIC_FIELDS,
	"status",
] as const;

export function sanitizeInsertableContent(raw: unknown): UnknownRecord {
	return {
		...pick(raw, INSERTABLE_CONTENT_PUBLIC_FIELDS),
		...pickList(raw, "inputs", ["inputId", "inputPath", "description"]),
	};
}

const SCHEDULED_CONTENT_PUBLIC_FIELDS = [
	...RESOURCE_PUBLIC_FIELDS,
	"contentId",
	"runAt",
	"durationInSeconds",
	"status",
] as const;

export function sanitizeScheduledContent(raw: unknown): UnknownRecord {
	return pick(raw, SCHEDULED_CONTENT_PUBLIC_FIELDS);
}

// ---------------------------------------------------------------------------
// Stream keys
// ---------------------------------------------------------------------------

export const STREAM_KEY_STATUSES = ["ASSIGNED", "UNASSIGNED"] as const;
export type StreamKeyStatus = (typeof STREAM_KEY_STATUSES)[number];

export const STREAM_KEY_TYPES = ["RESERVED", "TEMPORARY"] as const;
export type StreamKeyType = (typeof STREAM_KEY_TYPES)[number];

/**
 * `value` is optional on create — Bitmovin generates a secure random key when
 * omitted, which is the recommended path (a guessable key compromises the
 * encoding). Capped and charset-restricted because it becomes part of an RTMP
 * URL path.
 */
export const streamKeyCreateSchema = z.strictObject({
	name: z.string().min(1).max(256).optional(),
	description: z.string().max(1024).optional(),
	value: z
		.string()
		.min(8, "A manual stream key must be at least 8 characters")
		.max(256)
		.regex(
			/^[A-Za-z0-9._-]+$/,
			"A manual stream key may only contain letters, digits, dot, underscore and dash",
		)
		.optional(),
	type: z.enum(STREAM_KEY_TYPES).optional(),
});

export const streamKeyListQuerySchema = z.object({
	type: z.enum(STREAM_KEY_TYPES).optional(),
	status: z.enum(STREAM_KEY_STATUSES).optional(),
	assignedEncodingId: z.uuid().optional(),
});

export const streamKeyUnassignSchema = z.strictObject({
	encodingId: z.uuid("encodingId must be a UUID"),
});

/**
 * `value` is deliberately in the allowlist: like `LiveChannel.streamKey` it is
 * connection-routing material the operator must read back to point an encoder
 * at Bitmovin — the ledgered redaction exception (COVERAGE P3 batch 1).
 *
 * CAUTION: this model calls the key material `value`, which redactSecrets does
 * NOT mask (SENSITIVE_SUFFIX matches `*key`, `*secret`, … — not `value`), so the
 * usual backstop does not apply. The route therefore strips `value` from both
 * audit snapshots explicitly via `auditSnapshot(..., ["value"])`. Anything else
 * that ever persists a sanitized StreamKey must do the same.
 */
const STREAM_KEY_METADATA_FIELDS = [
	...RESOURCE_PUBLIC_FIELDS,
	"status",
	"type",
	"assignedEncodingId",
	"assignedIngestPointId",
] as const;

const STREAM_KEY_PUBLIC_FIELDS = [
	...STREAM_KEY_METADATA_FIELDS,
	"value",
] as const;

/**
 * Single-resource projection: `value` included. A create response or an
 * explicit per-key GET is the operator asking for THIS key.
 */
export function sanitizeStreamKey(raw: unknown): UnknownRecord {
	return pick(raw, STREAM_KEY_PUBLIC_FIELDS);
}

/**
 * LIST projection: `value` withheld (review catch M6). A list would otherwise
 * hand out up to 100 live ingest credentials at once — including keys for
 * encodings the caller never asked about — on an unauthenticated, unaudited
 * GET. That is looser than the credential store, which is write-only with
 * reveal-on-demand; the UI reveals a single key through the per-key route.
 */
export function sanitizeStreamKeyListItem(raw: unknown): UnknownRecord {
	return pick(raw, STREAM_KEY_METADATA_FIELDS);
}

// ---------------------------------------------------------------------------
// DNS mappings (P5 "DNS ingest")
// ---------------------------------------------------------------------------

/**
 * Subdomain rules are Bitmovin's: lowercase letters, digits and dashes, at
 * most 63 characters (one DNS label).
 */
export const dnsMappingCreateSchema = z.strictObject({
	encodingId: z.uuid("encodingId must be a UUID"),
	subdomain: z
		.string()
		.min(1, "subdomain is required")
		.max(63, "subdomain must be at most 63 characters")
		.regex(
			/^[a-z0-9-]+$/,
			"subdomain may only contain lowercase letters, digits and dashes",
		),
	name: z.string().min(1).max(256).optional(),
	description: z.string().max(1024).optional(),
});

const DNS_MAPPING_PUBLIC_FIELDS = [
	...RESOURCE_PUBLIC_FIELDS,
	"subdomain",
	"hostname",
	"encodingId",
	"ip",
] as const;

export function sanitizeDnsMapping(raw: unknown): UnknownRecord {
	return pick(raw, DNS_MAPPING_PUBLIC_FIELDS);
}

// ---------------------------------------------------------------------------
// Live standby pools
// ---------------------------------------------------------------------------

export const STANDBY_POOL_STATUSES = ["HEALTHY", "ERROR"] as const;
export type StandbyPoolStatus = (typeof STANDBY_POOL_STATUSES)[number];

export const STANDBY_POOL_ENCODING_STATUSES = [
	"TO_BE_CREATED",
	"CREATING",
	"PREPARING",
	"READY",
	"TO_BE_DELETED",
	"DELETING",
	"ACQUIRED",
	"ERROR",
] as const;
export type StandbyPoolEncodingStatus =
	(typeof STANDBY_POOL_ENCODING_STATUSES)[number];

export const STANDBY_POOL_LOG_TYPES = ["INFO", "WARN", "ERROR"] as const;
export type StandbyPoolLogType = (typeof STANDBY_POOL_LOG_TYPES)[number];

/**
 * `encodingTemplate` is submitted as PLAIN template text; the route
 * base64-encodes it into `LiveStandbyPoolRequest.encodingTemplate` (the wire
 * field is documented base64). Cap is on the plain text.
 */
export const ENCODING_TEMPLATE_MAX_LENGTH = 262_144;

const encodingTemplateSchema = z
	.string()
	.min(1, "encodingTemplate is required")
	.max(
		ENCODING_TEMPLATE_MAX_LENGTH,
		`encodingTemplate must be at most ${ENCODING_TEMPLATE_MAX_LENGTH} characters`,
	);

export const standbyPoolCreateSchema = z.strictObject({
	name: z.string().min(1, "name is required").max(256),
	description: z.string().max(1024).optional(),
	targetPoolSize: z
		.number()
		.int()
		.min(1, "targetPoolSize must be at least 1")
		.max(100, "targetPoolSize must be at most 100"),
	encodingTemplate: encodingTemplateSchema,
});

export const standbyPoolUpdateSchema = z
	.strictObject({
		targetPoolSize: z.number().int().min(1).max(100).optional(),
		encodingTemplate: encodingTemplateSchema.optional(),
	})
	.refine(
		(value) =>
			value.targetPoolSize !== undefined ||
			value.encodingTemplate !== undefined,
		"Provide targetPoolSize and/or encodingTemplate",
	);

export const STANDBY_POOL_ACTIONS = [
	"acquire",
	"deleteErrorEncodings",
] as const;
export type StandbyPoolAction = (typeof STANDBY_POOL_ACTIONS)[number];

const STANDBY_POOL_PUBLIC_FIELDS = [
	...RESOURCE_PUBLIC_FIELDS,
	"targetPoolSize",
	"readyEncodings",
	"preparingEncodings",
	"errorEncodings",
	"encodingTemplateName",
	"poolStatus",
] as const;

/** List projection — the (potentially large) template is detail-only. */
export function sanitizeStandbyPool(raw: unknown): UnknownRecord {
	return pick(raw, STANDBY_POOL_PUBLIC_FIELDS);
}

/**
 * Detail projection. `encodingTemplate` stays the raw base64 exactly as
 * upstream returned it; `encodingTemplateText` is the decoded template for
 * display/editing (absent when the payload is not valid base64/UTF-8 — we
 * never guess).
 */
export function sanitizeStandbyPoolDetails(
	raw: unknown,
	decode: (b64: string) => string | undefined,
): UnknownRecord {
	const base = sanitizeStandbyPool(raw);
	const template = (raw as UnknownRecord | null)?.encodingTemplate;
	if (typeof template !== "string") {
		return base;
	}
	const text = decode(template);
	return {
		...base,
		encodingTemplate: template,
		...(text !== undefined ? { encodingTemplateText: text } : {}),
	};
}

/**
 * An acquired encoding's ingest points carry a readable `streamKey` — the same
 * ledgered exception as `sanitizeStreamKey.value`: it is the credential the
 * operator types into their contribution encoder, useless to display masked.
 * The AUDIT row still masks it (`redactSecrets`, `key` suffix).
 */
export function sanitizeStandbyPoolEncoding(raw: unknown): UnknownRecord {
	return {
		...pick(raw, ["id", "createdAt", "modifiedAt", "encodingId", "status"]),
		...pickList(raw, "ingestPoints", ["streamBaseUrl", "streamKey"]),
		...pickList(raw, "manifests", ["url", "manifestId", "type"]),
	};
}

const STANDBY_POOL_LOG_PUBLIC_FIELDS = [
	"id",
	"standbyPoolId",
	"standbyPoolEncodingId",
	"createdAt",
	"message",
	"details",
	"eventType",
] as const;

export function sanitizeStandbyPoolLog(raw: unknown): UnknownRecord {
	return pick(raw, STANDBY_POOL_LOG_PUBLIC_FIELDS);
}

// ---------------------------------------------------------------------------
// RTMP inputs (account list feeding the live wizard's input picker)
// ---------------------------------------------------------------------------

export function sanitizeRtmpInput(raw: unknown): UnknownRecord {
	return pick(raw, ["id", "name"]);
}

// ---------------------------------------------------------------------------
// Inputs — ALL types (feeds the insertable-content input picker)
// ---------------------------------------------------------------------------

/**
 * `GET /encoding/inputs` returns the POLYMORPHIC union discriminated by
 * `type`, so every item still carries its own connection fields
 * (`bucketName`, `host`, `accessKey`, …) — see C24. The allowlist is therefore
 * deliberately narrow: identity (`id`/`name`) plus the discriminator, which is
 * the one field that tells an operator an S3 input from an RTMP one.
 */
export function sanitizeInput(raw: unknown): UnknownRecord {
	return pick(raw, ["id", "name", "type"]);
}

// ---------------------------------------------------------------------------
// Wire DTOs for the client panels
// ---------------------------------------------------------------------------

export type EsamSignalDto = { offset?: string; binary: string };

export type InsertableContentDto = {
	id: string;
	name?: string;
	description?: string;
	status?: InsertableContentStatus;
	inputs?: { inputId?: string; inputPath?: string; description?: string }[];
	createdAt?: string;
};

export type ScheduledContentDto = {
	id: string;
	name?: string;
	contentId?: string;
	runAt?: string;
	durationInSeconds?: number;
	status?: ScheduledContentStatus;
};

export type StreamKeyDto = {
	id: string;
	name?: string;
	description?: string;
	value?: string;
	status?: StreamKeyStatus;
	type?: StreamKeyType;
	assignedEncodingId?: string;
	assignedIngestPointId?: string;
};

export type DnsMappingDto = {
	id: string;
	name?: string;
	subdomain?: string;
	hostname?: string;
	encodingId?: string;
	ip?: string;
};

export type StandbyPoolDto = {
	id: string;
	name?: string;
	description?: string;
	targetPoolSize?: number;
	readyEncodings?: number;
	preparingEncodings?: number;
	errorEncodings?: number;
	encodingTemplateName?: string;
	poolStatus?: StandbyPoolStatus;
};

export type StandbyPoolDetailsDto = StandbyPoolDto & {
	encodingTemplate?: string;
	encodingTemplateText?: string;
};

export type StandbyPoolEncodingDto = {
	id: string;
	encodingId?: string;
	status?: StandbyPoolEncodingStatus;
	createdAt?: string;
	ingestPoints?: { streamBaseUrl?: string; streamKey?: string }[];
	manifests?: { url?: string; manifestId?: string; type?: string }[];
};

export type StandbyPoolLogDto = {
	id: string;
	standbyPoolEncodingId?: string;
	createdAt?: string;
	message?: string;
	details?: string;
	eventType?: StandbyPoolLogType;
};

export type RtmpInputDto = { id: string; name?: string };

/** One Bitmovin Input resource of ANY type (`type` is the SDK discriminator). */
export type InputDto = { id: string; name?: string; type?: string };

/**
 * Drained input list (`GET /api/live/inputs`): a picker cannot paginate a
 * radio list, so the route walks every C6 page itself. `truncated` is true
 * when the account has more inputs than the route's safety cap — the UI must
 * then say so instead of implying the list is complete.
 */
export type InputListDto = {
	items: InputDto[];
	totalCount?: number;
	truncated?: boolean;
};

/* ---------------------------------------------------------------- *
 * Live schedules  — app-side one-shot rows fired by
 * the worker sweep, NOT Bitmovin's runAt (which needs a RUNNING
 * channel; these rows survive provisioning either way).
 * ---------------------------------------------------------------- */

export const LIVE_SCHEDULE_ACTIONS = [
	"START",
	"STOP",
	"SLATE_IN",
	//  — created by the schedule deriver only; the manual arm
	// form deliberately offers the first three.
	"FEEDER_START",
	"FEEDER_SWITCH",
] as const;
export type LiveScheduleActionKind = (typeof LIVE_SCHEDULE_ACTIONS)[number];

export const LIVE_SCHEDULE_STATUSES = [
	"ARMED",
	"FIRED",
	"COMPLETED",
	"CANCELED",
	"MISSED",
	"ERROR",
	// : the row was armed for a DIFFERENT airing than the one on the
	// air now, so the sweep refused it rather than firing it. Terminal, and
	// deliberately NOT an ERROR — nothing malfunctioned.
	"SKIPPED_STALE_GENERATION",
] as const;
export type LiveScheduleStatusKind = (typeof LIVE_SCHEDULE_STATUSES)[number];

/* Schedule status records dispatch; outcome records delivery evidence. PENDING and UNKNOWN are unconfirmed. PROCESS_PUSHING reports local sending, INGEST_CONNECTED requires fresh provider input evidence, and SLATE_ARMED records a reservation without claiming playback. Exhaustive arrays keep tones and messages aligned with the wire schema. */
export const LIVE_SCHEDULE_OUTCOMES = [
	"PENDING",
	"PROCESS_PUSHING",
	"INGEST_CONNECTED",
	"SLATE_ARMED",
	"DELIVERED",
	"FAILED",
	"UNKNOWN",
] as const;
export type LiveScheduleOutcomeKind = (typeof LIVE_SCHEDULE_OUTCOMES)[number];

export const CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION = 1;
export const LIVE_SCHEDULE_OUTCOME_EVIDENCE_KINDS = [
	"PROVIDER_RUNNING",
	"PROVIDER_TERMINAL",
	"PROVIDER_STATUS_UNKNOWN",
	"HEARTBEAT_INGEST_CONNECTED",
	"FEEDER_PROCESS_PUSHING",
	"SLATE_ARMED",
	"EFFECT_FAILED",
	"JOB_TERMINAL_UNKNOWN",
	"STALE_GENERATION_REFUSAL",
] as const;
export type LiveScheduleOutcomeEvidenceKind =
	(typeof LIVE_SCHEDULE_OUTCOME_EVIDENCE_KINDS)[number];

const CURRENT_EVIDENCE_FOR_OUTCOME: Record<
	Exclude<LiveScheduleOutcomeKind, "PENDING">,
	readonly LiveScheduleOutcomeEvidenceKind[]
> = {
	PROCESS_PUSHING: ["FEEDER_PROCESS_PUSHING"],
	INGEST_CONNECTED: ["HEARTBEAT_INGEST_CONNECTED"],
	SLATE_ARMED: ["SLATE_ARMED"],
	DELIVERED: ["PROVIDER_RUNNING", "PROVIDER_TERMINAL"],
	FAILED: ["EFFECT_FAILED", "STALE_GENERATION_REFUSAL"],
	UNKNOWN: ["PROVIDER_STATUS_UNKNOWN", "JOB_TERMINAL_UNKNOWN"],
};

/* Arm SLATE_IN only with ready content belonging to the current encoding and a validated duration. The route verifies content state using the account ID; the duration cap matches the core insertion schema. */
export const liveScheduleArmSchema = z
	.strictObject({
		action: z.enum(LIVE_SCHEDULE_ACTIONS),
		// No custom message: zod's invalid_format default goes through the
		// zerr.z* CODE map, which translates — an authored sentence here
		// would be invisible to the totality regex (datetime is not in its
		// validator alternation) and render raw English under ja.
		// Optional since #160 PR3: an auto-lead arm derives fireAt from
		// airAt − lead at the route; the superRefine below still demands it
		// on every non-auto arm.
		fireAt: z.iso.datetime().optional(),
		bitmovinAccountId: z.uuid().optional(),
		insertableContentId: z.uuid().optional(),
		// 24h ceiling, matching scheduleContentCreateSchema and the queue
		// params schema (review-190 I5 — one Bitmovin field, one bound).
		slateDurationSeconds: z.number().int().min(1).max(86_400).optional(),
		// Optional intended broadcast start time,
		// distinct from fireAt on purpose: fireAt is when WE act, airAt is
		// when the program must be on air; the sweep alerts at airAt − margin
		// if the channel is not RUNNING.
		airAt: z.iso.datetime().optional(),
		deadlineMarginSeconds: z.number().int().min(30).max(3600).optional(),
		// #160 PR3: resolve fireAt from airAt − (P90 + margin) at arm time.
		autoLeadTime: z.boolean().optional(),
	})
	.superRefine((value, ctx) => {
		if (!value.autoLeadTime && value.fireAt === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["fireAt"],
				message: "Fire time is required unless auto-lead derives it",
			});
		}
		if (value.autoLeadTime && value.action !== "START") {
			ctx.addIssue({
				code: "custom",
				path: ["autoLeadTime"],
				message: "Auto-lead only applies to START schedules",
			});
		}
		if (value.autoLeadTime && value.airAt === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["airAt"],
				message: "Auto-lead needs an air time to derive from",
			});
		}
		if (value.action !== "START" && value.airAt !== undefined) {
			// The deadline scan only reads START rows — an airAt on any other
			// action would arm a check that can never run.
			ctx.addIssue({
				code: "custom",
				path: ["airAt"],
				message: "Air-time deadlines only apply to START schedules",
			});
		}
		if (
			value.airAt !== undefined &&
			value.fireAt !== undefined &&
			Date.parse(value.airAt) <= Date.parse(value.fireAt)
		) {
			// review-8eaef21 #2: an airAt at or before fireAt arms a deadline
			// that is already expired when the start command runs — the next
			// sweep tick would false-alert before anything had a chance to
			// happen. fireAt > now is enforced by the route, so airAt > fireAt
			// also keeps the deadline in the future.
			ctx.addIssue({
				code: "custom",
				path: ["airAt"],
				message: "Air time must be after the fire time",
			});
		}
		if (value.action === "FEEDER_START" || value.action === "FEEDER_SWITCH") {
			// review-226 I3: widening LIVE_SCHEDULE_ACTIONS for display also
			// widened THIS schema — a manual arm of a feeder row would create
			// a source-less row the sweep can only ERROR. Schedule-derived
			// only, as row 96 records.
			ctx.addIssue({
				code: "custom",
				path: ["action"],
				message:
					"Feeder rows are derived by the program schedule at creation — they cannot be armed manually",
			});
		}
		if (value.action === "SLATE_IN") {
			if (!value.insertableContentId) {
				ctx.addIssue({
					code: "custom",
					path: ["insertableContentId"],
					message: "Slate schedules need insertable content",
				});
			}
			if (!value.slateDurationSeconds) {
				ctx.addIssue({
					code: "custom",
					path: ["slateDurationSeconds"],
					message: "Slate schedules need a duration",
				});
			}
			if (!value.bitmovinAccountId) {
				ctx.addIssue({
					code: "custom",
					path: ["bitmovinAccountId"],
					message: "Slate schedules need the Bitmovin account",
				});
			}
			return;
		}
		if (value.insertableContentId || value.slateDurationSeconds) {
			ctx.addIssue({
				code: "custom",
				path: ["insertableContentId"],
				message: "Content fields apply to SLATE_IN only",
			});
		}
	});

export type LiveScheduleDto = {
	id: string;
	action: LiveScheduleActionKind;
	fireAt: string;
	status: LiveScheduleStatusKind;
	insertableContentId: string | null;
	slateDurationSeconds: number | null;
	firedAt: string | null;
	note: string | null;
	error: string | null;
	/**
	 *  — the delivery verdict and its evidence. Optional on the
	 * type so a response from a server that predates the column still parses;
	 * the panel treats an absent value exactly like PENDING, which is the same
	 * amber "not confirmed" and never a green.
	 */
	outcome?: LiveScheduleOutcomeKind;
	outcomeAt?: string | null;
	outcomeNote?: string | null;
	outcomeEvidenceVersion?: number | null;
	outcomeEvidenceKind?: LiveScheduleOutcomeEvidenceKind | null;
	outcomeEvidenceAt?: string | null;
	/**  PR2 — the air-time deadline pair (START rows only). */
	airAt?: string | null;
	deadlineMarginSeconds?: number;
	deadlineNotifiedAt?: string | null;
	/**
	 *  — a FEEDER_SWITCH row's two phases: `stagedAt` is the sweep's
	 * pre-stage claim (fireAt − lead), `readyAt` the moment the staged source
	 * was downloaded, probed and gated, and `switchSeamMs` the measured seam
	 * once the switch committed (old push gone → new push spawned). Optional,
	 * like the outcome pair, for a server that predates the columns.
	 */
	stagedAt?: string | null;
	readyAt?: string | null;
	switchSeamMs?: number | null;
	/**
	 * rev367 S-2 — the staged session's LIVE phase, attached by the route for
	 * rows that name one. `readyAt` above is a write-once RECORD; a takeover
	 * re-stages the session without touching it, so the chip must read THIS.
	 * `null` = the row names a session that no longer exists; absent = no
	 * session staged yet, or a server that predates the join.
	 */
	stagedSession?: {
		id: string;
		status: string;
		commitAt: string | null;
		readyAt: string | null;
		committedAt: string | null;
	} | null;
	createdAt: string;
};

/**
 * A positive schedule colour is allowed only when its outcome carries
 * current, semantically matching evidence. Legacy rows are deliberately
 * fail-closed: they remain visible, but cannot be mistaken for runtime proof.
 */
export function hasCurrentScheduleOutcomeEvidence(
	row: Pick<
		LiveScheduleDto,
		| "outcome"
		| "outcomeEvidenceVersion"
		| "outcomeEvidenceKind"
		| "outcomeEvidenceAt"
	>,
): boolean {
	const outcome = row.outcome;
	if (
		outcome === undefined ||
		outcome === "PENDING" ||
		row.outcomeEvidenceVersion !== CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION ||
		row.outcomeEvidenceKind == null ||
		row.outcomeEvidenceAt == null ||
		Number.isNaN(Date.parse(row.outcomeEvidenceAt))
	) {
		return false;
	}
	return CURRENT_EVIDENCE_FOR_OUTCOME[outcome].includes(
		row.outcomeEvidenceKind,
	);
}
