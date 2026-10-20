import { z } from "zod";
import { vmafExecutionSchema } from "../vmaf/cloud";
import { audioMixStreamSchema } from "./audio-mix";
import { internalHevcV2Schema } from "./internal-hevc-v2";
import {
	audioVolumeFilterSchema,
	cropFilterSchema,
	denoiseHqdn3dFilterSchema,
	ebuR128FilterSchema,
	rotateFilterSchema,
	textFilterSchema,
	unsharpFilterSchema,
	watermarkFilterSchema,
} from "./media-filters";
import { qcGateSchema } from "./qc-gate";
import { SRT_CHARACTER_ENCODINGS } from "./srt-character-encodings";

/**
 * EncodingPlan v1 — the single zod-validated JSON every encoding flows
 * through (ARCHITECTURE §3). P1 scope: S3 input, S3/SFTP outputs, ingest
 * streams, H264+AAC renditions, fMP4 muxings, sample-style HLS/DASH
 * manifests, JIT/post generation. Field surface mirrors the encoding examples
 * fixed-bitrate family (the acceptance fixtures) and widens per phase.
 *
 * Secrets NEVER appear in a plan: inputs/outputs reference vault
 * credentials by id; the orchestrator resolves them at execution time.
 *
 * Evolution contract: objects are strict (unknown keys reject — plans are
 * hand-editable presets, typos must not silently change encodes). Jobs
 * persist the PARSED plan (defaults materialized at save time) and the
 * orchestrator replays its persisted compiled ops — defaults changing in a
 * later release never alters an in-flight or resumed job.
 */

export const PLAN_VERSION = 1;

/**
 * Audio rendition codecs. Shared by the validator's HLS-media and Kantar
 * rails and by the compiler's per-encoding Kantar fan-out — "does this
 * encoding carry audio?" must be answered identically in both places.
 */
export const AUDIO_CODECS = new Set([
	"AAC",
	"OPUS",
	"DOLBY_ATMOS",
	"DDPLUS",
	"DD",
]);

/**
 * A destination a VAULTED SECRET travels to: the encoder POSTs credentials
 * we decrypt at execution time to whatever host the plan names (Kantar's
 * `serverUrl`, ESAM's `poisEndpoint`). Two rails, both cheap:
 *
 *  - must PARSE as a URL — a bare string let a typo become a silent failure
 *    at the encoder instead of a validation error here;
 *  - must be **https** — with plain http the pair crosses the network in
 *    cleartext. That needs no attacker: a copy-pasted plan or a vendor doc
 *    showing an http example is enough (review catch, P5 PR-4 follow-up).
 *
 * Deliberately NOT applied to plan fields that merely contain a URL (output
 * paths, webhook targets): there the plan author names a CREDENTIAL, not a
 * host, so no secret follows the URL. Scope this by "does a vaulted secret
 * egress here", and the next vendor integration inherits the rail.
 */
export const secretEgressUrlSchema = z
	.string()
	.min(1)
	.url("Must be a valid URL")
	.refine((value) => value.toLowerCase().startsWith("https://"), {
		message:
			"Must use https — this endpoint receives vaulted credentials, and http would transmit them in cleartext",
	})
	// No URL userinfo. A credential entering the field by THIS door breaks the
	// invariant everything downstream relies on: `Job.plan` is persisted RAW
	// (no redactSecrets) precisely because plans are secret-free BY
	// CONSTRUCTION, so `https://user:pass@host` would sit in plaintext in the
	// job row, in saved preset bodies, in the diff-vs-preset panel and in the
	// YAML template export. redactSecrets masks userinfo in audit rows and step
	// logs, so those paths are covered — the plan row is not, because it is
	// trusted not to need it (review catch).
	.refine(
		(value) => {
			try {
				const url = new URL(value);
				return url.username === "" && url.password === "";
			} catch {
				return true; // .url above already reported the parse failure
			}
		},
		{
			message:
				"Must not embed credentials in the URL (user:pass@host) — plans are stored unredacted because they are secret-free by construction; keep the login in a vault credential and reference it by id",
		},
	);

/** Local cross-reference key inside one plan. */
const refKey = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/, "Keys are [a-zA-Z0-9_-]");

export const planInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		key: refKey,
		kind: z.literal("S3"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		name: z.string().min(1).default("S3 Input"),
	}),
	z.strictObject({
		key: refKey,
		// Auth-free https host (the dolby https-input sample) — the only
		// credential-less input kind.
		kind: z.literal("HTTPS"),
		host: z.string().min(1),
		name: z.string().min(1).default("HTTPS Input"),
	}),
	z.strictObject({
		key: refKey,
		/**
		 * Akamai NetStorage as a SOURCE . The owner's Akamai-only
		 * profile needs both directions — a customer whose mezzanines already
		 * live in NetStorage should not have to stage them elsewhere first.
		 *
		 * No bucket, for the same reason as the output: the upload account is
		 * the container.
		 */
		kind: z.literal("AKAMAI_NETSTORAGE"),
		credentialId: z.uuid(),
		name: z.string().min(1).default("Akamai NetStorage Input"),
	}),
	z.strictObject({
		key: refKey,
		// Azure Blob: account name/key live in the AZURE_BLOB vault
		// credential; the plan carries only the container.
		kind: z.literal("AZURE"),
		credentialId: z.uuid(),
		container: z.string().min(1),
		name: z.string().min(1).default("Azure Input"),
	}),
	z.strictObject({
		key: refKey,
		// S3-compatible input backing AKAMAI_OBJECT_STORAGE / OCI_OBJECT_STORAGE
		// / GENERIC_S3 credentials (C10 — all three map to GenericS3 with V4
		// signing). The plan carries only the bucket; host/port/ssl/keys resolve
		// from the credential at execution (Akamai host = config.host, OCI host =
		// ociCompatHost(namespace, region), GenericS3 host = config.host).
		kind: z.literal("GENERIC_S3"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		name: z.string().min(1).default("Generic S3 Input"),
	}),
	z.strictObject({
		key: refKey,
		// Google Cloud Storage via HMAC keys (GCS_HMAC credential). `region` is
		// an optional GoogleCloudRegion NAME; absent = the API default.
		kind: z.literal("GCS"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		region: z.string().min(1).optional(),
		name: z.string().min(1).default("GCS Input"),
	}),
	z.strictObject({
		key: refKey,
		// Google Cloud Storage via a service-account key JSON
		// (GCS_SERVICE_ACCOUNT credential). The JSON is vault material resolved
		// at execution; the plan carries only the bucket (+ optional region).
		kind: z.literal("GCS_SERVICE_ACCOUNT"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		region: z.string().min(1).optional(),
		name: z.string().min(1).default("GCS Service Account Input"),
	}),
]);

/**
 * Akamai MSL stream formats, and the encoding shape each one demands (C31):
 *   DASH — fMP4 or CMAF muxings AND a DASH manifest
 *   HLS  — TS muxings AND an HLS manifest
 *   CMAF — fMP4 or CMAF muxings AND both DASH and HLS manifests
 */
export const akamaiMslStreamFormatSchema = z.enum(["DASH", "HLS", "CMAF"]);
export type AkamaiMslStreamFormat = z.infer<typeof akamaiMslStreamFormatSchema>;

/**
 * ONE member today, and that is the point of the enum existing at all.
 *
 * The SDK's own prose is where this tracks, and it MOVED on 2026-08-27: 1.269.0
 * said "Only MSL4 is supported at the moment"; 1.278.0 — the version this repo
 * now pins — says "MSL4 and MSL5 are supported", and `AkamaiMslVersion` is
 * `{ MSL4, MSL5 }`. So the vendor half of the bet has landed and this const is
 * the deliberate remaining half: PR 1 of  adds `"MSL5"` here, which
 * is the one edit that makes an MSL5 plan expressible. Until then the parser is
 * what refuses MSL5 — and it is the ONLY thing refusing it, since the pre-GA
 * experimental gate retired with the GA it was waiting for.  carries
 * the original row.
 */
/**
 * THE single MSL version universe (review-161-162 M7): the zod enum that
 * decides whether an MSL5 plan can EXIST derives from this const, and
 * akamai-msl-constraint's exhaustive behavior Record is keyed on the same
 * type — so Track 2b's one edit HERE widens the schema and turns the
 * constraint's Record red until its row is added. The previous shape kept
 * two hand-maintained lists; the anchor watched one while the schema
 * decided reality with the other.
 */
export const AKAMAI_MSL_VERSIONS = ["MSL4", "MSL5"] as const;
export const akamaiMslVersionSchema = z.enum(AKAMAI_MSL_VERSIONS);
export type AkamaiMslVersion = z.infer<typeof akamaiMslVersionSchema>;

export const planOutputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		key: refKey,
		kind: z.literal("LIVE_MEDIA_INGEST"),
		credentialId: z.uuid(),
		scte35Passthrough: z.boolean().optional(),
		name: z.string().min(1).default("Live Media Ingest Output"),
	}),
	z.strictObject({
		key: refKey,
		kind: z.literal("S3"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		name: z.string().min(1).default("S3 Output"),
	}),
	z.strictObject({
		key: refKey,
		kind: z.literal("AZURE"),
		credentialId: z.uuid(),
		container: z.string().min(1),
		name: z.string().min(1).default("Azure Output"),
	}),
	z.strictObject({
		key: refKey,
		kind: z.literal("SFTP"),
		// Host/port/username/password live in an SFTP vault credential
		// (P1 decision — encoding examples passes them inline, we never do).
		credentialId: z.uuid(),
		name: z.string().min(1).default("SFTP Output"),
	}),
	z.strictObject({
		key: refKey,
		/**
		 * Akamai NetStorage . Host, username and password live in
		 * an AKAMAI_NETSTORAGE vault credential — the same discipline as SFTP,
		 * and for the same reason: the SDK model takes them inline and we never
		 * put a password in a plan.
		 *
		 * No bucket field, because NetStorage has none: the upload account IS
		 * the container and paths hang off its CP code directory. Not to be
		 * confused with AKAMAI_OBJECT_STORAGE, which is Linode S3-compatible
		 * storage reached as GENERIC_S3 (C10) — same vendor, other protocol.
		 */
		kind: z.literal("AKAMAI_NETSTORAGE"),
		credentialId: z.uuid(),
		name: z.string().min(1).default("Akamai NetStorage Output"),
	}),
	z.strictObject({
		key: refKey,
		// S3-compatible output backing AKAMAI_OBJECT_STORAGE / OCI_OBJECT_STORAGE
		// / GENERIC_S3 credentials (C10). Per-title outputs are allowed here (C4
		// lists GenericS3 as a valid per-title target). Host/keys resolve from
		// the credential at execution, exactly like the GENERIC_S3 input.
		kind: z.literal("GENERIC_S3"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		name: z.string().min(1).default("Generic S3 Output"),
	}),
	z.strictObject({
		key: refKey,
		// Google Cloud Storage via HMAC keys (GCS_HMAC credential). C4 lists GCS
		// as a valid per-title output target.
		kind: z.literal("GCS"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		region: z.string().min(1).optional(),
		name: z.string().min(1).default("GCS Output"),
	}),
	z.strictObject({
		key: refKey,
		/**
		 * Akamai Media Services Live . MSL authenticates by the
		 * stream id and event name Akamai provisioned rather than by bucket
		 * keys; those are customer-identifying rather than secret, and ride the
		 * same redaction path as everything else in snapshots. They live in a
		 * credential all the same — see `credentialId` below, which the 2026-08-19
		 * remodel made REQUIRED. (This comment claimed MSL was "the ONLY output
		 * with no credentialId" until 2026-08-25, describing the shape the
		 * remodel replaced.)
		 */
		kind: z.literal("AKAMAI_MSL"),
		/**
		 * The stream id and event name live in an `AKAMAI_MSL` vault credential
		 * : you cannot
		 * obtain either without an Akamai account, which makes them
		 * account-scoped provisioning facts rather than plan literals. Carrying
		 * a credential id here is also what puts MSL back on the same footing
		 * as every other output — the output step is credential-first, and
		 * being the exception is what made it unreachable to begin with.
		 */
		credentialId: z.uuid(),
		/**
		 * Stays in the PLAN, deliberately. NOT a label: C31. Each value
		 * constrains the muxings and manifests the encoding must carry, and
		 * Bitmovin rejects a mismatch with a message about muxings that an
		 * operator cannot trace back to this field. Fixing it to the credential
		 * would stop one provisioned stream from serving more than one
		 * topology.
		 */
		streamFormat: akamaiMslStreamFormatSchema,
		mslVersion: akamaiMslVersionSchema.default("MSL4"),
		name: z.string().min(1).default("Akamai MSL Output"),
	}),
	z.strictObject({
		key: refKey,
		// Google Cloud Storage via a service-account key JSON
		// (GCS_SERVICE_ACCOUNT credential).
		kind: z.literal("GCS_SERVICE_ACCOUNT"),
		credentialId: z.uuid(),
		bucket: z.string().min(1),
		region: z.string().min(1).optional(),
		name: z.string().min(1).default("GCS Service Account Output"),
	}),
]);

/** Plan input/output discriminated-union members (host/keys are vault refs). */
export type PlanInput = z.infer<typeof planInputSchema>;
export type PlanOutput = z.infer<typeof planOutputSchema>;

export const streamSelectionModeSchema = z.enum([
	"AUTO",
	"POSITION_ABSOLUTE",
	"VIDEO_RELATIVE",
	"AUDIO_RELATIVE",
]);

export const ingestStreamSchema = z.strictObject({
	key: refKey,
	inputKey: refKey,
	inputPath: z.string().min(1),
	selectionMode: streamSelectionModeSchema,
	position: z.number().int().min(0).default(0),
	/** Multi-encoding plans (Dolby ladders): absent = the implicit encoding. */
	encodingKey: refKey.optional(),
});

/**
 * FileInputStream — whole-file sidecar inputs (WebVTT subtitles in the
 * webvtt samples). Keys share the rendition `ingestKey` namespace with
 * `ingest`, so cross-collection uniqueness is validated.
 */
export const fileStreamSchema = z.strictObject({
	key: refKey,
	inputKey: refKey,
	inputPath: z.string().min(1),
	fileType: z.enum(["WEBVTT", "TTML"]),
	encodingKey: refKey.optional(),
});

/**
 * Dolby input streams (ATMOS masters, VISION video+metadata, standalone
 * VISION_METADATA sidecars for the separated-metadata flow). Keys share
 * the rendition `ingestKey` namespace.
 */
export const dolbyStreamSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		key: refKey,
		kind: z.literal("ATMOS"),
		inputKey: refKey,
		inputPath: z.string().min(1),
		inputFormat: z.enum(["DAMF", "ADM", "MXF"]),
		encodingKey: refKey.optional(),
	}),
	z.strictObject({
		key: refKey,
		kind: z.literal("VISION"),
		inputKey: refKey,
		videoInputPath: z.string().min(1),
		/** Absent = metadata embedded in the container. */
		metadataInputPath: z.string().min(1).optional(),
		encodingKey: refKey.optional(),
	}),
	z.strictObject({
		key: refKey,
		kind: z.literal("VISION_METADATA"),
		inputKey: refKey,
		inputPath: z.string().min(1),
		encodingKey: refKey.optional(),
	}),
]);

