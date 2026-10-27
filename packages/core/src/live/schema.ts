import { z } from "zod";
import {
	cmafMuxingSchema,
	destinationSchema,
	fmp4MuxingSchema,
	mp4MuxingSchema,
	planDrmSchema,
	planOutputSchema,
	renditionSchema,
	secretEgressUrlSchema,
	tsMuxingSchema,
} from "../plan/schema";

/**
 * LiveChannelPlan v1 — the zod-validated JSON every live channel flows
 * through. Deliberately a SEPARATE type from EncodingPlan: the lifecycle
 * differs at the root (start → steady RUNNING → stop/restart, DVR windows,
 * auto-restart) while the rendition/muxing building blocks are the same and
 * are imported from ../plan/schema verbatim.
 *
 * Field surface mirrors the TS SDK live models (OpenAPI-generated = truth;
 * there is no encoding examples for live): SrtInput/ZixiInput/RedundantRtmpInput/
 * HlsInput, StartLiveEncodingRequest, AutoRestartConfiguration,
 * LiveAutoShutdownConfiguration, ReuploadSettings, LiveHls/LiveDashManifest.
 *
 * Secrets NEVER appear in a plan: the SRT passphrase and the Zixi
 * password/decryptionKey are vault material (credentialId refs, same rule
 * as DRM content keys). The live stream key is connection-routing material
 * the user owns — it stays in the plan, and persisted snapshots still mask
 * it (crypto/redact treats the `key` suffix as sensitive).
 *
 * Evolution contract matches EncodingPlan: strict objects, parsed plans are
 * persisted with defaults materialized, the orchestrator replays compiled
 * ops — later default changes never alter a provisioned channel.
 */

export const LIVE_CHANNEL_PLAN_VERSION = 1;

/** Local cross-reference key inside one plan (mirrors plan/schema). */
const refKey = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/, "Keys are [a-zA-Z0-9_-]");

/** SrtInput.port in LISTENER mode is restricted to exactly these (SDK). */
export const SRT_LISTENER_PORTS = [2088, 2089, 2090, 2091] as const;

/**
 * Shared SRT connection surface — the top-level input and each
 * backupSrtInputs entry are full SrtInputs in the SDK; backup entries here
 * drop only `backup` itself (one redundancy level, which is what the
 * feature is for).
 */
const srtConnectionShape = {
	mode: z.enum(["LISTENER", "CALLER"]),
	/** Source host — CALLER mode only (Bitmovin pulls from it). */
	host: z.string().min(1).optional(),
	port: z.number().int().min(1).max(65535),
	path: z.string().min(1).optional(),
	/** Max accepted transmission latency (ms); both parties' max wins. */
	latency: z.number().int().positive().optional(),
	/** Vault SRT passphrase (AES-128 = 16 chars, AES-256 = 32 chars). */
	credentialId: z.uuid().optional(),
	/** AES key length; must match the vaulted passphrase length. */
	keyLength: z.union([z.literal(128), z.literal(256)]).optional(),
};

type SrtConnection = {
	mode: "LISTENER" | "CALLER";
	host?: string;
	port: number;
	credentialId?: string;
	keyLength?: 128 | 256;
};

function refineSrtConnection(value: SrtConnection, ctx: z.RefinementCtx): void {
	// CALLER dials out — without a host there is nothing to call; LISTENER
	// hosts would be silently ignored by the API (dead plan config).
	if (value.mode === "CALLER" && !value.host) {
		ctx.addIssue({
			code: "custom",
			message: "SRT CALLER mode requires host",
			path: ["host"],
		});
	}
	if (value.mode === "LISTENER" && value.host) {
		ctx.addIssue({
			code: "custom",
			message: "SRT LISTENER mode must not set host (CALLER-only field)",
			path: ["host"],
		});
	}
	if (
		value.mode === "LISTENER" &&
		!SRT_LISTENER_PORTS.includes(
			value.port as (typeof SRT_LISTENER_PORTS)[number],
		)
	) {
		ctx.addIssue({
			code: "custom",
			message: `SRT LISTENER port must be one of ${SRT_LISTENER_PORTS.join("/")}`,
			path: ["port"],
		});
	}
	// keyLength describes the vaulted passphrase — alone it encrypts nothing.
	if (value.keyLength !== undefined && !value.credentialId) {
		ctx.addIssue({
			code: "custom",
			message: "keyLength requires a passphrase credentialId",
			path: ["keyLength"],
		});
	}
}

