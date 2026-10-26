import type { LiveChannelPlanInput } from "@bitovp/core";
import {
	akamaiMsl5InitSegmentName,
	akamaiMslSegmentNaming,
} from "@bitovp/core";
import type {
	WizardH264Options,
	WizardH265Options,
} from "@/app/vod/new/build-plan";
import {
	audioKeys,
	audioMuxingRelPath,
	videoKeys,
	videoMuxingRelPath,
} from "@/app/vod/new/build-plan";
import { inResourceOrder, liveMirrorEntries } from "./live-output-model";
import { applyLiveMuxingOptions } from "./live-rendition-options";

/**
 * Pure mapping from live wizard state to a LiveChannelPlan (input shape —
 * zod applies defaults at parse). Mirrors the VOD buildPlan contract: a
 * wizard-built plan for a fixture scenario parses byte-equal to the
 * committed live golden (asserted by build-live-plan.test.ts — the
 * "reproduce via UI" evidence for the P3 exit).
 *
 * Key/path derivation REUSES the VOD helpers (videoKeys/audioKeys,
 * video/audioMuxingRelPath) so v{height}/a{kbps} keys and
 * video/{height}p|audio/{bitrate} segment paths cannot drift between the
 * two wizards. Optional fields emit nothing when unset (prune) — schema
 * defaults fill at parse, keeping plans fixture-minimal.
 */

export type LiveInputKind = "RTMP" | "REDUNDANT_RTMP" | "SRT" | "ZIXI" | "HLS";

/**
 * P5 PR-3 long-tail groups (ESAM/POIS, Cache-Control, ad insertion, HLS
 * program-date-time, SCTE-35 marker knobs) carry NO wizard-specific encoding
 * — the form edits the SDK shape directly. Deriving the state types from the
 * plan input type therefore mirrors the schema verbatim and makes drift
 * impossible: a schema field added in core cannot silently miss the form.
 */
type LiveHlsManifestInput = Extract<
	LiveChannelPlanInput["liveManifests"][number],
	{ kind: "HLS" }
>;
/** LiveHlsManifest.programDateTimeSettings (source + placement). */
export type LivePdtSettingsState = NonNullable<
	LiveHlsManifestInput["programDateTimeSettings"]
>;
export type LivePdtPlacementMode = NonNullable<
	LivePdtSettingsState["placement"]
>["mode"];
/**
 * StartLiveEncodingRequest.esamSettings — POIS auth rides a vault id only.
 *
 * The wizard's copy makes EVERY field optional even though the schema requires
 * `poisEndpoint` within the group: a half-filled form must be representable
 * while the operator types. The emission (`esamGroup`) passes it through
 * verbatim, so an endpoint-less group surfaces as a loud validation error in
 * the preview rather than being silently dropped — the same contract as the
 * half-filled infrastructure pair.
 */
export type LiveEsamState = Partial<
	NonNullable<LiveChannelPlanInput["start"]["esam"]>
>;
/** StartLiveEncodingRequest.cacheControlSettings (6 leaves: HLS/DASH/segments). */
export type LiveCacheControlState = NonNullable<
	LiveChannelPlanInput["start"]["cacheControl"]
>;
/** One `{cacheControl: "…"}` leaf. */
export type LiveCacheControlValue = NonNullable<
	NonNullable<LiveCacheControlState["hls"]>["multiVariantPlaylist"]
>;
/** StartLiveEncodingRequest.adInsertionSettings. */
export type LiveAdInsertionState = NonNullable<
	LiveChannelPlanInput["start"]["adInsertion"]
>;
/** plan.adMarkers minus the scte35 gate — the configurable carriers (C14). */
export type LiveAdMarkerOptionsState = Omit<
	NonNullable<LiveChannelPlanInput["adMarkers"]>,
	"scte35"
>;
export type LiveHlsMarkerType = NonNullable<
	LiveAdMarkerOptionsState["hlsMarkerTypes"]
>[number];

export type LiveSrtBackupRow = {
	mode: "LISTENER" | "CALLER";
	host: string;
	path?: string;
	port?: number;
	latency?: number;
	credentialId: string;
	keyLength: 128 | 256;
};

export type LiveRedundantIngestPoint = {
	applicationName: string;
	streamKey: string;
};

export type LiveCmafOptions = {
	initSegmentNameTemplate?: string;
	framesPerCmafChunk?: number;
};

export type LiveInputSelection = {
	/** Retained for imported references; never edited as a resource key. */
	key?: string;
	position?: number;
	inputPath?: string;
};

export type LiveMuxingOptions = {
	segmentNaming?: string;
	segmentNamingTemplate?: string;
	initSegmentName?: string;
	/** Complete subdirectory on the selected output, overriding automatic paths. */
	path?: string;
};

/**
 * rev433 (owner 2026-09-07): with STATIC ingest points the stream key an
 * encoder pushes with is the point's own (`streamKeyConfiguration`
 * GENERATE / ASSIGN), so the wizard neither asks for nor shows the start
 * request's `streamKey`; `staticIngestStartKey` fills the request field
 * the API still requires with a deterministic, valid placeholder.
 */
export function streamKeyManagedByIngestPoint(
	state: Pick<LiveWizardState, "inputKind" | "redundantRtmp">,
): boolean {
	return (
		state.inputKind === "REDUNDANT_RTMP" &&
		state.redundantRtmp.pointsMode === "STATIC" &&
		state.redundantRtmp.staticIngestPoints.length > 0
	);
}

/** The start request's placeholder key for a static-ingest channel: letters only, 3–20. */
export function staticIngestStartKey(pointName: string): string {
	const letters = pointName.replace(/[^a-zA-Z]/g, "");
	return `auto${letters}`.slice(0, 20);
}

export type LiveStaticIngestPoint = {
	name: string;
	/** "" = no streamKeyConfiguration block. */
	streamKeyType: "" | "GENERATE" | "ASSIGN";
	streamKeyId: string;
};

export type LiveVideoRendition = {
	input?: LiveInputSelection;
	muxing?: LiveMuxingOptions;
	/** Stable form identity, preserved when editing a rendition. */
	extras?: { key?: string; hlsVariantUri?: string };
	codec: "H264" | "H265";
	/** Explicit H264/H265 output width; absent preserves input aspect ratio. */
	width?: number;
	height: number | null;
	bitrate: number | null;
	/** Display-name override; absent = derived "Live {codec} {height}p". */
	name?: string;
	/** LIVE_* strongly recommended — the validator warns on VOD_* (rail). */
	presetConfiguration?: string;
	/** Fragmented MP4 (HLS/DASH) or TS (HLS only; H264 only). */
	container?: "FMP4" | "CMAF" | "TS";
	cmaf?: LiveCmafOptions;
	/**
	 * Audio renditions that ride INSIDE this rung's container .
	 *
	 * The relation lives on the carrier so a channel can say videoA←audioA,
	 * videoB←audioB, videoC←audioA, videoD←nothing. A flag on the audio row
	 * could only broadcast one track to every rung of its kind, which is the
	 * design the owner rejected.
	 *
	 * TS only: `additionalStreamKeys` is on the TS and MP4 schemas and live has
	 * no MP4, so the builder drops these for an fMP4 rung.
	 */
	muxedAudioKeys?: string[];
	h264?: WizardH264Options;
	h265?: WizardH265Options;
};