/**
 * Input-stream TRIMMING (the modern, resource-based path — independent of
 * the start-request `trimming` field and constraint C2, which governs
 * start-request trimming and stays deferred). A trimming input stream is an
 * INTERMEDIATE stream: it wraps another input stream (`sourceKey`, in the
 * shared ingest-key namespace) and a rendition then references the trim's
 * own `key`. Three SDK variants (TimeBased offset/duration in seconds,
 * TimecodeTrack SMPTE-12M strings, H264PictureTiming SEI strings).
 *
 * Keys share the rendition `ingestKey` namespace with ingest/file/dolby, so
 * cross-collection uniqueness is validated; `sourceKey` must resolve to a
 * declared input-stream key, and the compiler emits these AFTER the streams
 * they wrap (backward-refs-only invariant).
 */
export const trimmingStreamSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		key: refKey,
		kind: z.literal("TIME_BASED"),
		/** Input-stream key to trim (ingest/file/dolby/another trim). */
		sourceKey: refKey,
		/** Seconds from 0; the indicated frame is included. */
		offset: z.number().min(0).optional(),
		/** Seconds to encode; absent = remaining input after offset. */
		duration: z.number().positive().optional(),
		encodingKey: refKey.optional(),
	}),
	z.strictObject({
		key: refKey,
		kind: z.literal("TIMECODE_TRACK"),
		sourceKey: refKey,
		/** SMPTE-12M start timecode (inclusive). */
		startTimeCode: z.string().min(1).optional(),
		/** SMPTE-12M end timecode (inclusive). */
		endTimeCode: z.string().min(1).optional(),
		encodingKey: refKey.optional(),
	}),
	z.strictObject({
		key: refKey,
		kind: z.literal("H264_PICTURE_TIMING"),
		sourceKey: refKey,
		/** H264 SEI picture timing start (inclusive). */
		startPicTiming: z.string().min(1).optional(),
		/** H264 SEI picture timing end (inclusive). */
		endPicTiming: z.string().min(1).optional(),
		encodingKey: refKey.optional(),
	}),
]);

/** PaddingDurationUnit (SDK 1.269) — black-frame/silence padding unit. */
export const paddingSequenceSchema = z.strictObject({
	duration: z.number().min(0),
	unit: z.enum(["SECONDS", "FRAMES"]).optional(),
});

/** One concatenated part — references an input stream and orders it. */
export const concatenationSourceSchema = z.strictObject({
	/** Input-stream key to concatenate (ingest or a trimming stream). */
	sourceKey: refKey,
	/** Exactly one source per concatenation must be the main (reference). */
	isMain: z.boolean().optional(),
	/** Unique integer determining concatenation order. */
	position: z.number().int().optional(),
	paddingBefore: paddingSequenceSchema.optional(),
	paddingAfter: paddingSequenceSchema.optional(),
	/** AspectMode when adapting to the main stream's aspect ratio. */
	aspectMode: z.enum(["PAD", "CROP", "STRETCH"]).optional(),
});

/**
 * Input-stream CONCATENATION: stitches an ordered list of input streams
 * (ingest or trimming) into one intermediate stream a rendition references
 * by `key`. Each source's `sourceKey` lives in the shared namespace; the
 * validator requires ≥1 source and exactly one `isMain: true`.
 */
export const concatenationStreamSchema = z.strictObject({
	key: refKey,
	sources: z.array(concatenationSourceSchema).min(1),
	encodingKey: refKey.optional(),
});

export type TrimmingStream = z.infer<typeof trimmingStreamSchema>;
export type PaddingSequence = z.infer<typeof paddingSequenceSchema>;
export type ConcatenationSource = z.infer<typeof concatenationSourceSchema>;
export type ConcatenationStream = z.infer<typeof concatenationStreamSchema>;

/** Single condition in P1; becomes an AND/OR tree union in P2. */
export const streamConditionSchema = z.strictObject({
	attribute: z.string().min(1),
	operator: z.enum([
		"EQUAL",
		"NOT_EQUAL",
		"LESS_THAN",
		"LESS_THAN_OR_EQUAL",
		"GREATER_THAN",
		"GREATER_THAN_OR_EQUAL",
	]),
	value: z.string(),
});

/** Per-stream filter attachment (streams.filters.create order matters). */
export const streamFilterRefSchema = z.strictObject({
	filterKey: refKey,
	position: z.number().int().min(0),
});

/**
 * SDK ColorConfig passthrough (copy flags or explicit BT.709/BT.2020/PQ
 * values) — enum-NAME strings; wire values are identical.
 */