const srtBackupInputSchema = z
	.strictObject({ ...srtConnectionShape })
	.superRefine(refineSrtConnection);

export const rtmpLiveInputSchema = z.strictObject({
	key: refKey,
	/**
	 * Account-default RTMP input: the API exposes list/get only (no POST),
	 * so there are no creatable fields — the executor resolves the id by
	 * listing (CREATE_INPUT_RTMP contract).
	 */
	kind: z.literal("RTMP"),
	/**
	 * : pin a SPECIFIC RTMP input id (accounts can carry several).
	 * Absent ⇒ the resolve-by-list contract above stays exactly as before
	 * (refuses ambiguity); set ⇒ the executor uses this id verbatim.
	 */
	inputId: z.uuid().optional(),
});

export const redundantRtmpIngestPointSchema = z.strictObject({
	applicationName: z.string().min(1),
	streamKey: z.string().min(1),
});

export const redundantRtmpStaticIngestPointSchema = z.strictObject({
	name: z.string().min(1).optional(),
	streamKeyConfiguration: z
		.strictObject({
			type: z.enum(["GENERATE", "ASSIGN"]),
			/** Account-level StreamKey id — ASSIGN only. */
			streamKeyId: z.uuid().optional(),
		})
		.superRefine((value, ctx) => {
			if (value.type === "ASSIGN" && !value.streamKeyId) {
				ctx.addIssue({
					code: "custom",
					message: "streamKeyConfiguration ASSIGN requires streamKeyId",
					path: ["streamKeyId"],
				});
			}
			if (value.type === "GENERATE" && value.streamKeyId) {
				ctx.addIssue({
					code: "custom",
					message: "streamKeyConfiguration GENERATE must not set streamKeyId",
					path: ["streamKeyId"],
				});
			}
		})
		.optional(),
});

export type RedundantRtmpStaticIngestPoint = z.infer<
	typeof redundantRtmpStaticIngestPointSchema
>;

export const redundantRtmpLiveInputSchema = z
	.strictObject({
		key: refKey,
		kind: z.literal("REDUNDANT_RTMP"),
		name: z.string().min(1).default("Redundant RTMP Input"),
		/** Seconds without signal before switching to another ingest point. */
		delayThreshold: z.number().int().positive().optional(),
		/** Dynamic-IP ingest points (rtmp://<encoder-ip>/<applicationName>). */
		ingestPoints: z.array(redundantRtmpIngestPointSchema).min(1).optional(),
		/** Fixed-FQDN ingest points . */
		staticIngestPoints: z
			.array(redundantRtmpStaticIngestPointSchema)
			.min(1)
			.optional(),
	})
	.superRefine((value, ctx) => {
		// The SDK forbids mixing and an empty redundant input ingests nothing:
		// exactly one of the two lists must be present.
		if (
			(value.ingestPoints === undefined) ===
			(value.staticIngestPoints === undefined)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"REDUNDANT_RTMP requires exactly one of ingestPoints or staticIngestPoints",
				path: ["ingestPoints"],
			});
		}
	});

export const srtLiveInputSchema = z
	.strictObject({
		key: refKey,
		kind: z.literal("SRT"),
		name: z.string().min(1).default("SRT Input"),
		...srtConnectionShape,
		/** BackupSrtInputs — failover sources behind a no-signal threshold. */
		backup: z
			.strictObject({
				delayThreshold: z.number().int().positive().optional(),
				srtInputs: z.array(srtBackupInputSchema).min(1),
			})
			.optional(),
	})
	.superRefine(refineSrtConnection);

export const zixiLiveInputSchema = z.strictObject({
	key: refKey,
	kind: z.literal("ZIXI"),
	name: z.string().min(1).default("Zixi Input"),
	host: z.string().min(1),
	port: z.number().int().min(1).max(65535),
	stream: z.string().min(1),
	/** Vault Zixi material (password and/or decryptionKey). */
	credentialId: z.uuid(),
	latency: z.number().int().positive().optional(),
	minBitrate: z.number().int().positive().optional(),
	/** SDK passthrough string (no enum in the model). */
	decryptionType: z.string().min(1).optional(),
});

export const hlsLiveInputSchema = z.strictObject({
	key: refKey,
	kind: z.literal("HLS"),
	name: z.string().min(1).default("HLS Input"),
	/** Optional in the SDK model (unlike every "(required)"-marked field). */
	url: z.string().min(1).optional(),
	/** Where SCTE-35 ad markers are read from. */
	adMarkersSource: z.enum(["MANIFEST", "SEGMENTS"]).optional(),
});