export type LiveAudioRendition = {
	input?: LiveInputSelection;
	muxing?: LiveMuxingOptions;
	/** Stable form identity, preserved when editing a rendition. */
	extras?: { key?: string };
	codec: "AAC" | "DDPLUS" | "DD";
	bitrate: number;
	rate: number;
	channelLayout?: string;
	container?: "FMP4" | "CMAF" | "TS";
	cmaf?: LiveCmafOptions;
	/**
	 * Build a standalone container for this track? Default yes .
	 *
	 * Which containers CARRY it is stated on the video rungs, not here — see
	 * `LiveVideoRendition.muxedAudioKeys`. `false` while nothing carries the
	 * track would delete it from the delivery, so the builder ignores it in
	 * that case.
	 */
	ownContainer?: boolean;
};

type LiveManifestIdentity = {
	key?: string;
	name?: string;
	destination?: LiveChannelPlanInput["liveManifests"][number]["destination"];
};

export type LiveHlsManifestState = LiveManifestIdentity & {
	enabled: boolean;
	manifestName: string;
	audioGroupId: string;
	audioLanguage: string;
	closedCaptions?: string;
	/** Pin one muxing family when renditions carry both FMP4 and TS legs. */
	videoMuxingKind: "" | "FMP4" | "TS";
	audioMuxingKind: "" | "FMP4" | "TS";
	/** DVR window (seconds) — C8-gauged, never clamped. */
	timeshift?: number;
	liveEdgeOffset?: number;
	insertProgramDateTime: boolean;
	/** Retain an explicitly disabled imported setting, distinct from omission. */
	insertProgramDateTimeExplicit?: boolean;
	/**
	 * PDT source + placement. A source set here must MATCH
	 * start.adInsertion.clockSynchronizationMode when both are set — mismatched
	 * modes FAIL the encoding (C19, LIVE_CLOCK_SYNC_PDT_CONFLICT).
	 */
	programDateTimeSettings?: LivePdtSettingsState;
};

export type LiveDashManifestState = LiveManifestIdentity & {
	enabled: boolean;
	manifestName: string;
	audioLanguage: string;
	representationType: "TEMPLATE" | "TIMELINE";
	timeshift?: number;
	liveEdgeOffset?: number;
	/** Milliseconds (SDK field unit). */
	suggestedPresentationDelay?: number;
	minimumUpdatePeriod?: number;
	availabilityStartTimeMode: "" | "ON_FIRST_SEGMENT" | "ON_STREAM_INGEST";
};

export type LiveStartState = {
	/** Internal policy; omitted saved plans retain their original Custom start. */
	encodingOption?: "AUTO" | "HD" | "CUSTOM";
	streamKey: string;
	liveEncodingMode: "" | "STANDARD" | "SINGLE_PASS" | "TWO_PASS" | "THREE_PASS";
	autoRestart: {
		segmentsWrittenTimeout?: number;
		bytesWrittenTimeout?: number;
		framesWrittenTimeout?: number;
		hlsManifestsUpdateTimeout?: number;
		dashManifestsUpdateTimeout?: number;
		scheduleExpression: string;
		/** Undefined preserves an omitted provider setting; false disables it. */
		restartOnEncoderError?: boolean;
	};
	autoShutdown: {
		bytesReadTimeoutSeconds?: number;
		streamTimeoutMinutes?: number;
		waitingForFirstConnectTimeoutMinutes?: number;
	};
	/** Explicit null = "never re-upload" (the checkbox), undefined = unset. */
	reupload: {
		dashManifestInterval?: number | null;
		muxingInitFileInterval?: number | null;
	};
	/**
	 * P5 PR-3 signaling & delivery groups — each collapses to undefined once
	 * its form is cleared, so an untouched wizard emits zero plan keys.
	 */
	esam?: LiveEsamState;
	cacheControl?: LiveCacheControlState;
	adInsertion?: LiveAdInsertionState;
};

export type LiveWizardState = {
	name: string;
	accountId: string;
	cloudRegion: string;
	encoderVersion: string;
	/**
	 * Encoding.staticIpId — pin a reserved static IP (bitmovin.staticIpId,
	 * live-only in the API; consumed at ENCODING CREATE). An already-USED IP
	 * puts the encoding in ERROR. Optional ⇒ absent emits no plan key.
	 */
	staticIpId?: string;
	/** Encoding.labels — statistics grouping tags (bitmovin.labels). */
	labels?: string[];
	/** Encoding.infrastructure — Cloud Connect (BYOC) pinning. */
	infrastructure?: { infrastructureId: string; cloudRegion: string };
	inputKind: LiveInputKind;
	/**
	 * Account-default RTMP input. : an empty id keeps the
	 * resolve-by-list contract (which refuses ambiguity); a pinned id is used
	 * verbatim, for accounts carrying several RTMP inputs.
	 */
	rtmp: { inputId: string };
	redundantRtmp: {
		name: string;
		delayThreshold?: number;
		/** XOR — the SDK forbids mixing dynamic and static ingest points. */
		pointsMode: "DYNAMIC" | "STATIC";
		ingestPoints: LiveRedundantIngestPoint[];
		staticIngestPoints: LiveStaticIngestPoint[];
	};
	srt: {
		name: string;
		mode: "LISTENER" | "CALLER";
		host: string;
		/** LISTENER mode is restricted to 2088–2091 (SDK). */
		listenerPort: number;
		callerPort?: number;
		path: string;
		latency?: number;
		/** Vault SRT_PASSPHRASE credential ref — never the passphrase itself. */
		credentialId: string;
		keyLength: 128 | 256;
		backupDelayThreshold?: number;
		backups: LiveSrtBackupRow[];
	};
	zixi: {
		name: string;
		host: string;
		port?: number;
		stream: string;
		/** Vault ZIXI credential ref (password and/or decryptionKey). */
		credentialId: string;
		latency?: number;
		minBitrate?: number;
		decryptionType: string;
	};
	hlsIn: {
		name: string;
		url: string;
		adMarkersSource: "" | "MANIFEST" | "SEGMENTS";
	};
	output: {
		credentialId: string;
		/**
		 * Public-read ACL on every destination this channel writes — manifests AND
		 * segments. A public manifest over private segments is unplayable, so this
		 * is one switch, exactly as the VOD wizard treats it.
		 */
		publicRead: boolean;
		/** Preserve imported PRIVATE ACLs separately from an unspecified ACL. */
		explicitPrivateAcl?: boolean;
		kind:
			| "S3"
			| "AZURE"
			| "SFTP"
			| "GENERIC_S3"
			| "GCS"
			| "GCS_SERVICE_ACCOUNT"
			| "AKAMAI_NETSTORAGE"
			| "AKAMAI_MSL"
			| "LIVE_MEDIA_INGEST";
		/** S3/GenericS3/GCS bucket / Azure container. */
		bucket: string;
		basePath: string;
		name: string;
		/**
		 * Akamai MSL only . NOT the identity — that lives in the
		 * credential, like every other output's address. This is the delivery
		 * format, which constrains the ENCODING (C31), so it is a per-channel
		 * choice and belongs in the plan.
		 *
		 * The wizard state carried `streamId`/`eventName` for one day, behind a
		 * bespoke destination selector and a discriminated union. Making MSL a
		 * credential deleted all of it: the output step is credential-first, and
		 * MSL is no longer the exception to that.
		 */
		mslStreamFormat?: "DASH" | "HLS" | "CMAF";
		/**
		 * MSL protocol version —  PR 1, and the wizard did not model
		 * it at all until the `live-akamai-msl5` fixture's round-trip said so.
		 * Without this the form could only ever author MSL4, whatever the
		 * schema allowed, so MSL5 was reachable by raw-JSON import alone.
		 *
		 * A PLAN choice, not an account fact — the same argument
		 * `mslStreamFormat` won: one provisioned Akamai stream can be addressed
		 * over either protocol, so the version belongs to the channel rather
		 * than to the credential.
		 */
		mslVersion?: "MSL4" | "MSL5";
		scte35Passthrough?: boolean;
	};
	/**
	 * Optional SECOND destination, delivered as a live deliveryMirror
	 * (2026-08-23, the Akamai MSL4 + Object Storage simultaneous case): every
	 * muxing/manifest destination is also written here at the same path — one
	 * encode, both destinations. Same shape as `output`; emitted as outputs[1]
	 * with key "mirror-1" + deliveryMirrors: [{outputKey: "mirror-1"}]. The
	 * form authors storage mirrors; imports retain their exact representation.
	 * Delivery paths/ACL come from the primary destinations, not mirror fields.
	 */
	mirror?: LiveWizardState["output"];
	mirrorKey?: string;
	additionalMirrors?: { key: string; output: LiveWizardState["output"] }[];
	/** Imported resource order is independent of mirror-reference order. */
	outputOrder?: string[];
	manifestOrder?: string[];
	/** Preserve imported source selection order independently of rendition order. */
	ingestOrder?: string[];
	/** One progressive archive, reusing existing streams. No separate encode.
	 * Keep the schema shape so imported names, paths and ACL remain verbatim.
	 * output is absent when the archive explicitly references origin/mirror-1.
	 */
	archive?: {
		muxing: Extract<
			LiveChannelPlanInput["muxings"][number],
			{ kind: "MP4" }
		> & {
			destination: NonNullable<
				LiveChannelPlanInput["muxings"][number]["destination"]
			>;
		};
		output?: LiveWizardState["output"];
	};
	videos: LiveVideoRendition[];
	audios: LiveAudioRendition[];
	/** Shared muxing segment length (seconds) — feeds the C8 gauge. */
	segmentLength: number;
	manifests: {
		hls: LiveHlsManifestState;
		dash: LiveDashManifestState;
		additionalHls?: LiveHlsManifestState[];
		additionalDash?: LiveDashManifestState[];
	};
	/** SCTE-35 ad markers (C14) — off by default; plan-level (fMP4 + manifests). */
	scte35AdMarkers: boolean;
	/**
	 * Carrier knobs beside the gate. Emitted INTO plan.adMarkers only while
	 * scte35AdMarkers is on; absent ⇒ the C14 defaults ([EXT_X_DATERANGE] /
	 * SINGLE_PERIOD / XML_BIN) and byte-identical payloads for old plans.
	 */
	adMarkerOptions?: LiveAdMarkerOptionsState;
	start: LiveStartState;
};