export const colorConfigSchema = z.strictObject({
	copyColorPrimariesFlag: z.boolean().optional(),
	copyColorTransferFlag: z.boolean().optional(),
	copyColorSpaceFlag: z.boolean().optional(),
	copyChromaLocationFlag: z.boolean().optional(),
	copyColorRangeFlag: z.boolean().optional(),
	colorSpace: z.string().optional(),
	colorPrimaries: z.string().optional(),
	colorTransfer: z.string().optional(),
});

/** Stream modes — per-title templates expand at run time (C1). */
export const streamModeSchema = z.enum([
	"STANDARD",
	"PER_TITLE_TEMPLATE",
	"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
	"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
]);

/** StreamPerTitleSettings.fixedResolutionAndBitrateSettings (flat here). */
export const perTitleStreamSettingsSchema = z.strictObject({
	minBitrate: z.number().int().positive().optional(),
	maxBitrate: z.number().int().positive().optional(),
	bitrateSelectionMode: z.enum(["OPTIMIZED", "COMPLEXITY_RANGE"]).optional(),
	lowComplexityBoundaryForMaxBitrate: z.number().int().positive().optional(),
	highComplexityBoundaryForMaxBitrate: z.number().int().positive().optional(),
});

/**
 * Nagra NexGuard forensic watermarking (stream-level). The license is
 * vault material (NEXGUARD credential); preset/type/strength are plan
 * configuration.
 */
export const nexGuardSchema = z.strictObject({
	credentialId: z.uuid(),
	watermarkType: z.enum(["OTT", "DUPLICATED"]),
	preset: z.string().min(1),
	strength: z
		.enum(["LIGHTEST", "LIGHTER", "DEFAULT", "STRONGER", "STRONGEST"])
		.default("DEFAULT"),
	/**
	 * NGPR asset payload ID, 1..4,194,303 (the SDK's documented range) —
	 * the operator must mint one per asset and keep their own record;
	 * neither Nagra nor Bitmovin tracks it. The wire below (compiler op →
	 * executor → sdk-ops) already carried this field; the schema was the
	 * one layer dropping it .
	 */
	payload: z.number().int().min(1).max(4_194_303).optional(),
});

/**
 * Stream-level DolbyVision metadata attach (separated-metadata flow):
 * streams.hdr.dolby_vision with a VISION_METADATA dolbyStream source.
 */
export const dolbyVisionMetadataSchema = z
	.strictObject({
		profile: z.enum(["DVHE_04", "DVHE_05", "DVHE_07", "HEV1_08", "AVC3_09"]),
		metadataSource: z.enum(["INPUT_STREAM", "EMBEDDED"]),
		/** VISION_METADATA dolbyStream key (when metadataSource INPUT_STREAM). */
		metadataStreamKey: refKey.optional(),
	})
	.superRefine((value, ctx) => {
		// INPUT_STREAM without a sidecar would compile an HDR attach with no
		// metadata input stream id; EMBEDDED with one would silently drop it.
		if (value.metadataSource === "INPUT_STREAM" && !value.metadataStreamKey) {
			ctx.addIssue({
				code: "custom",
				message: "metadataSource INPUT_STREAM requires metadataStreamKey",
				path: ["metadataStreamKey"],
			});
		}
		if (value.metadataSource === "EMBEDDED" && value.metadataStreamKey) {
			ctx.addIssue({
				code: "custom",
				message: "metadataSource EMBEDDED must not set metadataStreamKey",
				path: ["metadataStreamKey"],
			});
		}
	});

/** HLS audio-group placement for a rendition's media entry. */
export const hlsMediaOverrideSchema = z.strictObject({
	groupId: z.string().min(1),
	name: z.string().min(1),
	uri: z.string().min(1),
	isDefault: z.boolean().optional(),
	autoselect: z.boolean().optional(),
});

/** Supported SRT character encodings (SDK enum names, mapped at the worker). */
export const srtCharacterEncodingSchema = z.enum(SRT_CHARACTER_ENCODINGS);
export const burnInSrtSchema = z.strictObject({
	inputKey: refKey,
	inputPath: z.string().min(1),
	characterEncoding: srtCharacterEncodingSchema,
});

const renditionBase = {
	burnInSrt: burnInSrtSchema.optional(),
	key: refKey,
	ingestKey: refKey,
	conditions: streamConditionSchema.optional(),
	/** Overrides the computed Stream resource name (sample fidelity). */
	streamName: z.string().optional(),
	filters: z.array(streamFilterRefSchema).optional(),
	nexguard: nexGuardSchema.optional(),
	/** Multi-encoding plans: absent = the implicit encoding. */
	encodingKey: refKey.optional(),
	hlsMedia: hlsMediaOverrideSchema.optional(),
	/** Variant uri label in variantsPerAudioGroup mode (dv81/sdr/dv…). */
	hlsVariantLabel: z.string().optional(),
	/** Explicit DASH adaptation-set membership (multi-set manifests). */
	dashSetKey: refKey.optional(),
};

const codecEncodingModeSchema = z.enum([
	"STANDARD",
	"SINGLE_PASS",
	"TWO_PASS",
	"THREE_PASS",
	"SMART_PASS",
]);

export const h264RenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("H264"),
	encodingMode: codecEncodingModeSchema.optional(),
	/** Codec-config display name (sample default kept for golden fidelity). */
	name: z.string().default("Sample video codec configuration"),
	/** Explicit output width; omitted legacy plans still inherit input aspect. */
	width: z.number().int().positive().optional(),
	crf: z.number().min(0).max(51).optional(),
	minBitrate: z.number().int().nonnegative().optional(),
	maxBitrate: z.number().int().nonnegative().optional(),
	bufsize: z.number().int().nonnegative().optional(),
	/** AISA per-title template passes height=None too — nullable like bitrate. */
	height: z.number().int().positive().nullable(),
	/** Per-title templates leave bitrate to the algorithm (null). */
	bitrate: z.number().int().positive().nullable(),
	/** Sample passes level=None explicitly — nullable, not optional. */
	level: z.string().nullable().default(null),
	presetConfiguration: z.string().nullable().default("VOD_HIGH_QUALITY"),
	mode: streamModeSchema.default("STANDARD"),
	/** ProfileH264 (closed set, SDK 1.269); wire value = name. */
	profile: z.enum(["BASELINE", "MAIN", "HIGH", "HIGH422"]).optional(),
	/** Frame rate (fps) — keyframe-precise samples pin it. */
	rate: z.number().positive().optional(),
	minKeyframeInterval: z.number().positive().optional(),
	maxKeyframeInterval: z.number().positive().optional(),
	// Per-title tuning surface (pertitle samples set all of these).
	slices: z.number().int().positive().optional(),
	trellis: z.string().optional(),
	mvSearchRangeMax: z.number().int().positive().optional(),
	rcLookahead: z.number().int().positive().optional(),
	subMe: z.string().optional(),
	motionEstimationMethod: z.string().optional(),
	sceneCutThreshold: z.number().int().min(0).optional(),
	adaptiveQuantizationMode: z.string().optional(),
	adaptiveQuantizationStrength: z.number().optional(),
	mvPredictionMode: z.string().optional(),
	psyRateDistortionOptimization: z.number().optional(),
	psyTrellis: z.number().optional(),
	// AISA samples' codec surface (SDK 1.269 names; wire = name).
	refFrames: z.number().int().positive().optional(),
	bframes: z.number().int().min(0).optional(),
	cabac: z.boolean().optional(),
	adaptiveSpatialTransform: z.boolean().optional(),
	weightedPredictionPFrames: z.enum(["DISABLED", "SIMPLE", "SMART"]).optional(),
	colorConfig: colorConfigSchema.optional(),
	perTitleSettings: perTitleStreamSettingsSchema.optional(),
});

/** Native HEVCv2 controls; omitted values preserve provider defaults. */
export const h265V2PerceptualQualityModeConfigSchema = z.strictObject({
	type: z.literal("PERCEPTUAL_QUALITY_MODE"),
	perceptualEncodingMode: z.enum(["OFF", "CU_DELTA_QP"]).optional(),
	perceptualStrength: z.number().min(0).max(1).optional(),
	perceptualPenaltyStrength: z.number().min(0).max(1).optional(),
	perceptualPenaltyKnee: z.number().min(0).max(1).optional(),
	perceptualTemporalStrength: z.number().min(0).max(1).optional(),
	pixelPerDegree: z.number().positive().optional(),
});
export type H265V2PerceptualQualityModeConfig = z.infer<
	typeof h265V2PerceptualQualityModeConfigSchema
>;
export const h265V2QualityControlsSchema = z.strictObject({
	motionCompensatedTemporalFiltering: z.enum(["AUTO", "OFF", "ON"]).optional(),
	rateControlModeConfig: h265V2PerceptualQualityModeConfigSchema.optional(),
});
export type H265V2QualityControls = z.infer<typeof h265V2QualityControlsSchema>;