export const liveInputSchema = z.discriminatedUnion("kind", [
	rtmpLiveInputSchema,
	redundantRtmpLiveInputSchema,
	srtLiveInputSchema,
	zixiLiveInputSchema,
	hlsLiveInputSchema,
]);
export type LiveInput = z.infer<typeof liveInputSchema>;

/**
 * Track selection within the single live feed. Unlike VOD, live codec streams
 * reference the input DIRECTLY on their StreamInput (inputId + inputPath +
 * position) — NOT via a standalone IngestInputStream resource. Bitmovin's
 * live/start cannot resolve an IngestInputStream built on the account RTMP
 * input (it fails 2025 on the ingest-stream id); the working Akamai sample and
 * the bitmovin-live templates both inline the selection on each Stream instead.
 * Video uses position 0, audio position 1 (C13). Each entry is inlined per
 * rendition by ingestKey — it no longer compiles to its own resource.
 */
export const liveIngestSchema = z.strictObject({
	key: refKey,
	inputPath: z.string().min(1).default("live"),
	position: z.number().int().min(0).default(0),
});

/**
 * Live-supported muxing kinds: segmented fMP4 (HLS/DASH) and segmented
 * MPEG-TS (HLS), plus progressive MP4 finalized after Live stops (not the
 * separate LiveToVod API). Validation limits archives to explicit storage
 * outputs and plain H264/AAC MP4; they are never live manifest legs.
 */
export const liveMuxingSchema = z.discriminatedUnion("kind", [
	fmp4MuxingSchema,
	cmafMuxingSchema,
	tsMuxingSchema,
	mp4MuxingSchema,
]);
export type LiveMuxing = z.infer<typeof liveMuxingSchema>;

/**
 * Live manifests are PRE-CREATED resources (compiled as ops, exactly like
 * VOD trees) and referenced by manifestId in the start request — the one
 * modeling for PR1, keeping compileLiveChannel symmetric with compilePlan.
 * FOLLOW-UP (ledgered, COVERAGE): the API alternatively accepts JIT-embedded
 * manifest definitions inside the start request without pre-created
 * resources; expose that as a second mode only if a concrete need appears.
 *
 * Creation-surface fields mirror the VOD manifest schemas; the trailing
 * block on each kind is its LiveHls/LiveDashManifest start-request surface
 * (timeshift etc.), which the compiler emits in the START payload — not on
 * the manifest resource.
 */
export const liveHlsManifestPlanSchema = z.strictObject({
	key: refKey,
	kind: z.literal("HLS"),
	manifestName: z.string().default("stream.m3u8"),
	name: z.string().default("Live HLS Manifest"),
	destination: destinationSchema,
	audioGroupId: z.string().default("audio"),
	audioLanguage: z.string().default("en"),
	closedCaptions: z.string().default("NONE"),
	/** Pin a muxing leg when a rendition carries both FMP4 and TS. */
	videoMuxingKind: z.enum(["FMP4", "TS"]).optional(),
	drmKind: z.enum(["CENC", "FAIRPLAY", "SPEKE"]).optional(),
	audioMuxingKind: z.enum(["FMP4", "TS"]).optional(),
	// LiveHlsManifest start-request surface
	/** DVR window (seconds). C8: ≤10800 recommended — validated, not clamped. */
	timeshift: z.number().positive().optional(),
	/** Live edge offset (seconds). */
	liveEdgeOffset: z.number().min(0).optional(),
	/** Adds EXT-X-PROGRAM-DATE-TIME tags. */
	insertProgramDateTime: z.boolean().optional(),
	/**
	 * LiveHlsManifest.programDateTimeSettings — PDT source + placement.
	 * source interacts with adInsertion.clockSynchronizationMode: both set
	 * and mismatched ⇒ the ENCODING FAILS (C19 rail). interval is required
	 * for the *_INTERVAL placement modes (schema refine).
	 */
	programDateTimeSettings: z
		.strictObject({
			source: z.enum(["SYSTEM_CLOCK", "EMBEDDED"]).optional(),
			placement: z
				.strictObject({
					mode: z.enum([
						"ONCE_PER_PLAYLIST",
						"SEGMENTS_INTERVAL",
						"SECONDS_INTERVAL",
					]),
					interval: z.number().positive().optional(),
				})
				.refine(
					(p) => p.mode === "ONCE_PER_PLAYLIST" || p.interval !== undefined,
					{
						message:
							"interval is required for SEGMENTS_INTERVAL / SECONDS_INTERVAL placement",
						path: ["interval"],
					},
				)
				.optional(),
		})
		.optional(),
});