export const DEFAULT_LIVE_WIZARD_STATE: LiveWizardState = {
	name: "",
	accountId: "",
	cloudRegion: "AUTO",
	encoderVersion: "BETA",
	//  (owner 2026-08-17): static RTMPS ingest is the RECOMMENDED
	// default — the pushable URL exists from creation, before any encoder or
	// provisioning. Per-IP RTMP and SRT stay one select away.
	inputKind: "REDUNDANT_RTMP",
	rtmp: { inputId: "" },
	redundantRtmp: {
		name: "",
		pointsMode: "STATIC",
		ingestPoints: [{ applicationName: "liveA", streamKey: "" }],
		staticIngestPoints: [
			/*
			 * Born NAMED (owner decision (b) 2026-08-21). A point
			 * whose name prunes to absent is valid to our schema (`min(1)
			 * .optional`) and refused by Bitmovin with its least helpful
			 * message — "One or more fields are not present or invalid
			 * (code 1000)" — measured on the real API. Static RTMPS is the
			 * recommended default (#114), so an empty name sat on the path of
			 * least resistance.
			 */
			{ name: "primary", streamKeyType: "GENERATE", streamKeyId: "" },
		],
	},
	srt: {
		name: "",
		mode: "LISTENER",
		host: "",
		listenerPort: 2088,
		path: "",
		credentialId: "",
		keyLength: 256,
		backups: [],
	},
	zixi: {
		name: "",
		host: "",
		stream: "",
		credentialId: "",
		decryptionType: "",
	},
	hlsIn: { name: "", url: "", adMarkersSource: "" },
	output: {
		credentialId: "",
		kind: "S3",
		publicRead: false,
		bucket: "",
		basePath: "",
		name: "",
	},
	videos: [
		{
			codec: "H264",
			width: 1280,
			height: 720,
			bitrate: 3_000_000,
			presetConfiguration: "LIVE_STANDARD",
			h264: { rate: 30 },
		},
	],
	audios: [{ codec: "AAC", bitrate: 128_000, rate: 48_000 }],
	segmentLength: 6,
	manifests: {
		hls: {
			enabled: true,
			manifestName: "",
			audioGroupId: "",
			audioLanguage: "",
			videoMuxingKind: "",
			audioMuxingKind: "",
			insertProgramDateTime: false,
		},
		dash: {
			enabled: false,
			manifestName: "",
			audioLanguage: "",
			representationType: "TEMPLATE",
			availabilityStartTimeMode: "",
		},
	},
	scte35AdMarkers: false,
	start: {
		encodingOption: "AUTO",
		streamKey: "",
		liveEncodingMode: "",
		autoRestart: { scheduleExpression: "" },
		autoShutdown: {},
		reupload: {},
	},
};

/** Drops undefined-valued keys; explicit nulls survive (reupload "never"). */
function prune<T extends Record<string, unknown>>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			out[key] = entry;
		}
	}
	return out as T;
}

/** "" → undefined for optional text inputs (strict schemas reject ""). */
function str(value: string | undefined): string | undefined {
	return value === "" || value === undefined ? undefined : value;
}

/** Older drafts stored Advanced edits inside the codec options. */
export function liveVideoPreset(
	video: LiveVideoRendition,
): string | null | undefined {
	const nested =
		video.codec === "H264"
			? video.h264?.presetConfiguration
			: video.h265?.presetConfiguration;
	return nested === null
		? null
		: str(nested === undefined ? video.presetConfiguration : nested);
}

/** Pruned group object, or undefined when every field is unset. */
function group<T extends Record<string, unknown>>(value: T): T | undefined {
	const pruned = prune(value);
	return Object.keys(pruned).length > 0 ? pruned : undefined;
}

/**
 * Form-side counterpart of `group`: an options group held in wizard state
 * collapses to undefined once every field is cleared, so a filled-then-emptied
 * form emits no plan key at all (the sections patch through this).
 */
export function collapseGroup<T extends object>(value: T): T | undefined {
	return Object.values(value).some((entry) => entry !== undefined)
		? value
		: undefined;
}

type LivePlanInputUnion = LiveChannelPlanInput["liveInput"];
type LiveRenditionInput = LiveChannelPlanInput["renditions"][number];
type LiveMuxingInput = LiveChannelPlanInput["muxings"][number];
type LiveManifestInput = LiveChannelPlanInput["liveManifests"][number];
type LiveOutputInput = LiveChannelPlanInput["outputs"][number];