export const h265RenditionSchema = z.strictObject({
	...renditionBase,
	...h265V2QualityControlsSchema.shape,
	codec: z.literal("H265"),
	encodingMode: codecEncodingModeSchema.optional(),
	name: z.string().optional(),
	crf: z.number().min(0).max(51).optional(),
	minBitrate: z.number().int().nonnegative().optional(),
	/** HDR10 per-title template scales freely — height nullable. */
	height: z.number().int().positive().nullable(),
	bitrate: z.number().int().positive().nullable(),
	level: z.string().nullable().default(null),
	mode: streamModeSchema.default("STANDARD"),
	/** ProfileH265 (closed set, SDK 1.269); MAIN10 required for HDR10. */
	profile: z.enum(["MAIN", "MAIN10"]).optional(),
	rate: z.number().positive().nullable().optional(),
	minKeyframeInterval: z.number().positive().optional(),
	maxKeyframeInterval: z.number().positive().optional(),
	rcLookahead: z.number().int().positive().optional(),
	/** H265 sub_me is numeric (H264's is an enum name). */
	subMe: z.number().int().min(0).optional(),
	maxCtuSize: z.string().optional(),
	motionSearch: z.string().optional(),
	tuIntraDepth: z.string().optional(),
	tuInterDepth: z.string().optional(),
	weightPredictionOnPSlice: z.boolean().optional(),
	weightPredictionOnBSlice: z.boolean().optional(),
	sceneCutThreshold: z.number().int().min(0).optional(),
	motionSearchRange: z.number().int().positive().optional(),
	adaptiveQuantizationMode: z.string().optional(),
	adaptiveQuantizationStrength: z.number().optional(),
	psyRateDistortionOptimization: z.number().optional(),
	psyRateDistortionOptimizedQuantization: z.number().optional(),
	qpMin: z.number().int().min(0).optional(),
	sao: z.boolean().optional(),
	// HDR10 (ARCHITECTURE: MAIN10 + PQ + mastering metadata)
	pixelFormat: z.string().optional(),
	hdr: z.boolean().optional(),
	masterDisplay: z.string().optional(),
	maxContentLightLevel: z.number().int().positive().optional(),
	maxPictureAverageLightLevel: z.number().int().positive().optional(),
	colorConfig: colorConfigSchema.optional(),
	perTitleSettings: perTitleStreamSettingsSchema.optional(),
	// Dolby ladders (PR5): rate-control + dynamic range + preset
	presetConfiguration: z.string().optional(),
	maxBitrate: z.number().int().nonnegative().optional(),
	bufsize: z.number().int().nonnegative().optional(),
	/** false = Main-tier level signaling (DASH OnDemand sample). */
	levelHighTier: z.boolean().optional(),
	/** H265DynamicRangeFormat NAME (wire identical). */
	dynamicRangeFormat: z
		.enum([
			"DOLBY_VISION",
			"DOLBY_VISION_PROFILE_5",
			"DOLBY_VISION_PROFILE_8_1",
			"HDR10",
			"HLG",
			"SDR",
		])
		.optional(),
	dolbyVisionMetadata: dolbyVisionMetadataSchema.optional(),
});

/** Dolby Atmos audio (loudness control per the samples). */
export const atmosRenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("DOLBY_ATMOS"),
	name: z.string().optional(),
	bitrate: z.number().int().positive(),
	rate: z.number().positive(),
	loudnessControl: z
		.strictObject({
			meteringMode: z
				.enum([
					"ITU_R_BS_1770_1",
					"ITU_R_BS_1770_2",
					"ITU_R_BS_1770_3",
					"ITU_R_BS_1770_4",
					"LEQ_A",
				])
				.default("ITU_R_BS_1770_4"),
			dialogueIntelligence: z.enum(["ENABLED", "DISABLED"]).default("ENABLED"),
			speechThreshold: z.number().int().min(0).max(100).default(15),
		})
		.default({
			meteringMode: "ITU_R_BS_1770_4",
			dialogueIntelligence: "ENABLED",
			speechThreshold: 15,
		}),
});

export const ddPlusRenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("DDPLUS"),
	name: z.string().optional(),
	bitrate: z.number().int().positive(),
	rate: z.number().positive(),
	channelLayout: z.string().default("CL_STEREO"),
});

export const ddRenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("DD"),
	name: z.string().optional(),
	bitrate: z.number().int().positive(),
	rate: z.number().positive(),
	channelLayout: z.string().default("CL_STEREO"),
});

export const vp9RenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("VP9"),
	encodingMode: codecEncodingModeSchema.optional(),
	name: z.string().optional(),
	height: z.number().int().positive().nullable(),
	bitrate: z.number().int().positive().nullable(),
	mode: streamModeSchema.default("STANDARD"),
	rate: z.number().positive().nullable().optional(),
	cpuUsed: z.number().int().min(0).optional(),
	tileColumns: z.number().int().min(0).optional(),
	qpMin: z.number().int().min(0).optional(),
	qpMax: z.number().int().min(0).optional(),
	rateUndershootPct: z.number().int().min(0).optional(),
	rateOvershootPct: z.number().int().min(0).optional(),
	quality: z.string().optional(),
	lossless: z.boolean().nullable().optional(),
	aqMode: z.string().optional(),
	arnrType: z.string().optional(),
	arnrMaxFrames: z.number().int().min(0).optional(),
	arnrStrength: z.number().int().min(0).optional(),
	colorConfig: colorConfigSchema.optional(),
	perTitleSettings: perTitleStreamSettingsSchema.optional(),
});

/**
 * AV1 (Av1VideoConfiguration). This app exposes a subset of the SDK's
 * AV1-specific settings: preset, level setup and dynamic range format.
 * Shared settings include nullable height/bitrate, stream mode, colorConfig,
 * and per-title options. Other SDK AV1 settings are not represented here.
 */
export const AV1_DYNAMIC_RANGE_FORMATS = [
	"SDR",
	"HDR10",
	"DOLBY_VISION_PROFILE_10_0",
	"DOLBY_VISION_PROFILE_10_1",
] as const;

export const av1RenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("AV1"),
	encodingMode: codecEncodingModeSchema.optional(),
	name: z.string().optional(),
	height: z.number().int().positive().nullable(),
	bitrate: z.number().int().positive().nullable(),
	mode: streamModeSchema.default("STANDARD"),
	rate: z.number().positive().nullable().optional(),
	/** Av1PresetConfiguration (closed set, SDK 1.269); wire value = name. */
	presetConfiguration: z
		.enum(["VOD_QUALITY", "VOD_STANDARD", "VOD_SPEED"])
		.optional(),
	/** AutoLevelSetup is an enum (not an object) in this SDK version. */
	autoLevelSetup: z.enum(["ENABLED", "DISABLED"]).optional(),
	dynamicRangeFormat: z.enum(AV1_DYNAMIC_RANGE_FORMATS).optional(),
	colorConfig: colorConfigSchema.optional(),
	perTitleSettings: perTitleStreamSettingsSchema.optional(),
});

export const OPUS_CHANNEL_LAYOUTS = [
	"NONE",
	"MONO",
	"CL_STEREO",
	"CL_SURROUND",
	"CL_QUAD",
	"CL_4_1",
	"CL_5_0_BACK",
	"XCL_5_1_BACK",
	"CL_6_1",
	"CL_7_1",
] as const;
export const opusRenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("OPUS"),
	name: z.string().optional(),
	bitrate: z.number().int().positive(),
	rate: z.number().positive(),
	channelLayout: z.enum(OPUS_CHANNEL_LAYOUTS).default("CL_STEREO"),
});
export const imscRenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("IMSC"),
	label: z.string().default("English"),
	language: z.string().default("en"),
	styling: z
		.strictObject({ mode: z.enum(["PASSTHROUGH", "DROP_STYLING"]).optional() })
		.optional(),
});
export const aacRenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("AAC"),
	/** audio-only sample names its config; the ladder samples don't. */
	name: z.string().optional(),
	bitrate: z.number().int().positive(),
	rate: z.number().positive(),
	channelLayout: z.string().default("CL_STEREO"),
});

/**
 * WebVTT subtitle track: parameterless WebVttConfiguration + a stream fed
 * by a WEBVTT fileStream. The HLS SubtitlesMediaInfo fields live here —
 * the rendition IS the subtitle track.
 */
export const webVttRenditionSchema = z.strictObject({
	...renditionBase,
	codec: z.literal("WEBVTT"),
	label: z.string().default("english - sample"),
	language: z.string().default("en"),
	groupId: z.string().default("SUBTITLE"),
	uri: z.string().default("subtitles_en.m3u8"),
});

export const renditionSchema = z.discriminatedUnion("codec", [
	h264RenditionSchema,
	h265RenditionSchema,
	vp9RenditionSchema,
	av1RenditionSchema,
	aacRenditionSchema,
	opusRenditionSchema,
	imscRenditionSchema,
	atmosRenditionSchema,
	ddPlusRenditionSchema,
	ddRenditionSchema,
	webVttRenditionSchema,
]);
export type PlanRendition = z.infer<typeof renditionSchema>;
/** Muxing / manifest / DRM members, exported for the verification compiler. */
export type PlanMuxing = z.infer<typeof planMuxingSchema>;
export type PlanManifest = z.infer<typeof planManifestSchema>;
export type PlanDrm = z.infer<typeof planDrmSchema>;

export const aclSchema = z.enum(["PUBLIC_READ", "PRIVATE"]);
export type Acl = z.infer<typeof aclSchema>;

/** Where a muxing/manifest writes: output ref + path (+ optional ACL). */
export const destinationSchema = z.strictObject({
	outputKey: refKey,
	path: z.string(),
	acl: aclSchema.optional(),
});

/**
 * Extra streams multiplexed INTO one container alongside its `streamKey`.
 *
 * Bitmovin's `Muxing.streams` is a `MuxingStream[]` — N streams per container
 * has always been a first-class concept there, and the SDK says so in the one
 * place it had to: `streamConditionsMode` is documented as making a difference
 * only "for Muxings with more than one Stream". OUR schema pinned it to one,
 * so the whole app could express only DEMUXED output.
 *
 * That is a real delivery gap, not a stylistic one:
 *   - HLS/TS — the classic layout carries video+audio in every variant's TS,
 *     with no EXT-X-MEDIA audio group at all. Some devices only play that.
 *   - MP4 — a progressive .mp4 that holds only video, with the audio in a
 *     SECOND file, is not a deliverable;  recorded exactly this
 *     ("the schema muxes one stream per MP4, so video+audio deliver as
 *     separate progressive files") and left it open.
 *
 * `streamKey` stays the FIRST stream, so every plan written before this field
 * existed means precisely what it meant before — the 80 goldens are unchanged
 * byte-for-byte, and the compiler emits `streams: [streamKey, ...these]`.
 *
 * `.min(1)` is deliberate: an EMPTY array would read as "this is muxed" while
 * behaving exactly like a plain single-stream container. There is no state
 * between "demuxed" and "muxed with something", so the schema refuses to hold
 * one rather than let a caller construct a lie the compiler cannot see.
 */