export const liveDashManifestPlanSchema = z.strictObject({
	key: refKey,
	kind: z.literal("DASH"),
	manifestName: z.string().default("stream.mpd"),
	name: z.string().default("Live DASH Manifest"),
	destination: destinationSchema,
	audioLanguage: z.string().default("en"),
	/** SegmentTemplate vs SegmentTimeline per representation family. */
	representationType: z.enum(["TEMPLATE", "TIMELINE"]).default("TEMPLATE"),
	videoMuxingKind: z.enum(["FMP4", "CMAF"]).optional(),
	drmKind: z.enum(["CENC", "FAIRPLAY", "SPEKE"]).optional(),
	audioMuxingKind: z.enum(["FMP4", "CMAF"]).optional(),
	// LiveDashManifest start-request surface
	timeshift: z.number().positive().optional(),
	liveEdgeOffset: z.number().min(0).optional(),
	/** Milliseconds; unset = not written to the MPD. */
	suggestedPresentationDelay: z.number().min(0).optional(),
	/** Milliseconds; unset = the API defaults to the segment duration. */
	minimumUpdatePeriod: z.number().positive().optional(),
	availabilityStartTimeMode: z
		.enum(["ON_FIRST_SEGMENT", "ON_STREAM_INGEST"])
		.optional(),
});

export const liveManifestPlanSchema = z.discriminatedUnion("kind", [
	liveHlsManifestPlanSchema,
	liveDashManifestPlanSchema,
]);
export type LiveManifestPlan = z.infer<typeof liveManifestPlanSchema>;

/** AutoRestartConfiguration — every timeout has an API minimum of 30s. */
export const liveAutoRestartSchema = z.strictObject({
	segmentsWrittenTimeout: z.number().min(30).optional(),
	bytesWrittenTimeout: z.number().min(30).optional(),
	framesWrittenTimeout: z.number().min(30).optional(),
	hlsManifestsUpdateTimeout: z.number().min(30).optional(),
	dashManifestsUpdateTimeout: z.number().min(30).optional(),
	/** Unix crontab, e.g. "0 5 * * 1". */
	scheduleExpression: z.string().min(1).optional(),
	restartOnEncoderError: z.boolean().optional(),
});

/**
 * LiveAutoShutdownConfiguration. Independent of auto-restart — a restart
 * does NOT reset these timers (SDK-documented gotcha, surfaced in UI copy).
 */
export const liveAutoShutdownSchema = z.strictObject({
	bytesReadTimeoutSeconds: z.number().int().min(30).optional(),
	streamTimeoutMinutes: z.number().int().min(5).optional(),
	waitingForFirstConnectTimeoutMinutes: z.number().int().min(5).optional(),
});

/**
 * ReuploadSettings — both intervals have an API minimum of 30s, and the
 * SDK documents explicit null as "never re-upload" (distinct from absent:
 * the payload carries the null through to disable the behavior).
 * hlsManifestInterval is deliberately absent: the SDK marks it unused (the
 * master playlist re-uploads on every media-playlist change regardless).
 */
export const liveReuploadSchema = z.strictObject({
	dashManifestInterval: z.number().min(30).nullable().optional(),
	muxingInitFileInterval: z.number().min(30).nullable().optional(),
});

/**
 * Ad-marker configuration (C14). Opt-in, default OFF: when scte35 is true the
 * compiler turns on the SCTE-35 carriers that an inserted Scte35Cue actually
 * surfaces through — `signalScte35AsEmsg` on every fMP4 muxing (the emsg-box
 * carrier, and the ONLY HLS-fMP4 carrier — HlsManifest itself has no SCTE
 * field), plus the per-manifest start-request adMarkerSettings (DASH
 * EventStream signalling, HLS #EXT-X-DATERANGE tags). Absent ⇒ nothing is
 * emitted, so existing channels/goldens stay byte-identical. Kept as an
 * object (not a bare boolean) so ESAM/marker-type knobs can land here later.
 */