/** Base output path without a trailing slash (manifest destination form). */
export function liveBasePath(state: LiveWizardState): string {
	const raw = state.output.basePath;
	return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function joinPath(base: string, rel: string): string {
	return base === "" ? rel : `${base}/${rel}`;
}

/**
 * Ingest-input-stream inputPath. The account-default RTMP input is reached via
 * the "live" RTMP application (Bitmovin's Python live-RTMP sample uses
 * input_path="live"). CREATED inputs (redundant RTMP / SRT / Zixi / HLS) ingest
 * at the root "/" — matching Bitmovin's own live .bitmovin.yml templates, where
 * the application is defined by the input's ingest point, not the path.
 */
export function ingestInputPath(inputKind: LiveInputKind): string {
	return inputKind === "RTMP" ? "live" : "/";
}

/** Allocate selection keys privately while keeping untouched legacy plans exact. */
function buildIngest(
	state: LiveWizardState,
	videoKeys: string[],
	audioKeys: string[],
) {
	const groups = [
		{ rows: state.videos, keys: videoKeys, key: "video", position: 0 },
		{ rows: state.audios, keys: audioKeys, key: "audio", position: 1 },
	];
	const reserved = new Set([
		"video",
		"audio",
		...groups.flatMap(({ rows }) => rows.map((row) => row.input?.key)),
	]);
	const selections = new Map<string, LiveChannelPlanInput["ingest"][number]>();
	const keys = groups.map(({ rows, keys, key, position }) =>
		rows.map((row, index) => {
			let selectionKey = row.input?.key ?? key;
			if (
				(row.input?.position !== undefined ||
					row.input?.inputPath !== undefined) &&
				!row.input.key
			) {
				const prefix = `input-${keys[index] ?? `${key}${index + 1}`}`.slice(
					0,
					58,
				);
				selectionKey = prefix;
				let n = 2;
				while (reserved.has(selectionKey)) selectionKey = `${prefix}-${n++}`;
				reserved.add(selectionKey);
			}
			const selection = {
				key: selectionKey,
				inputPath: row.input?.inputPath ?? ingestInputPath(state.inputKind),
				position: row.input?.position ?? position,
			};
			const previous = selections.get(selectionKey);
			if (
				previous &&
				(previous.position !== selection.position ||
					previous.inputPath !== selection.inputPath)
			)
				throw new Error(
					"Renditions sharing an input selection must use the same position and input path.",
				);
			selections.set(selectionKey, selection);
			return selectionKey;
		}),
	);
	return {
		ingest: inResourceOrder(
			[...selections.values()],
			state.ingestOrder ?? ["video", "audio"],
		),
		video: keys[0] ?? [],
		audio: keys[1] ?? [],
	};
}

function buildLiveInput(state: LiveWizardState): LivePlanInputUnion {
	switch (state.inputKind) {
		case "RTMP":
			// : an empty id emits NO inputId key, keeping the
			// resolve-by-list payload ({}) byte-identical.
			return prune({
				key: "main",
				kind: "RTMP" as const,
				inputId: str(state.rtmp.inputId),
			});
		case "REDUNDANT_RTMP": {
			const r = state.redundantRtmp;
			return prune({
				key: "main",
				kind: "REDUNDANT_RTMP" as const,
				name: str(r.name),
				delayThreshold: r.delayThreshold,
				ingestPoints:
					r.pointsMode === "DYNAMIC"
						? r.ingestPoints.map((p) => ({
								applicationName: p.applicationName,
								streamKey: p.streamKey,
							}))
						: undefined,
				staticIngestPoints:
					r.pointsMode === "STATIC"
						? r.staticIngestPoints.map((p, index) =>
								prune({
									/*
									 * Fallback, not just prune . The FORM
									 * defaults are the ordinary shield, but imported
									 * state, presets and hand-cleared fields all reach
									 * this map too — and a nameless point is a measured
									 * code-1000 refusal at the API, reported against no
									 * field the operator can see.
									 */
									/*
									 * TRIMMED before the fallback test: "  " passes the
									 * schema's min(1) and would ride to the API as a
									 * whitespace name — the fallback's own test drove
									 * that edge and went red before this line existed.
									 */
									name: str(p.name)?.trim() || staticPointFallbackName(index),
									streamKeyConfiguration:
										p.streamKeyType === ""
											? undefined
											: prune({
													type: p.streamKeyType,
													streamKeyId:
														p.streamKeyType === "ASSIGN"
															? str(p.streamKeyId)
															: undefined,
												}),
								}),
							)
						: undefined,
			});
		}
		case "SRT": {
			const s = state.srt;
			const connection = (row: {
				mode: "LISTENER" | "CALLER";
				host: string;
				port: number;
				latency?: number;
				credentialId: string;
				keyLength: 128 | 256;
				path?: string;
			}) =>
				prune({
					mode: row.mode,
					host: row.mode === "CALLER" ? str(row.host) : undefined,
					port: row.port,
					path: str(row.path),
					latency: row.latency,
					credentialId: str(row.credentialId),
					// keyLength describes the vaulted passphrase — emit only with it.
					keyLength: str(row.credentialId) ? row.keyLength : undefined,
				});
			return prune({
				key: "main",
				kind: "SRT" as const,
				name: str(s.name),
				...connection({
					mode: s.mode,
					host: s.host,
					port: s.mode === "LISTENER" ? s.listenerPort : (s.callerPort ?? 0),
					latency: s.latency,
					credentialId: s.credentialId,
					keyLength: s.keyLength,
					path: s.path,
				}),
				backup:
					s.backups.length > 0
						? prune({
								delayThreshold: s.backupDelayThreshold,
								srtInputs: s.backups.map((b) =>
									connection({
										mode: b.mode,
										host: b.host,
										path: b.path,
										port: b.port ?? 0,
										latency: b.latency,
										credentialId: b.credentialId,
										keyLength: b.keyLength,
									}),
								),
							})
						: undefined,
			});
		}
		case "ZIXI": {
			const z = state.zixi;
			return prune({
				key: "main",
				kind: "ZIXI" as const,
				name: str(z.name),
				host: z.host,
				port: z.port ?? 0,
				stream: z.stream,
				credentialId: z.credentialId,
				latency: z.latency,
				minBitrate: z.minBitrate,
				decryptionType: str(z.decryptionType),
			});
		}
		case "HLS": {
			const h = state.hlsIn;
			return prune({
				key: "main",
				kind: "HLS" as const,
				name: str(h.name),
				url: str(h.url),
				adMarkersSource:
					h.adMarkersSource === "" ? undefined : h.adMarkersSource,
			});
		}
	}
}

/**
 * Apply an MSL stream format to the LADDER, not only to the label (C31,
 * ).
 *
 * `streamFormat` constrains the encoding: DASH wants fMP4 segments and a DASH
 * manifest, HLS wants TS segments and an HLS manifest, CMAF wants fMP4 and
 * both. Offering the three in a dropdown while leaving the ladder where it was
 * would make two of the three options produce a save-time error the operator
 * did not cause — present but not selectable, which is not the same as
 * selectable. So the choice moves the segment container on every rendition and
 * switches the manifest families with it.
 *
 * TS is H264-only (the ladder rail says so, and the validator enforces it), so
 * an H265 ladder under HLS is left to the validator to report rather than
 * silently rewritten — changing a codec is not a formatting decision.
 *
 * Follows C1's established pattern: the wizard auto-switches and explains,
 * rather than validating at the operator afterwards.
 */
export function withMslStreamFormat(
	state: LiveWizardState,
	streamFormat: "DASH" | "HLS" | "CMAF",
): LiveWizardState {
	const container =
		streamFormat === "HLS" ? ("TS" as const) : ("FMP4" as const);
	return {
		...state,
		videos: state.videos.map((v) => ({ ...v, container })),
		audios: state.audios.map((a) => ({ ...a, container })),
		manifests: {
			...state.manifests,
			hls: {
				...state.manifests.hls,
				enabled: streamFormat !== "DASH",
				/**
				 * CLEARED, not pinned (review-7 Critical 1).
				 *
				 * The first cut set these to the format's container, reasoning
				 * that a matching pin is harmless. It is not: the pin is an
				 * invisible FILTER that outlives everything after it. Choose
				 * MSL/HLS, go back to the ladder step, add a rendition — the
				 * new rung carries the schema default container, the pin
				 * deselects it, and it is encoded, written to the Akamai
				 * stream, and present in no playlist. A reviewer walked exactly
				 * that path through the real UI.
				 *
				 * With no pin every leg is selected, so a container that does
				 * not belong surfaces as a C31 warning naming the output
				 * instead of disappearing, and `LIVE_MUXING_UNREFERENCED`
				 * catches whatever still slips through.
				 */
				videoMuxingKind: "",
				audioMuxingKind: "",
			},
			dash: { ...state.manifests.dash, enabled: streamFormat !== "HLS" },
		},
		// The format belongs on the OUTPUT too, or this function's name is a
		// lie and the next caller builds a plan whose output says HLS over a
		// DASH ladder — which C31 then reports as the OPERATOR's error
		// (review-7 S1).
		...(state.output.kind === "AKAMAI_MSL"
			? { output: { ...state.output, mslStreamFormat: streamFormat } }
			: {}),
	};
}

/**
 * Switch the output step between object storage and Akamai MSL .
 *
 * A pure transition living beside the state it changes, rather than a closure
 * inside the wizard — the previous MSL UI shipped as an untestable inline
 * branch and a reviewer's condition-swap passed the whole web suite (review-6
 * I1). Same lesson, applied ahead of time.
 *
 * Why the step needs this at all: output kind used to be derived ONLY from the
 * chosen credential's provider, so a destination with no credential could not
 * be reached from the form. That was our implementation choice, not an API
 * constraint — `POST /encoding/outputs/akamai-msl` carries streamId, eventName,
 * streamFormat and mslVersion, and authenticates with the account API key in a
 * header. The owner asked why MSL was not selectable; this is the answer.
 */
/**
 * `withMslStreamFormat` used to be joined here by `outputDestinationOf` and
 * `withOutputDestination` — a destination selector, a discriminated state
 * union, and a remembered-identity slot, all of which existed because MSL was
 * the one output with no credential.
 *
 * Making MSL a credential  deleted the lot. The
 * output step picks a credential like it always did, and the only MSL-specific
 * state left is the delivery format, which is a plan choice rather than an
 * account fact.
 */
/**
 * Default names for static ingest points, by position . "primary"
 * and "backup" mirror the two-slot redundant-RTMP shape the detail screen and
 * the feeder tests already speak; further points fall back to an index name.
 */
export function staticPointFallbackName(index: number): string {
	return index === 0
		? "primary"
		: index === 1
			? "backup"
			: `ingest-${index + 1}`;
}

function buildOutput(state: LiveWizardState): LiveOutputInput {
	return buildOutputFrom(state.output, "origin");
}

/**
 * One destination → one plan output. Parameterized by KEY (2026-08-23): the
 * mirror destination (live deliveryMirrors — the Akamai MSL4+storage case)
 * emits the same shapes under "mirror-1", the VOD #115 naming.
 */
function buildOutputFrom(
	o: LiveWizardState["output"],
	key: string,
): LiveOutputInput {
	if (o.kind === "LIVE_MEDIA_INGEST")
		return prune({
			key,
			kind: o.kind,
			credentialId: o.credentialId,
			name: str(o.name),
			scte35Passthrough: o.scte35Passthrough,
		});
	if (o.kind === "AKAMAI_MSL") {
		return prune({
			key,
			kind: "AKAMAI_MSL" as const,
			credentialId: o.credentialId,
			streamFormat: o.mslStreamFormat ?? "HLS",
			// Omitted when MSL4 so the schema's own `.default("MSL4")` fills it,
			// which is what keeps every existing MSL4 golden byte-identical.
			...(o.mslVersion === "MSL5" ? { mslVersion: "MSL5" as const } : {}),
			name: str(o.name),
		});
	}
	if (o.kind === "AZURE") {
		return prune({
			key,
			kind: "AZURE" as const,
			credentialId: o.credentialId,
			container: o.bucket,
			name: str(o.name),
		});
	}
	if (o.kind === "SFTP" || o.kind === "AKAMAI_NETSTORAGE") {
		// . Credential only — no bucket. The fall-through below
		// carries one, and `prune` drops only `undefined`, so a NetStorage
		// output emitted `bucket: ""` and `liveChannelPlanSchema` (strict)
		// refused the plan with "Unrecognized key: bucket" — naming a field the
		// form had just shown the operator. Reachable the moment a NetStorage
		// credential exists, because the credential picker sets the kind.
		return prune({
			key,
			kind: o.kind,
			credentialId: o.credentialId,
			name: str(o.name),
		});
	}
	// S3 / GENERIC_S3 / GCS / GCS_SERVICE_ACCOUNT — all bucket + credential.
	// AZURE, SFTP, NetStorage and MSL all returned above; the cast names what
	// is left rather than widening the union.
	return prune({
		key,
		kind: o.kind as "S3" | "GENERIC_S3" | "GCS" | "GCS_SERVICE_ACCOUNT",
		credentialId: o.credentialId,
		bucket: o.bucket,
		name: str(o.name),
	});
}

function videoRendition(
	video: LiveVideoRendition,
	key: string,
	ingestKey: string,
): LiveRenditionInput {
	const derivedName =
		video.height === null
			? `Live ${video.codec} (${key})`
			: `Live ${video.codec} ${video.height}p`;
	if (video.codec === "H265") {
		const o = video.h265 ?? {};
		return prune({
			key,
			codec: "H265" as const,
			hlsVariantUri: video.extras?.hlsVariantUri,
			name: str(video.name) ?? derivedName,
			ingestKey,
			height: video.height,
			bitrate: video.bitrate,
			presetConfiguration: liveVideoPreset(video) ?? undefined,
			profile: o.profile,
			width: video.width,
			crf: o.crf,
			minBitrate: o.minBitrate,
			bframes: o.bframes,
			refFrames: o.refFrames,
			qp: o.qp,
			qpMax: o.qpMax,
			strictCbr: o.strictCbr,
			minGop: o.minGop,
			maxGop: o.maxGop,
			openGop: o.openGop,
			sampleAspectRatioNumerator: o.sampleAspectRatioNumerator,
			sampleAspectRatioDenominator: o.sampleAspectRatioDenominator,
			displayAspectRatio: o.displayAspectRatio,
			level: str(o.level),
			rate: o.rate,
			maxBitrate: o.maxBitrate,
			bufsize: o.bufsize,
			levelHighTier: o.levelHighTier,
			dynamicRangeFormat: o.dynamicRangeFormat,
			minKeyframeInterval: o.minKeyframeInterval,
			maxKeyframeInterval: o.maxKeyframeInterval,
			rcLookahead: o.rcLookahead,
			subMe: o.subMe,
			maxCtuSize: str(o.maxCtuSize),
			motionSearch: str(o.motionSearch),
			tuIntraDepth: str(o.tuIntraDepth),
			tuInterDepth: str(o.tuInterDepth),
			weightPredictionOnPSlice: o.weightPredictionOnPSlice,
			weightPredictionOnBSlice: o.weightPredictionOnBSlice,
			sceneCutThreshold: o.sceneCutThreshold,
			motionSearchRange: o.motionSearchRange,
			adaptiveQuantizationMode: str(o.adaptiveQuantizationMode),
			adaptiveQuantizationStrength: o.adaptiveQuantizationStrength,
			psyRateDistortionOptimization: o.psyRateDistortionOptimization,
			psyRateDistortionOptimizedQuantization:
				o.psyRateDistortionOptimizedQuantization,
			qpMin: o.qpMin,
			sao: o.sao,
			hdr: o.hdr,
			masterDisplay: str(o.masterDisplay),
			maxContentLightLevel: o.maxContentLightLevel,
			maxPictureAverageLightLevel: o.maxPictureAverageLightLevel,
			pixelFormat: str(o.pixelFormat),
			colorConfig: o.colorConfig ? group(o.colorConfig) : undefined,
			// VOD-only — passed through so LIVE_RENDITION_FEATURE_UNSUPPORTED
			// rejects loudly instead of the builder silently dropping it.
			dolbyVisionMetadata: o.dolbyVisionMetadata,
		});
	}
	const o = video.h264 ?? {};
	return prune({
		key,
		codec: "H264" as const,
		hlsVariantUri: video.extras?.hlsVariantUri,
		name: str(video.name) ?? derivedName,
		ingestKey,
		width: video.width,
		height: video.height,
		bitrate: video.bitrate,
		presetConfiguration: liveVideoPreset(video),
		profile: o.profile,
		crf: o.crf,
		minBitrate: o.minBitrate,
		maxBitrate: o.maxBitrate,
		bufsize: o.bufsize,
		minGop: o.minGop,
		maxGop: o.maxGop,
		openGop: o.openGop,
		sampleAspectRatioNumerator: o.sampleAspectRatioNumerator,
		sampleAspectRatioDenominator: o.sampleAspectRatioDenominator,
		displayAspectRatio: o.displayAspectRatio,
		level: str(o.level),
		rate: o.rate,
		minKeyframeInterval: o.minKeyframeInterval,
		maxKeyframeInterval: o.maxKeyframeInterval,
		slices: o.slices,
		trellis: str(o.trellis),
		mvSearchRangeMax: o.mvSearchRangeMax,
		rcLookahead: o.rcLookahead,
		subMe: str(o.subMe),
		motionEstimationMethod: str(o.motionEstimationMethod),
		sceneCutThreshold: o.sceneCutThreshold,
		adaptiveQuantizationMode: str(o.adaptiveQuantizationMode),
		adaptiveQuantizationStrength: o.adaptiveQuantizationStrength,
		mvPredictionMode: str(o.mvPredictionMode),
		psyRateDistortionOptimization: o.psyRateDistortionOptimization,
		psyTrellis: o.psyTrellis,
		refFrames: o.refFrames,
		bframes: o.bframes,
		cabac: o.cabac,
		adaptiveSpatialTransform: o.adaptiveSpatialTransform,
		weightedPredictionPFrames: o.weightedPredictionPFrames,
		colorConfig: o.colorConfig ? group(o.colorConfig) : undefined,
	});
}

function audioRendition(
	audio: LiveAudioRendition,
	key: string,
	ingestKey: string,
): LiveRenditionInput {
	return prune({
		key,
		codec: audio.codec,
		ingestKey,
		bitrate: audio.bitrate,
		rate: audio.rate,
		channelLayout: str(audio.channelLayout),
	});
}

/**
 * Does this track travel inside the video containers rather than its own?
 *
 * TS only, and the container check is load-bearing rather than defensive: the
 * plan schema carries `additionalStreamKeys` on TS and MP4, and live has no
 * MP4. An audio row left on fMP4 with the muxed choice would otherwise vanish
 * from the plan entirely — no container of its own, and no video container
 * able to hold it.
 */
/**
 * The audio keys a video rung actually carries.
 *
 * TS only, and the container check is load-bearing rather than tidy:
 * `additionalStreamKeys` is on the TS schema and live has no MP4, so a muxed
 * choice on an fMP4 rung would be unrepresentable. Dropping it here keeps the
 * track in its own container, which is a working delivery.
 */
function carriedByRung(
	video: LiveVideoRendition,
	audioKeys: ReadonlySet<string>,
): string[] {
	if ((video.container ?? "FMP4") !== "TS") {
		return [];
	}
	return (video.muxedAudioKeys ?? []).filter((key) => audioKeys.has(key));
}

function muxing(
	key: string,
	container: "FMP4" | "CMAF" | "TS",
	segmentLength: number,
	path: string,
	acl?: "PUBLIC_READ" | "PRIVATE",
	/**
	 * Akamai MSL refuses `live/start` unless every segment name matches
	 * `[prefix]-{rand_chars[:number]}-%number%.[extension]` (code 2025,
	 * measured against the real API 2026-08-21). Our schema defaults are
	 * S3-shaped — `seg_%number%.ts` — so a channel built entirely from
	 * defaults died at the last of thirty ops, after every resource existed.
	 *
	 * Set here rather than left to the validator, for the same reason C1 and
	 * C31 auto-switch: the operator did not choose this and cannot be expected
	 * to know Akamai's segment grammar. The validator keeps the rule too, for
	 * plans that arrive by import.
	 */
	mslNaming?: boolean,
	mslVersion?: "MSL4" | "MSL5",
	/** Audio renditions muxed into THIS container (TS only). */
	muxedIn?: readonly string[],
	cmaf?: LiveCmafOptions,
): LiveMuxingInput {
	// Segments need the ACL as much as the manifest does: a player that can read
	// stream.m3u8 and not its .m4s files fails after the manifest loads.
	const destination = { outputKey: "origin", path, ...(acl ? { acl } : {}) };
	/*
	 * The LITERAL field, token verbatim — because it is the only configuration
	 * Bitmovin's MSL live/start accepts. Full matrix, all measured against the
	 * real account on 2026-08-21 (measurement doc Parts 6-8):
	 *
	 *   segmentNaming "seg_%number%.ts"                 -> refused, code 2025
	 *   segmentNaming "seg-{rand_chars:8}-%number%.ts"  -> ACCEPTED; braces
	 *                                                      published literally,
	 *                                                      played in a browser
	 *   segmentNamingTemplate (token, per SDK docs)     -> refused, code 2025
	 *   segmentNaming "seg-k7Qw2xP9-%number%.ts"        -> refused, code 2025
	 *                  (pre-expanded, no token)
	 *
	 * So the start check requires the token VERBATIM, and Bitmovin's MSL
	 * publisher then ships it unexpanded — the SDK's segmentNamingTemplate
	 * promise ("expanded on each (re)start") does not hold on this path. That
	 * is Bitmovin's inconsistency to fix, not ours to paper over: an earlier
	 * revision here emitted the template because the docs say to, and it turned
	 * a cosmetically ugly but WORKING config into one that cannot start.
	 */
	const naming = (extension: string) =>
		mslNaming
			? {
					// Derived from core's single source rather than restated here.
					// This literal WAS restated, MSL4-only, and it is why an MSL5
					// channel built through the form carried the wrong grammar.
					segmentNaming: akamaiMslSegmentNaming(
						extension === "ts" ? "TS" : "FMP4",
						mslVersion,
					),
					/*
					 * The INIT name, and it is the SAME BUG one field over —
					 * review F10, . Arm 3 warns when an MSL5 init name
					 * lacks `$RepresentationID$`, and until this line the form
					 * could not produce one: `initSegmentName` appears nowhere in
					 * the live wizard or the live schema, so every wizard-built
					 * MSL5 channel took the plan schema's `init.mp4` default and
					 * earned a permanent warning with no UI path to silence it.
					 * Four of them on `live-akamai-msl5`, our own MSL5 acceptance
					 * fixture.
					 *
					 * A warning nobody can act on is worse than either an error or
					 * silence, so the fix is the EMITTER, not the severity.
					 *
					 * MSL5 ONLY. MSL4 keeps the schema default, which is what
					 * every landed MSL4 golden carries and what has started for
					 * real — emitting the vendor's MSL4 form here would move those
					 * goldens for no measured reason.
					 *
					 * fMP4 only: a TS muxing has no init segment.
					 */
					...(extension !== "ts" && mslVersion === "MSL5"
						? { initSegmentName: akamaiMsl5InitSegmentName() }
						: {}),
				}
			: {};
	if (container === "TS") {
		return {
			key,
			kind: "TS",
			streamKey: key,
			...(muxedIn && muxedIn.length > 0
				? { additionalStreamKeys: [...muxedIn] }
				: {}),
			segmentLength,
			...naming("ts"),
			destination,
		};
	}
	return {
		key,
		kind: container,
		streamKey: key,
		segmentLength,
		...naming("m4s"),
		...(container === "CMAF" ? cmaf : {}),
		destination,
	};
}

/**
 * HLS programDateTimeSettings — pruned so a group whose source and placement
 * are both unset emits no manifest key. `placement.mode` is required by the
 * schema, so a placement present in state always emits (interval only when set;
 * the schema refine requires it for the two *_INTERVAL modes).
 */
function pdtSettings(
	pdt: LivePdtSettingsState | undefined,
): LivePdtSettingsState | undefined {
	if (!pdt) {
		return undefined;
	}
	return group({
		source: pdt.source,
		placement: pdt.placement ? prune(pdt.placement) : undefined,
	});
}

/**
 * ESAM group. `poisEndpoint` is schema-required within the group, so the
 * pruned object is emitted as-is (cast at the boundary): an endpoint-less
 * group surfaces as a validation error in the preview instead of being
 * silently dropped.
 */
function esamGroup(
	esam: LiveEsamState | undefined,
): LiveChannelPlanInput["start"]["esam"] {
	const pruned = group({
		poisEndpoint: str(esam?.poisEndpoint),
		acquisitionPointIdentity: str(esam?.acquisitionPointIdentity),
		zoneIdentity: str(esam?.zoneIdentity),
		adAvailOffset: esam?.adAvailOffset,
		poisCredentialId: str(esam?.poisCredentialId),
	});
	return pruned as LiveChannelPlanInput["start"]["esam"];
}

/** "" ⇒ no leaf (the schema requires a non-empty Cache-Control header). */
function cacheControlLeaf(
	leaf: LiveCacheControlValue | undefined,
): LiveCacheControlValue | undefined {
	const header = str(leaf?.cacheControl);
	return header === undefined ? undefined : { cacheControl: header };
}

/** Cache-Control tree pruned leaf → family → whole group. */
function cacheControlSettings(
	cc: LiveCacheControlState | undefined,
): LiveCacheControlState | undefined {
	if (!cc) {
		return undefined;
	}
	return group({
		hls: group({
			multiVariantPlaylist: cacheControlLeaf(cc.hls?.multiVariantPlaylist),
			variantPlaylist: cacheControlLeaf(cc.hls?.variantPlaylist),
		}),
		dash: group({
			timelineManifest: cacheControlLeaf(cc.dash?.timelineManifest),
			templateManifest: cacheControlLeaf(cc.dash?.templateManifest),
		}),
		segments: group({
			initSegment: cacheControlLeaf(cc.segments?.initSegment),
			mediaSegment: cacheControlLeaf(cc.segments?.mediaSegment),
		}),
	});
}

function outputAcl(output: LiveWizardState["output"]) {
	return output.publicRead
		? ("PUBLIC_READ" as const)
		: output.explicitPrivateAcl
			? ("PRIVATE" as const)
			: undefined;
}

export function liveManifestDestination(state: LiveWizardState) {
	const base = liveBasePath(state);
	const acl = outputAcl(state.output);
	// Re-audit 2026-08-29 BLOCKER-5 : an Akamai MSL4 manifest is
	// published at the EVENT ROOT (the documented contract: empty, or a path
	// with leading and trailing slashes — the empty form is the one the paid
	// acceptance runs proved). The SEGMENTS keep the channel folder as their
	// run-specific prefix (muxing destinations still join `base`), which is
	// what keeps two airings of one event apart at the edge.
	return {
		outputKey: "origin",
		path: state.output.kind === "AKAMAI_MSL" ? "" : base,
		...(acl ? { acl } : {}),
	};
}

function buildManifests(state: LiveWizardState): LiveManifestInput[] {
	const destination = liveManifestDestination(state);
	// The receiving Origin generates its own manifests. Keep their drafts in
	// state, while still allowing manifests addressed to a storage mirror.
	const sentToOrigin = (manifest: LiveManifestIdentity) =>
		state.output.kind === "LIVE_MEDIA_INGEST" &&
		(manifest.destination ?? destination).outputKey === "origin";
	const manifests: LiveManifestInput[] = [];
	for (const hls of [
		state.manifests.hls,
		...(state.manifests.additionalHls ?? []),
	]) {
		if (hls.enabled && !sentToOrigin(hls)) {
			manifests.push(
				prune({
					key: hls.key ?? "hls",
					kind: "HLS" as const,
					name: hls.name,
					manifestName: str(hls.manifestName),
					destination: hls.destination ?? destination,
					audioGroupId: str(hls.audioGroupId),
					audioLanguage: str(hls.audioLanguage),
					closedCaptions: str(hls.closedCaptions),
					videoMuxingKind:
						hls.videoMuxingKind === "" ? undefined : hls.videoMuxingKind,
					audioMuxingKind:
						hls.audioMuxingKind === "" ? undefined : hls.audioMuxingKind,
					timeshift: hls.timeshift,
					liveEdgeOffset: hls.liveEdgeOffset,
					insertProgramDateTime:
						hls.insertProgramDateTime || hls.insertProgramDateTimeExplicit
							? hls.insertProgramDateTime
							: undefined,
					programDateTimeSettings: pdtSettings(hls.programDateTimeSettings),
				}),
			);
		}
	}
	for (const dash of [
		state.manifests.dash,
		...(state.manifests.additionalDash ?? []),
	]) {
		if (dash.enabled && !sentToOrigin(dash)) {
			manifests.push(
				prune({
					key: dash.key ?? "dash",
					kind: "DASH" as const,
					name: dash.name,
					manifestName: str(dash.manifestName),
					destination: dash.destination ?? destination,
					audioLanguage: str(dash.audioLanguage),
					representationType: dash.representationType,
					timeshift: dash.timeshift,
					liveEdgeOffset: dash.liveEdgeOffset,
					suggestedPresentationDelay: dash.suggestedPresentationDelay,
					minimumUpdatePeriod: dash.minimumUpdatePeriod,
					availabilityStartTimeMode:
						dash.availabilityStartTimeMode === ""
							? undefined
							: dash.availabilityStartTimeMode,
				}),
			);
		}
	}
	// Keep the legacy HLS/DASH order, followed by explicitly added resources.
	return inResourceOrder(
		manifests,
		state.manifestOrder ?? [
			state.manifests.hls.key ?? "hls",
			state.manifests.dash.key ?? "dash",
		],
	);
}

export function buildLiveChannelPlan(
	state: LiveWizardState,
): LiveChannelPlanInput {
	const base = liveBasePath(state);
	const vKeys = videoKeys(state.videos);
	const aKeys = audioKeys(state.audios);
	const ingest = buildIngest(state, vKeys, aKeys);

	const renditions: LiveRenditionInput[] = [
		...state.videos.map((video, index) =>
			videoRendition(
				video,
				vKeys[index] ?? `video${index + 1}`,
				ingest.video[index] ?? "video",
			),
		),
		...state.audios.map((audio, index) =>
			audioRendition(
				audio,
				aKeys[index] ?? `audio${index + 1}`,
				ingest.audio[index] ?? "audio",
			),
		),
	];

	const segmentAcl = outputAcl(state.output);
	// MSL's naming grammar is required whenever MSL is ANY destination — the
	// mirror included (2026-08-23): a deliveryMirror writes the same segment
	// names to the MSL side, so a storage-primary + MSL-mirror channel must
	// name segments the way MSL demands.
	const mirrors = liveMirrorEntries(state);
	const mslMirror = mirrors.find(
		(mirror) => mirror.output.kind === "AKAMAI_MSL",
	)?.output;
	const mslNaming = state.output.kind === "AKAMAI_MSL" || !!mslMirror;
	// WHICH grammar, not just whether — the two versions speak different
	// languages and the wizard emitted MSL4's for both until the MSL5 fixture's
	// round-trip caught it. A channel authored as MSL5 through the form would
	// have carried `seg-{rand_chars:8}-%number%`, which is not what Bitmovin's
	// own MSL5 end-to-end tests use.
	const mslVersion =
		state.output.kind === "AKAMAI_MSL"
			? state.output.mslVersion
			: mslMirror
				? mslMirror.mslVersion
				: undefined;
	// The relation, resolved once: which rung carries which tracks, and which
	// tracks are carried at all.
	const audioKeySet = new Set(
		state.audios.map((_, index) => aKeys[index] ?? `audio${index + 1}`),
	);
	const carriedPerRung = state.videos.map((video) =>
		carriedByRung(video, audioKeySet),
	);
	const carriedAnywhere = new Set(carriedPerRung.flat());
	const muxings: LiveMuxingInput[] = [
		...state.videos.map((video, index) => {
			const key = vKeys[index] ?? `video${index + 1}`;
			const container = video.container ?? "FMP4";
			return applyLiveMuxingOptions(
				muxing(
					key,
					container,
					state.segmentLength,
					joinPath(
						base,
						videoMuxingRelPath({ ...video, extras: undefined }, key),
					),
					segmentAcl,
					mslNaming,
					mslVersion,
					carriedPerRung[index],
					video.cmaf,
				),
				video.muxing,
			);
		}),
		// A track riding inside the video containers emits none of its own —
		// its stream key is already listed on each video muxing above.
		...state.audios
			.filter((audio, index) => {
				const key = aKeys[index] ?? `audio${index + 1}`;
				// Turning the own container off is honoured only when something
				// carries the track — otherwise the choice would delete it.
				return audio.ownContainer !== false || !carriedAnywhere.has(key);
			})
			.map((audio) => {
				const index = state.audios.indexOf(audio);
				const key = aKeys[index] ?? `audio${index + 1}`;
				return applyLiveMuxingOptions(
					muxing(
						key,
						audio.container ?? "FMP4",
						state.segmentLength,
						joinPath(
							base,
							audioMuxingRelPath({ ...audio, extras: undefined }, key),
						),
						segmentAcl,
						mslNaming,
						mslVersion,
						undefined,
						audio.cmaf,
					),
					audio.muxing,
				);
			}),
	];

	if (state.archive) muxings.push(state.archive.muxing);
	const outputs = [buildOutput(state)];
	for (const mirror of mirrors)
		outputs.push(buildOutputFrom(mirror.output, mirror.key));
	if (state.archive?.output) {
		outputs.push(
			buildOutputFrom(
				state.archive.output,
				state.archive.muxing.destination.outputKey,
			),
		);
	}
	const s = state.start;
	const reupload = group({
		dashManifestInterval: s.reupload.dashManifestInterval,
		muxingInitFileInterval: s.reupload.muxingInitFileInterval,
	});

	return prune({
		planVersion: 1 as const,
		name: state.name,
		bitmovin: prune({
			accountId: str(state.accountId),
			cloudRegion: str(state.cloudRegion),
			encoderVersion: str(state.encoderVersion),
			// P5 encoding-level extras — all pruned when unset so the 5 live
			// goldens stay byte-identical (labels only when non-empty).
			staticIpId: str(state.staticIpId),
			labels:
				state.labels && state.labels.length > 0 ? state.labels : undefined,
			infrastructure: state.infrastructure,
		}),
		liveInput: buildLiveInput(state),
		outputs: inResourceOrder(outputs, state.outputOrder),
		...(mirrors.length
			? {
					deliveryMirrors: mirrors.map((mirror) => ({ outputKey: mirror.key })),
				}
			: {}),
		// Live codec streams reference the input DIRECTLY on their StreamInput
		// (inputId + inputPath + position) — NOT a standalone IngestInputStream.
		// live/start cannot resolve an IngestInputStream built on the account
		// RTMP input (it 2025s on the ingest-stream id); the working Akamai
		// sample and bitmovin-live templates inline the selection per stream:
		// video position 0, audio position 1 (C13). These entries are the
		// per-ingestKey selection spec the compiler inlines onto each stream.
		ingest: ingest.ingest,
		renditions,
		muxings,
		liveManifests: buildManifests(state),
		// Pruned when off ⇒ default plans (and the 5 goldens) stay byte-identical.
		// The carrier knobs ride INSIDE adMarkers, so they can only reach the plan
		// while the gate is on; each absent knob keeps the exact C14 payload.
		adMarkers: state.scte35AdMarkers
			? prune({
					scte35: true as const,
					// .min(1) in the schema — an emptied checkbox list is "default".
					hlsMarkerTypes: state.adMarkerOptions?.hlsMarkerTypes?.length
						? state.adMarkerOptions.hlsMarkerTypes
						: undefined,
					hlsDisablePreannouncing:
						state.adMarkerOptions?.hlsDisablePreannouncing,
					dashPeriodOption: state.adMarkerOptions?.dashPeriodOption,
					dashEventStreamSignalling:
						state.adMarkerOptions?.dashEventStreamSignalling,
				})
			: undefined,
		start: prune({
			encodingOption: s.encodingOption,
			streamKey:
				s.streamKey === "" && streamKeyManagedByIngestPoint(state)
					? staticIngestStartKey(
							state.redundantRtmp.staticIngestPoints[0]?.name ?? "",
						)
					: s.streamKey,
			liveEncodingMode:
				s.liveEncodingMode === "" ? undefined : s.liveEncodingMode,
			autoRestart: group({
				segmentsWrittenTimeout: s.autoRestart.segmentsWrittenTimeout,
				bytesWrittenTimeout: s.autoRestart.bytesWrittenTimeout,
				framesWrittenTimeout: s.autoRestart.framesWrittenTimeout,
				hlsManifestsUpdateTimeout: s.autoRestart.hlsManifestsUpdateTimeout,
				dashManifestsUpdateTimeout: s.autoRestart.dashManifestsUpdateTimeout,
				scheduleExpression: str(s.autoRestart.scheduleExpression),
				restartOnEncoderError: s.autoRestart.restartOnEncoderError,
			}),
			autoShutdown: group({
				bytesReadTimeoutSeconds: s.autoShutdown.bytesReadTimeoutSeconds,
				streamTimeoutMinutes: s.autoShutdown.streamTimeoutMinutes,
				waitingForFirstConnectTimeoutMinutes:
					s.autoShutdown.waitingForFirstConnectTimeoutMinutes,
			}),
			reupload,
			// P5 PR-3 — the POIS basic-auth pair never enters the plan: only the
			// vault credential id rides here (resolved at start by the executor).
			// poisEndpoint is REQUIRED inside the group (C19 note): without it
			// there is nowhere to send signals, so a group that carries only the
			// other fields is emitted VERBATIM and the schema rejects it loudly
			// rather than silently dropping what the operator typed (the
			// half-filled-infrastructure precedent).
			esam: esamGroup(s.esam),
			cacheControl: cacheControlSettings(s.cacheControl),
			adInsertion: group({
				enableEsamMediaPointInsertion:
					s.adInsertion?.enableEsamMediaPointInsertion,
				clockSynchronizationMode: s.adInsertion?.clockSynchronizationMode,
			}),
		}),
	});
}