const additionalStreamKeysSchema = z.array(refKey).min(1).optional();

export const fmp4MuxingSchema = z.strictObject({
	key: refKey,
	kind: z.literal("FMP4"),
	streamKey: refKey,
	segmentLength: z.number().positive().default(6),
	segmentNaming: z.string().default("segment_%number%.m4s"),
	/**
	 * The naming POLICY, when placeholders must be expanded by Bitmovin.
	 *
	 * `segmentNaming` is literal. `{rand_chars:x}` written there ships as those
	 * exact characters — measured 2026-08-21 against a real Akamai MSL stream,
	 * where the published segments were named `seg-{rand_chars:8}-0.ts`, braces
	 * and all. `%number%` expands because it is a naming-policy token; the
	 * random-string tokens live only in the TEMPLATE field:
	 *
	 *   {rand_chars:x}          one random string per (re)start of the encoding
	 *   {segment_rand_chars:x}  a fresh random string per segment
	 *
	 * Bitmovin expands the template and copies the result INTO `segmentNaming`,
	 * which is why the SDK forbids sending both. The compiler enforces that at
	 * the wire: when a template is present, `segmentNaming` is not sent.
	 *
	 * Akamai MSL needs it — `[prefix]-{rand_chars[:number]}-%number%.[ext]` is
	 * their required grammar, and its point is that a restarted event does not
	 * re-use segment names. A literal token satisfies the string check and
	 * defeats the purpose.
	 */
	segmentNamingTemplate: z.string().optional(),
	initSegmentName: z.string().default("init.mp4"),
	/** Optional: DRM'd muxings write through the DRM resource's outputs. */
	destination: destinationSchema.optional(),
	name: z.string().optional(),
});

/** Dedicated CMAF resources preserve their own API discriminator. */
export const cmafMuxingSchema = fmp4MuxingSchema.extend({
	kind: z.literal("CMAF"),
	initSegmentNameTemplate: z.string().min(1).optional(),
	framesPerCmafChunk: z.number().int().positive().optional(),
});

/**
 * Single MP4 per rendition; HLS references it via byte ranges, Smooth
 * via fragmented .ismv/.isma (C-gotcha: distinct manifest families).
 * destination is optional because DRM'd muxings write through the DRM
 * resource's outputs instead (the drm samples omit muxing outputs).
 */
export const mp4MuxingSchema = z.strictObject({
	key: refKey,
	kind: z.literal("MP4"),
	streamKey: refKey,
	additionalStreamKeys: additionalStreamKeysSchema,
	filename: z.string().min(1),
	/**
	 * Both absent = progressive MP4 (plain file, no fragmentation) — the
	 * dolby progressive sample passes neither. Fragmented MP4 (byte-range
	 * HLS / Smooth) sets both. These are different artifacts; no defaults.
	 */
	fragmentDuration: z.number().int().positive().optional(),
	manifestType: z
		.enum(["HLS_BYTE_RANGES", "SMOOTH", "DASH_ON_DEMAND"])
		.optional(),
	/** DolbyVision track signaling on the MP4 box (OnDemand DV ladder). */
	dolbyVisionConfiguration: z
		.strictObject({
			trackSampleEntryName: z.enum(["DVHE", "DVH1"]),
		})
		.optional(),
	destination: destinationSchema.optional(),
	name: z.string().optional(),
});