export const liveAdMarkersSchema = z.strictObject({
	scte35: z.boolean(),
	/**
	 * HLS playlist marker types (LiveHlsManifest.adMarkerSettings.
	 * enabledMarkerTypes). Absent ⇒ the C14 default [EXT_X_DATERANGE] when
	 * scte35 is on — existing plans/goldens keep byte-identical payloads.
	 */
	hlsMarkerTypes: z
		.array(
			z.enum([
				"EXT_X_CUE_OUT_IN",
				"EXT_OATCLS_SCTE35",
				"EXT_X_SPLICEPOINT_SCTE35",
				"EXT_X_DATERANGE",
				"EXT_X_SCTE35",
			]),
		)
		.min(1)
		.optional(),
	/** HLS adMarkerSettings.disablePreannouncing (AWS MediaTailor compat). */
	hlsDisablePreannouncing: z.boolean().optional(),
	/** DASH adMarkerSettings.periodOption. Absent ⇒ C14 default SINGLE_PERIOD. */
	dashPeriodOption: z.enum(["SINGLE_PERIOD", "MULTI_PERIOD"]).optional(),
	/** DASH adMarkerSettings.eventStreamSignalling. Absent ⇒ C14 default XML_BIN. */
	dashEventStreamSignalling: z.enum(["XML", "XML_BIN"]).optional(),
});

/**
 * ESAM out-of-band POIS integration (StartLiveEncodingRequest.esamSettings,
 * SCTE-250). The POIS basic-auth pair rides the vault (POIS_ENDPOINT
 * provider) and resolves at execution only — the plan stays secret-free.
 */
export const liveEsamSettingsSchema = z.strictObject({
	/**
	 * POIS signal-processing URL — the encoder POSTs SignalProcessingEvents on
	 * SCTE-35 detection. REQUIRED within the group (the group itself stays
	 * optional): without an endpoint there is nowhere to send signals, yet the
	 * executor would still decrypt the vault pair (review catch M5). The
	 * wizard collapses an all-empty form to undefined, so this costs no UX.
	 */
	poisEndpoint: secretEgressUrlSchema,
	acquisitionPointIdentity: z.string().min(1).optional(),
	zoneIdentity: z.string().min(1).optional(),
	/** MILLISECONDS added to StreamTime/PTS in outbound signals. */
	adAvailOffset: z.number().int().optional(),
	/** Vault credential (POIS_ENDPOINT provider: username+password). */
	poisCredentialId: z.uuid().optional(),
});

const cacheControlValueSchema = z.strictObject({
	/** Raw Cache-Control header value, e.g. "public, max-age=0, no-cache". */
	cacheControl: z.string().min(1),
});

/**
 * StartLiveEncodingRequest.cacheControlSettings — per-artifact Cache-Control
 * headers. Honoured on S3/GCS/Azure outputs only (validator warns otherwise).
 */
export const liveCacheControlSchema = z.strictObject({
	hls: z
		.strictObject({
			multiVariantPlaylist: cacheControlValueSchema.optional(),
			variantPlaylist: cacheControlValueSchema.optional(),
		})
		.optional(),
	dash: z
		.strictObject({
			timelineManifest: cacheControlValueSchema.optional(),
			templateManifest: cacheControlValueSchema.optional(),
		})
		.optional(),
	segments: z
		.strictObject({
			initSegment: cacheControlValueSchema.optional(),
			mediaSegment: cacheControlValueSchema.optional(),
		})
		.optional(),
});

/**
 * StartLiveEncodingRequest.adInsertionSettings. clockSynchronizationMode
 * conflicts with an HLS programDateTimeSettings source when both are set
 * and differ — the ENCODING FAILS (C19 rail, not just a warning).
 */
export const liveAdInsertionSchema = z.strictObject({
	/** Gate for runtime ESAM media-point insertion (the encoder keeps ≥1 SCTE-35 data stream). */
	enableEsamMediaPointInsertion: z.boolean().optional(),
	clockSynchronizationMode: z.enum(["SYSTEM_CLOCK", "EMBEDDED"]).optional(),
});

/**
 * Start-request options. manifestGenerator is NOT a plan field — the
 * compiler pins V2 (C3) exactly like VOD JIT starts.
 */
export const liveStartSchema = z.strictObject({
	/** App selector, not provider request JSON. Absent preserves legacy Custom. */
	encodingOption: z.enum(["AUTO", "HD", "CUSTOM"]).optional(),
	/** StartLiveEncodingRequest.streamKey: a-zA-Z, 3–20 characters. */
	streamKey: z
		.string()
		.regex(/^[a-zA-Z]{3,20}$/, "Stream key is a-zA-Z, 3-20 characters"),
	/** Only valid when no codec config sets encodingMode (SDK contract). */
	liveEncodingMode: z
		.enum(["STANDARD", "SINGLE_PASS", "TWO_PASS", "THREE_PASS"])
		.optional(),
	autoRestart: liveAutoRestartSchema.optional(),
	autoShutdown: liveAutoShutdownSchema.optional(),
	reupload: liveReuploadSchema.optional(),
	/** All optional, no defaults ⇒ absent plans emit zero payload keys and
	 * the live goldens stay byte-identical (P5 PR-3). */
	esam: liveEsamSettingsSchema.optional(),
	cacheControl: liveCacheControlSchema.optional(),
	adInsertion: liveAdInsertionSchema.optional(),
});

export const liveChannelPlanSchema = z
	.strictObject({
		planVersion: z.literal(LIVE_CHANNEL_PLAN_VERSION),
		name: z.string().min(1).max(200),
		bitmovin: z.strictObject({
			/** Vault BitmovinAccount id; resolved by the orchestrator. */
			accountId: z.uuid().optional(),
			// .min(1): "" passes defaults (they fire on undefined only).
			cloudRegion: z.string().min(1).default("AUTO"),
			encoderVersion: z.string().min(1).default("STABLE"),
			fallbackCloudRegions: z.array(z.string().min(1)).max(3).optional(),
			/**
			 * Encoding.staticIpId — pin a reserved static IP (live-only in the
			 * API; consumed at ENCODING CREATE, not at live start). An already-
			 * USED IP puts the encoding in ERROR. Optional ⇒ absent plans emit
			 * zero payload keys and the 5 live goldens stay byte-identical.
			 */
			staticIpId: z.string().min(1).optional(),
			/** Encoding.labels — statistics grouping tags (plain strings). */
			labels: z.array(z.string().min(1)).optional(),
			/**
			 * Encoding.infrastructure — Cloud Connect (BYOC) pinning. The region
			 * inside the infrastructure rides here; the TOP-LEVEL cloudRegion must
			 * then be "EXTERNAL" (C18, LIVE_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION).
			 */
			infrastructure: z
				.strictObject({
					infrastructureId: z.string().min(1),
					cloudRegion: z.string().min(1),
				})
				.optional(),
		}),
		/** Exactly one live source; SRT redundancy lives inside it (backup). */
		liveInput: liveInputSchema,
		outputs: z.array(planOutputSchema).min(1),
		/**
		 * Multi-output delivery for LIVE (the Akamai customer's MSL4 + Object
		 * Storage simultaneous case, 2026-08-23): every live muxing/manifest
		 * destination is ALSO written to each other mirror output at the SAME path —
		 * a readable storage output already primary there is not duplicated.
		 * one encode, N destinations, exactly 's VOD semantics (the
		 * worker already expands `mirrorOutputIds` at the shared destination
		 * builder, so live only needed the schema + compiler refs). `.optional`
		 * (not `.default([])`) for the same golden-stability reason as VOD.
		 */
		deliveryMirrors: z
			.array(z.strictObject({ outputKey: refKey }))
			.min(1)
			.optional(),
		ingest: z.array(liveIngestSchema).min(1),
		/**
		 * Same rendition union as VOD. validateLiveChannel narrows it to the
		 * live encoder's support matrix (H264/H265 + AAC/DD/DDPLUS, STANDARD
		 * mode, no VOD-only stream attachments).
		 */
		renditions: z.array(renditionSchema).min(1),
		muxings: z.array(liveMuxingSchema).min(1),
		/** Encrypted output destinations; content keys remain vault references. */
		drm: z.array(planDrmSchema).optional(),
		/** A channel without a manifest has no playback surface. */
		liveManifests: z.array(liveManifestPlanSchema),
		/** SCTE-35 ad-marker output (C14). Absent = off (no SCTE carriers). */
		adMarkers: liveAdMarkersSchema.optional(),
		start: liveStartSchema,
	})
	.refine(
		(plan) =>
			plan.liveManifests.length > 0 ||
			plan.muxings.some(
				(m) =>
					(m.kind === "FMP4" || m.kind === "CMAF") &&
					[
						m.destination?.outputKey,
						...(plan.deliveryMirrors?.map((x) => x.outputKey) ?? []),
					].some((key) =>
						plan.outputs.some(
							(o) => o.key === key && o.kind === "LIVE_MEDIA_INGEST",
						),
					),
			),
		{
			path: ["liveManifests"],
			message:
				"At least one manifest is required unless an Origin receives Live Media Ingest",
		},
	);

export type LiveChannelPlan = z.infer<typeof liveChannelPlanSchema>;
export type LiveChannelPlanInput = z.input<typeof liveChannelPlanSchema>;