export const textMuxingSchema = z.strictObject({
	key: refKey,
	kind: z.literal("TEXT"),
	streamKey: refKey,
	filename: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[^/\\?#]+$/, "Use a filename without directories or URL suffixes")
		.refine((n) => n !== "." && n !== "..", "Use a file name"),
	destination: destinationSchema,
	name: z.string().optional(),
});
/** Segmented WebVTT (sidecar subtitle) muxing. */
export const chunkedTextMuxingSchema = z.strictObject({
	key: refKey,
	kind: z.literal("CHUNKED_TEXT"),
	streamKey: refKey,
	segmentLength: z.number().positive().default(10),
	segmentNaming: z.string().default("en_webvtt_seg_%number%.vtt"),
	destination: destinationSchema,
	name: z.string().optional(),
});

/** MPEG-TS segments (the per-title HLS leg in the h264 samples). */
export const tsMuxingSchema = z.strictObject({
	key: refKey,
	kind: z.literal("TS"),
	streamKey: refKey,
	additionalStreamKeys: additionalStreamKeysSchema,
	segmentLength: z.number().positive().default(6),
	segmentNaming: z.string().default("seg_%number%.ts"),
	/**
	 * The naming POLICY, when placeholders must be expanded by Bitmovin.
	 *
	 * `segmentNaming` is literal. `{rand_chars:x}` written there ships as those
	 * exact characters — measured 2026-08-21 against a real Akamai MSL stream,
	 * where the published segments were named `seg-{rand_chars:8}-0.ts`, braces
	 * and all. `%number%` expands because it is a naming-policy token; the
	 * random-string tokens live only in the TEMPLATE field:
	 *
	 *   {rand_chars:x}          one random string per (re)start of the encoding
	 *   {segment_rand_chars:x}  a fresh random string per segment
	 *
	 * Bitmovin expands the template and copies the result INTO `segmentNaming`,
	 * which is why the SDK forbids sending both. The compiler enforces that at
	 * the wire: when a template is present, `segmentNaming` is not sent.
	 *
	 * Akamai MSL needs it — `[prefix]-{rand_chars[:number]}-%number%.[ext]` is
	 * their required grammar, and its point is that a restarted event does not
	 * re-use segment names. A literal token satisfies the string check and
	 * defeats the purpose.
	 */
	segmentNamingTemplate: z.string().optional(),
	destination: destinationSchema.optional(),
	name: z.string().optional(),
});

/** WebM segments (VP9 DASH leg). */
export const webmMuxingSchema = z.strictObject({
	key: refKey,
	kind: z.literal("WEBM"),
	streamKey: refKey,
	segmentLength: z.number().positive().default(6),
	segmentNaming: z.string().default("seg_%number%.chk"),
	initSegmentName: z.string().default("init.hdr"),
	destination: destinationSchema.optional(),
	name: z.string().optional(),
});

export const planMuxingSchema = z.discriminatedUnion("kind", [
	fmp4MuxingSchema,
	cmafMuxingSchema,
	mp4MuxingSchema,
	chunkedTextMuxingSchema,
	textMuxingSchema,
	tsMuxingSchema,
	webmMuxingSchema,
]);

/**
 * Encoding-level keyframe (ad-break cue). The python samples pass
 * segment_cut=True, but the current TS SDK Keyframe model has no such
 * field (keyframes always cut segments now) — `time` is the whole API.
 */
export const keyframeSchema = z.strictObject({
	key: refKey,
	time: z.number().min(0),
	/** Multi-encoding plans: absent = the implicit encoding. */
	encodingKey: refKey.optional(),
});

/**
 * Deinterlace filter resource; one instance is created per attachment.
 * Closed enums from SDK 1.269 (wire = name) — typos must fail at parse.
 */
export const deinterlaceFilterSchema = z.strictObject({
	key: refKey,
	kind: z.literal("DEINTERLACE"),
	parity: z
		.enum(["AUTO", "TOP_FIELD_FIRST", "BOTTOM_FIELD_FIRST"])
		.default("AUTO"),
	mode: z
		.enum(["FRAME", "FIELD", "FRAME_NOSPATIAL", "FIELD_NOSPATIAL"])
		.default("FRAME"),
	frameSelectionMode: z.enum(["ALL", "INTERLACED"]).default("ALL"),
	autoEnable: z
		.enum(["ALWAYS_ON", "META_DATA_BASED", "META_DATA_AND_CONTENT_BASED"])
		.default("META_DATA_AND_CONTENT_BASED"),
});

export const planFilterSchema = z.discriminatedUnion("kind", [
	deinterlaceFilterSchema,
	cropFilterSchema,
	rotateFilterSchema,
	watermarkFilterSchema,
	textFilterSchema,
	audioVolumeFilterSchema,
	ebuR128FilterSchema,
	denoiseHqdn3dFilterSchema,
	unsharpFilterSchema,
]);

/**
 * Muxing-level DRM. The 16-byte content key is vault material
 * (DRM_CENC credential); kid/PSSH/laUrl/FairPlay iv+uri are public
 * manifest metadata and stay in the plan. The DRM resource carries the
 * encrypted output destination — its muxing usually has none (C9 lives
 * in validate: CTR→IV_8_BYTES, CBC→IV_16_BYTES).
 */
export const cencDrmSchema = z.strictObject({
	key: refKey,
	kind: z.literal("CENC"),
	muxingKey: refKey,
	credentialId: z.uuid(),
	kid: z.string().regex(/^[0-9a-fA-F]{32}$/, "kid is 32 hex chars"),
	/** Omitted = API default CTR (the per-title drm samples omit it). */
	encryptionMode: z.enum(["CTR", "CBC"]).optional(),
	ivSize: z.enum(["IV_8_BYTES", "IV_16_BYTES"]).optional(),
	widevine: z.strictObject({ pssh: z.string().min(1) }).optional(),
	playReady: z
		.strictObject({
			laUrl: z.string().min(1).optional(),
			pssh: z.string().min(1).optional(),
		})
		.optional(),
	fairPlay: z
		.strictObject({
			iv: z.string().regex(/^[0-9a-fA-F]{32}$/, "iv is 32 hex chars"),
			uri: z.string().min(1),
		})
		.optional(),
	destination: destinationSchema,
	name: z.string().optional(),
});

/** Standalone FairPlay (AES-CBC) leg — TS or a second pass on fMP4. */
export const fairPlayDrmSchema = z.strictObject({
	key: refKey,
	kind: z.literal("FAIRPLAY"),
	muxingKey: refKey,
	credentialId: z.uuid(),
	iv: z.string().regex(/^[0-9a-fA-F]{32}$/, "iv is 32 hex chars"),
	uri: z.string().min(1),
	destination: destinationSchema,
	name: z.string().optional(),
});

export const spekeDrmSchema = z.strictObject({
	key: refKey,
	kind: z.literal("SPEKE"),
	muxingKey: refKey,
	credentialId: z.uuid(),
	contentId: z.string().min(1).optional(),
	kid: z
		.string()
		.regex(/^[0-9a-fA-F]{32}$/, "kid is 32 hex chars")
		.optional(),
	iv: z
		.string()
		.regex(/^[0-9a-fA-F]{32}$/, "iv is 32 hex chars")
		.optional(),
	systemIds: z
		.array(
			z
				.string()
				.regex(
					/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
					"DRM system ID is a dashed UUID",
				),
		)
		.min(1)
		.refine(
			(ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
			"DRM system IDs must be unique",
		),
	destination: destinationSchema,
	name: z.string().optional(),
});

export const planDrmSchema = z.discriminatedUnion("kind", [
	cencDrmSchema,
	fairPlayDrmSchema,
	spekeDrmSchema,
]);

/** Per-stream JPEG thumbnails (encodings.streams.thumbnails). */
export const thumbnailSchema = z.strictObject({
	key: refKey,
	streamKey: refKey,
	height: z.number().int().positive(),
	pattern: z.string().default("thumbnail-%number%.jpg"),
	unit: z.enum(["SECONDS", "PERCENTS"]).default("SECONDS"),
	positions: z.array(z.number()).min(1),
	destination: destinationSchema,
});

/**
 * Per-stream trick-play sprites (encodings.streams.sprites): a tiled
 * scrub-preview image (a grid of small frames sampled every `distance` units)
 * plus a WebVTT index mapping playback time → tile rectangle. Video-only,
 * like thumbnails (validate rejects non-video targets).
 *
 * The grid is set by EITHER `imagesPerFile` OR `hTiles`+`vTiles` — the SDK
 * rejects setting both (validate enforces it). `width`/`height`: at least one
 * is required by the encoder (the other is derived from the aspect ratio);
 * the schema keeps both optional and validate requires ≥1. `spriteName` is
 * the resource name (image extension .jpg/.jpeg/.png required); `filename`
 * is the tiled-image file; `vttName` is the .vtt index. `creationMode`
 * INTERVAL_START is recommended for trick-play (adds a tile from the very
 * start). Destination is required — a sprite with no output writes nowhere
 * (mirrors thumbnails). Bonus SDK fields jpegConfig/aspectMode stay unmodeled
 * (minor gaps, noted in STATUS).
 */
export const spriteSchema = z.strictObject({
	key: refKey,
	streamKey: refKey,
	/** Tile width in px — at least one of width/height required (validate). */
	width: z.number().int().positive().optional(),
	/** Tile height in px — at least one of width/height required (validate). */
	height: z.number().int().positive().optional(),
	/** Sampling interval between tiles, in `unit`. */
	distance: z.number().positive(),
	unit: z.enum(["SECONDS", "PERCENTS"]).default("SECONDS"),
	/** Rows of tiles per file (with vTiles); XOR with imagesPerFile (validate). */
	hTiles: z.number().int().positive().optional(),
	/** Columns of tiles per file (with hTiles); XOR with imagesPerFile (validate). */
	vTiles: z.number().int().positive().optional(),
	/** Tiles per file before rolling to a new sprite; XOR with hTiles/vTiles. */
	imagesPerFile: z.number().int().positive().optional(),
	/** Resource name; image extension (.jpg/.jpeg/.png) required by the API. */
	spriteName: z.string().min(1).optional(),
	/** Tiled-image filename (e.g. "sprite.jpg"). */
	filename: z.string().min(1),
	/** WebVTT index filename (e.g. "sprite.vtt"); ".vtt" extension required. */
	vttName: z.string().min(1).optional(),
	/** INTERVAL_START (recommended for trick-play) | INTERVAL_END. */
	creationMode: z.enum(["INTERVAL_START", "INTERVAL_END"]).optional(),
	destination: destinationSchema,
	name: z.string().optional(),
});
export type PlanSprite = z.infer<typeof spriteSchema>;

export const hlsVersionSchema = z.enum([
	"HLS_V3",
	"HLS_V4",
	"HLS_V5",
	"HLS_V6",
	"HLS_V7",
	"HLS_V8",
]);

/**
 * "STANDARD" manifests follow the encoding examples shape exactly: HLS master
 * with one audio group + per-video variants; DASH with one period, one
 * video and one audio adaptation set, TEMPLATE fMP4 representations.
 * DefaultManifest resources and fully custom trees arrive in P2.
 */
export const hlsManifestPlanSchema = z.strictObject({
	key: refKey,
	kind: z.literal("HLS"),
	manifestName: z.string().default("stream.m3u8"),
	name: z.string().default("HLS Manifest"),
	destination: destinationSchema,
	/** Optional: the openapi per-title sample relies on the API default. */
	masterVersion: hlsVersionSchema.optional(),
	mediaVersion: hlsVersionSchema.optional(),
	audioGroupId: z.string().default("audio"),
	audioLanguage: z.string().default("en"),
	closedCaptions: z.string().default("NONE"),
	/**
	 * When a rendition has multiple muxing legs (FMP4 for DASH + TS for
	 * HLS in the per-title samples), these pin which leg this manifest
	 * enumerates. Absent = no filtering (single-leg plans).
	 */
	videoMuxingKind: z.enum(["FMP4", "MP4", "TS"]).optional(),
	audioMuxingKind: z.enum(["FMP4", "MP4", "TS"]).optional(),
	/** Literal audio media uri override ("audio.m3u8" in two samples). */
	audioMediaUri: z.string().optional(),
	/**
	 * Per-title variant uris derive from the run-produced muxing
	 * (avg_bitrate) in most samples; the separate-AV one uses the codec
	 * bitrate.
	 */
	perTitleVariantUri: z
		.enum(["AVG_BITRATE", "CODEC_BITRATE"])
		.default("AVG_BITRATE"),
	/** Entries reference the selected muxing's DRM of this kind. */
	drmKind: z.enum(["CENC", "FAIRPLAY", "SPEKE"]).optional(),
	/**
	 * Dolby ladders: one StreamInfo per (video muxing × audio group) with
	 * uris video_{label}_{height}p_{bitrate}_{group}.m3u8, audio groups
	 * derived from rendition hlsMedia entries, plus an I-frame playlist
	 * per video rendition attached to its first variant.
	 */
	variantsPerAudioGroup: z.boolean().optional(),
	iframePlaylists: z.boolean().optional(),
	/** Audio-only atmos samples add a variant entry per audio muxing too. */
	audioVariantStreams: z.boolean().optional(),
	/**
	 * JIT-only start-request placement: which StartEncodingRequest list this
	 * manifest rides — vodHlsManifests (absent / "VOD", today's behavior),
	 * previewHlsManifests (watch-while-encoding, "PREVIEW"), or both. The
	 * validator rejects preview placements on POST_ENCODING plans
	 * (PLAN_PREVIEW_REQUIRES_JIT). SMOOTH has no preview list in the API.
	 */
	jitPlacement: z.enum(["VOD", "PREVIEW", "VOD_AND_PREVIEW"]).optional(),
});

export const dashManifestPlanSchema = z.strictObject({
	key: refKey,
	kind: z.literal("DASH"),
	manifestName: z.string().default("stream.mpd"),
	name: z.string().default("DASH Manifest"),
	destination: destinationSchema,
	/**
	 * ON_DEMAND = single-MP4 SegmentBase representations (BaseURL + byte
	 * ranges) fed by DASH_ON_DEMAND MP4 muxings. Absent = segmented (LIVE
	 * profile arrives with P3).
	 */
	profile: z.enum(["ON_DEMAND"]).optional(),
	audioLanguage: z.string().default("en"),
	/** Per-manifest: the dash-segment-timeline sample builds one of each. */
	representationType: z.enum(["TEMPLATE", "TIMELINE"]).default("TEMPLATE"),
	/** See hlsManifestPlanSchema — multi-leg muxing selection. */
	videoMuxingKind: z.enum(["FMP4", "CMAF", "WEBM"]).optional(),
	audioMuxingKind: z.enum(["FMP4", "CMAF", "WEBM"]).optional(),
	/** Entries reference the selected muxing's DRM of this kind. */
	drmKind: z.enum(["CENC", "SPEKE"]).optional(),
	/**
	 * Explicit adaptation sets (Dolby ladders/multi-audio): renditions
	 * join via dashSetKey. Absent ⇒ the implicit video+audio pair.
	 */
	adaptationSets: z
		.array(
			z.strictObject({
				key: refKey,
				type: z.enum(["VIDEO", "AUDIO"]),
				lang: z.string().optional(),
				label: z.string().optional(),
			}),
		)
		.optional(),
	/** See hlsManifestPlanSchema.jitPlacement — same semantics for DASH. */
	jitPlacement: z.enum(["VOD", "PREVIEW", "VOD_AND_PREVIEW"]).optional(),
});

/** SmoothStreaming (.ism/.ismc) — MP4 SMOOTH muxings, PlayReady CENC. */
export const smoothManifestPlanSchema = z.strictObject({
	key: refKey,
	kind: z.literal("SMOOTH"),
	serverManifestName: z.string().default("stream.ism"),
	clientManifestName: z.string().default("stream.ismc"),
	name: z.string().default("Smooth Manifest"),
	destination: destinationSchema,
	language: z.string().default("en"),
	drmKind: z.enum(["CENC"]).optional(),
});

export const planManifestSchema = z.discriminatedUnion("kind", [
	hlsManifestPlanSchema,
	dashManifestPlanSchema,
	smoothManifestPlanSchema,
]);

export const generationTimingSchema = z.enum(["JUST_IN_TIME", "POST_ENCODING"]);

/** Start-request per-title block (PerTitle → codec configurations). */
const perTitleFixedResolutionAndBitrateConfigurationSchema = z.strictObject({
	forcedRenditionAboveHighestFixedRepresentation: z
		.number()
		.int()
		.min(0)
		.optional(),
	forcedRenditionAboveHighestFixedRepresentationFactor: z
		.number()
		.positive()
		.optional(),
	forcedRenditionAboveHighestFixedRepresentationCalculationMode: z
		.enum(["LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"])
		.optional(),
});

const perTitleCodecConfigurationBase = {
	minBitrate: z.number().int().positive().optional(),
	maxBitrate: z.number().int().positive().optional(),
	targetQualityCrf: z.number().optional(),
	minBitrateStepSize: z.number().positive().optional(),
	maxBitrateStepSize: z.number().positive().optional(),
	/** SDK PerTitleConfiguration base carries it for every codec. */
	complexityFactor: z.number().positive().optional(),
	/** Empty object = enable auto representations with defaults (hdr10). */
	autoRepresentations: z
		.strictObject({
			adoptConfigurationThreshold: z.number().optional(),
		})
		.optional(),
	fixedResolutionAndBitrateConfiguration:
		perTitleFixedResolutionAndBitrateConfigurationSchema.optional(),
};

export const perTitleSchema = z.strictObject({
	h264Configuration: z
		.strictObject({
			...perTitleCodecConfigurationBase,
			codecMinBitrateFactor: z.number().positive().optional(),
			codecMaxBitrateFactor: z.number().positive().optional(),
			codecBufsizeFactor: z.number().positive().optional(),
			/** H264-only knob — H265/VP9 configurations don't have it. */
			complexityFactor: z.number().positive().optional(),
		})
		.optional(),
	h265Configuration: z
		.strictObject({
			...perTitleCodecConfigurationBase,
			codecMinBitrateFactor: z.number().positive().optional(),
			codecMaxBitrateFactor: z.number().positive().optional(),
			codecBufsizeFactor: z.number().positive().optional(),
		})
		.optional(),
	h265V2Configuration: z
		.strictObject({
			...perTitleCodecConfigurationBase,
			// Native H265V2 uses a CQP probe; a CRF is not an equivalent QP.
			targetQualityCrf: z.never().optional(),
			targetQualityQp: z.number().optional(),
			codecMinBitrateFactor: z.number().positive().optional(),
			codecMaxBitrateFactor: z.number().positive().optional(),
		})
		.optional(),
	vp9Configuration: z
		.strictObject({
			...perTitleCodecConfigurationBase,
		})
		.optional(),
	/** Av1PerTitleConfiguration — like VP9, no codec bitrate/bufsize factors. */
	av1Configuration: z
		.strictObject({
			...perTitleCodecConfigurationBase,
		})
		.optional(),
});

/**
 * Multi-encoding partition (Dolby ladders): the API rejects mixing
 * dynamic-range formats in one encoding (error 2065), so DV/HDR10/SDR
 * ladders run as sibling encodings whose muxings merge into shared
 * post-encoding manifests. Absent ⇒ the implicit single encoding
 * (step ids stay "encoding"/"start"/"await:encoding").
 */
export const planEncodingSchema = z.strictObject({
	key: refKey,
	name: z.string().min(1).max(200),
	cloudRegion: z.string().min(1).optional(),
	encoderVersion: z.string().min(1).optional(),
});

/**
 * Quality-control request (P4 — VMAF + optional PSNR). Bitmovin has NO VMAF
 * API (PSNR only via its QC API, COVERAGE C-rule), so when QC is requested
 * the compiler emits an extra progressive single-file MP4 muxing per video
 * rendition under a `qc/` output prefix; our own ffmpeg/libvmaf runner
 * (worker, PR3) later downloads those mirrors and scores them against the
 * source. `model` picks the libvmaf built-in version (`model=version=<model>`);
 * it defaults to `DEFAULT_VMAF_MODEL` whenever the `qc` block is present.
 *
 * PSNR (P4-PR5) rides the SAME libvmaf pass — we do NOT use Bitmovin's QC
 * API. When `psnr` is true the runner enables libvmaf's `psnr` feature
 * (`feature=name=psnr`), which adds `psnr_y` per frame + pooled in the same
 * JSON the VMAF run already produces; it needs the distorted MP4 mirror too,
 * so the compiler emits the mirror whenever `vmaf || psnr` (see compiler §4).
 * A psnr-only plan (`{psnr:true}` with `vmaf:false`) still gets VMAF scores —
 * they are free in the same pass — so the runner computes VMAF unconditionally
 * and only ADDS PSNR when asked. `psnr` defaults absent (≡ false).
 *
 * Optional + absent in all 56 golden fixtures by design: a plan WITHOUT
 * `qc` must compile byte-identically to before this field existed.
 */
/**
 * A libvmaf model NAME, constrained to a filename-safe charset. The worker both
 * resolves it to a path (`$VMAF_MODEL_DIR/<name>.json`, for `model=path=`) AND
 * interpolates it into the ffmpeg libvmaf filter (`model=version=<name>`), so an
 * unconstrained string could traverse the model dir (`../`) or inject extra
 * `:`/`|`-delimited libvmaf params. `[A-Za-z0-9._-]+` rejects `/ .. : | \`,
 * whitespace and NUL while accepting every real model (vmaf_v0.6.1,
 * vmaf_v1.0.16_3d0h, vmaf_v1.0.16_hfr_1d5h_2160, …). Shared by the VOD plan and
 * the live capture-vmaf route so both validate identically.
 */
/**
 * The default libvmaf model , owner-directed 2026-08-16: VMAF **v1** rather than
 * the v0.6.1 built-in. `vmaf_v1.0.16_3d0h` is v1's STANDARD viewing condition
 * (3.0 display-heights, 1080p) — the direct counterpart of what v0.6.1 assumes,
 * so scores stay comparable in kind while using the newer model. It loads from
 * the file bundled in the worker image (`$VMAF_MODEL_DIR/<name>.json`, verified
 * present in the shipped image alongside all 14) and was measured end to end in
 *  (83.01 on the matrix pair,
 * 120/120 frames). Deployments running a worker image WITHOUT the model files
 * must set `qc.model` explicitly to a built-in (`vmaf_v0.6.1`) — and a plan
 * submitted against a worker that lacks the file is now REFUSED before the
 * encode (`PLAN_VMAF_MODEL_UNAVAILABLE`), not after it.
 *
 * One exported constant on purpose: the previous default was spelled out in
 * five places (schema, wizard state, deviation-emitter, plan import, the live
 * capture route), which is exactly how a default drifts apart.
 */
export const DEFAULT_VMAF_MODEL = "vmaf_v1.0.16_3d0h";

/**
 * libvmaf's BUILT-IN model versions — the ones `model=version=<name>` resolves
 * without any file on disk. Everything else (every VMAF v1 model, including
 * the default above) loads only from `$VMAF_MODEL_DIR/<name>.json`.
 *
 * Exported so a caller can refuse an unusable request BEFORE it costs an
 * encode: review-234 I2 measured that a host worker with `VMAF_MODEL_DIR`
 * unset now fails every default VMAF run, and it failed at SCORING time —
 * after the Bitmovin encode had finished and every mirror had been downloaded.
 */
export const LIBVMAF_BUILTIN_MODELS = [
	"vmaf_v0.6.1",
	"vmaf_v0.6.1neg",
	"vmaf_4k_v0.6.1",
] as const;

/** True when the model needs a bundled JSON (i.e. is not a libvmaf built-in). */
export function vmafModelNeedsFile(model: string): boolean {
	return !LIBVMAF_BUILTIN_MODELS.includes(
		model as (typeof LIBVMAF_BUILTIN_MODELS)[number],
	);
}

export const vmafModelNameSchema = z
	.string()
	.min(1)
	.regex(
		/^[A-Za-z0-9._-]+$/,
		"VMAF model must be a libvmaf model name ([A-Za-z0-9._-])",
	);

export const planQcSchema = z.strictObject({
	vmaf: z.boolean(),
	/** Automatic VOD measurement execution; absent retains legacy local execution. */
	execution: vmafExecutionSchema.optional(),
	/** Opt into cloud full-frame validation and scoring generation 6. */
	measurementMethod: z.literal("FRAME_INDEX_BT709_10BIT").optional(),
	model: vmafModelNameSchema.default(DEFAULT_VMAF_MODEL),
	/** Add libvmaf's PSNR feature (psnr_y) to the same pass. Absent ≡ false. */
	psnr: z.boolean().optional(),
	/**
	 * VMAF-only encode: when true the encode produces ONLY the per-video-rendition
	 * QC mirror MP4s — no delivery muxings (fMP4/TS/WebM), no manifests
	 * (HLS/DASH/Smooth), no audio renditions, no thumbnails/sprites/DRM/keyframes.
	 * This makes a VMAF/PSNR measurement cheap/fast and sidesteps manifest-
	 * generation failures. The plan MUST still carry its `muxings` — the compiler
	 * keeps reading their destinations to derive each qc mirror's `qc/` path
	 * (compiler §4) — but those delivery muxings are NOT emitted. validate.ts
	 * rejects a qc.only plan that carries manifests/thumbnails/sprites/drm/
	 * keyframes (nothing would consume them). Absent ⇒ unchanged behavior, so the
	 * 56 goldens stay byte-identical.
	 */
	only: z.boolean().optional(),
	/**
	 * QC gate : threshold rules that turn the measurement into
	 * enforcement (C29 rails in validate.ts; verdict in qc-gate.ts). Absent
	 * ⇒ no compiler output changes and the 73 goldens stay byte-identical.
	 */
	gate: qcGateSchema.optional(),
});
export type PlanQc = z.infer<typeof planQcSchema>;

/**
 * Kantar audio watermarking (P5). An ENCODING-level singleton in the API
 * (`encodings/{id}/kantar-watermark`, create = create-or-replace), unlike
 * NexGuard which attaches per stream — so it lives at the plan root and the
 * compiler emits one op per encoding.
 *
 * The service login rides the vault (KANTAR provider, login + password both
 * encrypted); the plan carries `credentialId` plus the public job metadata.
 * `reportDestination` is where Kantar's processing report is written — a
 * normal plan destination, so it resolves against `plan.outputs`.
 */
export const kantarWatermarkSchema = z.strictObject({
	credentialId: z.uuid(),
	/** Kantar license id (SDK: integer). */
	licenseId: z.number().int().positive(),
	channelName: z.string().min(1),
	contentReference: z.string().min(1),
	serverUrl: secretEgressUrlSchema,
	reportDestination: destinationSchema,
});

export const encodingPlanSchema = z.strictObject({
	planVersion: z.literal(PLAN_VERSION),
	name: z.string().min(1).max(200),
	/** Internal opt-in; authorization is enforced at submit and execution. */
	internal: z.strictObject({ hevcV2: internalHevcV2Schema }).optional(),
	bitmovin: z.strictObject({
		/** Vault BitmovinAccount id; resolved by the orchestrator. */
		accountId: z.uuid().optional(),
		// .min(1): "" passes defaults (they fire on undefined only) and the
		// wizard's pinned-version flow starts from an empty string.
		cloudRegion: z.string().min(1).default("AUTO"),
		encoderVersion: z.string().min(1).default("STABLE"),
		// Account-level submission defaults, injected from the BitmovinAccount
		// record at job submission (applyAccountDefaultsToPlan) — the wizard
		// never collects these, so without the injection they were silently
		// dropped (set in Settings, never sent to Bitmovin). Optional (no
		// default) ⇒ plans that don't carry them emit zero payload keys and the
		// goldens stay byte-identical. fallbackCloudRegions → Encoding create;
		// schedulingPriority + prewarmedEncoderPoolIds → the start request.
		fallbackCloudRegions: z.array(z.string().min(1)).optional(),
		schedulingPriority: z.number().int().min(0).max(100).optional(),
		prewarmedEncoderPoolIds: z.array(z.string().min(1)).optional(),
		/**
		 * Encoding.labels — plain string tags that group results in Bitmovin's
		 * statistics resource (NOT the DASH AdaptationSet Label objects).
		 * Optional, no default ⇒ absent plans emit zero payload keys and the
		 * 56 goldens stay byte-identical. Multi-encoding plans apply the same
		 * labels to every sibling encoding.
		 */
		labels: z.array(z.string().min(1)).optional(),
		/**
		 * Encoding.infrastructure — pin the encoding onto a Cloud Connect
		 * (BYOC) infrastructure account. cloudRegion here is the region INSIDE
		 * that infrastructure (generic CloudRegion wire string), and the
		 * TOP-LEVEL cloudRegion must then be "EXTERNAL" (C18) — Bitmovin's
		 * Cloud Connect contract on every provider; enforced by the
		 * PLAN_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION rail so a managed-cloud
		 * region can never ride alongside an infrastructure block.
		 */
		infrastructure: z
			.strictObject({
				infrastructureId: z.string().min(1),
				cloudRegion: z.string().min(1),
			})
			.optional(),
	}),
	inputs: z.array(planInputSchema).min(1),
	outputs: z.array(planOutputSchema).min(1),
	/**
	 * Multi-output delivery : every muxing/DRM/thumbnail/sprite/
	 * manifest destination is ALSO written to each mirror output, at the SAME
	 * path and acl — one encode, N storages (S3 and GCS alike). Plan-level by
	 * design: the owner's ask is fan-out, not per-muxing routing; the compiler
	 * spreads mirror refs at every destination site and the worker appends
	 * them to the SDK outputs array. `.optional` (not `.default([])`) so
	 * absence parses to absence and the 73 goldens stay byte-identical.
	 */
	deliveryMirrors: z
		.array(z.strictObject({ outputKey: refKey }))
		.min(1)
		.optional(),
	encodings: z.array(planEncodingSchema).optional(),
	ingest: z.array(ingestStreamSchema).default([]),
	fileStreams: z.array(fileStreamSchema).default([]),
	dolbyStreams: z.array(dolbyStreamSchema).default([]),
	/**
	 * Input-stream trimming/concatenation (the modern path). Both `.default([])`
	 * so plans without them parse to the same shape as before — the 56 goldens
	 * stay byte-identical (defaults fire on absence only). Compiled AFTER the
	 * ingest/file/dolby streams they wrap, BEFORE CREATE_STREAM.
	 */
	trimmingStreams: z.array(trimmingStreamSchema).default([]),
	concatenationStreams: z.array(concatenationStreamSchema).default([]),
	audioMixStreams: z.array(audioMixStreamSchema).default([]),
	filters: z.array(planFilterSchema).default([]),
	renditions: z.array(renditionSchema).min(1),
	muxings: z.array(planMuxingSchema).min(1),
	drm: z.array(planDrmSchema).default([]),
	thumbnails: z.array(thumbnailSchema).default([]),
	/**
	 * Per-stream trick-play sprites. `.default([])` ⇒ plans without sprites
	 * parse to the same shape as before (defaults fire on absence only), so
	 * the 56 goldens stay byte-identical. Compiled in the per-stream loop
	 * right after thumbnails.
	 */
	sprites: z.array(spriteSchema).default([]),
	keyframes: z.array(keyframeSchema).default([]),
	manifests: z.array(planManifestSchema).default([]),
	/** Present iff the plan contains per-title renditions (validated). */
	perTitle: perTitleSchema.optional(),
	/**
	 * AI Scene Analysis — a start-request feature (StartEncodingRequest.
	 * aiSceneAnalysis), not a resource. The asset-description JSON lands at
	 * its own destination; language codes are ISO 639-1 ("en" implicit).
	 * The samples run it on encoderVersion BETA.
	 */
	aiSceneAnalysis: z
		.strictObject({
			assetDescription: z.strictObject({
				filename: z.string().min(1),
				destination: destinationSchema,
			}),
			automaticAdPlacement: z
				.strictObject({
					allSceneBoundaries: z
						.strictObject({
							isEnabled: z.boolean(),
							insertCueTags: z.boolean(),
						})
						.optional(),
					/** Requested times in seconds; never round or snap to frame boundaries. */
					schedule: z
						.array(
							z.strictObject({
								position: z.number().finite().nonnegative(),
								maxDeviation: z.number().finite().nonnegative(),
								duration: z.number().finite().nonnegative().optional(),
							}),
						)
						.min(1)
						.optional(),
				})
				.optional(),
			/** ISO 639-1; the API accepts AT MOST 3 (COVERAGE §9's own "≤3"
			 * — recorded there since P2 and unenforced here until the
			 * 2026-08-22 use-case census caught the gap). */
			outputLanguageCodes: z.array(z.string().min(1)).max(3).optional(),
		})
		.optional(),
	/**
	 * Delivery-spec commitment . The conformance checker was
	 * WIZARD-ONLY: a plan submitted by a machine — an API token (#81) or a
	 * watch folder (#87) — got no conformance feedback at all, which is
	 * exactly where nobody is looking at a drift banner. Naming the spec HERE
	 * makes the commitment part of the plan, and `submitEncodingJob` — the one
	 * pipeline the API route, the watch sweep and re-run share — refuses a
	 * plan that does not meet it. NOT `validatePlan`: that runs live in the
	 * wizard on every keystroke, and a policy rule there locked a committed
	 * plan out of the form (review-210 I3). RE-RUN deliberately does not
	 * re-check: a spec is ordinary code, so a later tightening must not make a
	 * finished job un-re-runnable. Absent ⇒ unchanged behaviour, which is why
	 * the 73 goldens do not move.
	 */
	delivery: z
		.strictObject({
			/**
			 * A shipped spec id (DELIVERY_SPECS) — unknown ids are refused. The
			 * bound is not cosmetic: the id is echoed into the refusal message,
			 * which the watch sweep persists AND emits as a notification, so an
			 * unbounded value became an oversized notification payload that
			 * burned its retries once per discovered object (review-210 I5).
			 */
			specId: z.string().min(1).max(128),
			/** REFUSE (default) blocks the submit; WARN records and proceeds. */
			onDeviation: z.enum(["REFUSE", "WARN"]).default("REFUSE"),
		})
		.optional(),
	generation: z.strictObject({
		timing: generationTimingSchema,
		/** StartEncodingRequest.encodingMode (THREE_PASS in the samples). */
		encodingMode: z
			.enum(["STANDARD", "SINGLE_PASS", "TWO_PASS", "THREE_PASS", "SMART_PASS"])
			.optional(),
		/**
		 * StartEncodingRequest.tweaks.audioVideoSyncMode. The API rejects it
		 * for Dolby Digital (Plus) / Atmos audio — validator rail
		 * PLAN_TWEAKS_DOLBY_CONFLICT. Absent ⇒ no tweaks payload key.
		 */
		audioVideoSyncMode: z
			.enum(["STANDARD", "RESYNC_AT_START", "RESYNC_AT_START_AND_END"])
			.optional(),
		/**
		 * StartEncodingRequest.handleVariableInputFps — frame drop/duplicate
		 * for variable-framerate video inputs.
		 */
		handleVariableInputFps: z.boolean().optional(),
	}),
	/**
	 * Optional VMAF (+ optional PSNR) quality-control request. Absent ⇒ the
	 * compiler emits exactly today's ops (keeps the 56 goldens byte-identical);
	 * present with `vmaf: true` OR `psnr: true` ⇒ a `qc/` MP4 mirror per video
	 * rendition (PSNR rides the same libvmaf pass and needs the distorted file
	 * too — see planQcSchema).
	 */
	qc: planQcSchema.optional(),
	/**
	 * Kantar audio watermarking — an ENCODING-level singleton, so one op per
	 * encoding. Absent ⇒ no op at all (the existing VOD goldens stay byte-identical).
	 */
	kantar: kantarWatermarkSchema.optional(),
});

export type EncodingPlan = z.infer<typeof encodingPlanSchema>;
export type EncodingPlanInput = z.input<typeof encodingPlanSchema>;
