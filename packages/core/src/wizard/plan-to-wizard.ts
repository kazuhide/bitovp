import { audioMixStreamSchema } from "../plan/audio-mix";
import { mediaFilterSchema } from "../plan/media-filters";
import { qcGateSchema } from "../plan/qc-gate";
import {
	DEFAULT_VMAF_MODEL,
	type EncodingPlan,
	encodingPlanSchema,
} from "../plan/schema";
import { vmafExecutionSchema } from "../vmaf/cloud";
import {
	audioKeys,
	audioMuxingRelPath,
	buildPlan,
	DEFAULT_WIZARD_STATE,
	hlsDefaultVersion,
	subtitleKeys,
	videoKeys,
	videoMuxingRelPath,
	type WizardAudioCodec,
	type WizardAudioRendition,
	type WizardConcatenationSource,
	type WizardConcatenationStream,
	type WizardDashOptions,
	type WizardDeinterlaceFilter,
	type WizardDolbyStream,
	type WizardDrmRow,
	type WizardEncodingRow,
	type WizardExtraManifest,
	type WizardFileStream,
	type WizardHlsOptions,
	type WizardIngestTrack,
	type WizardInputFile,
	type WizardKantar,
	type WizardKeyframe,
	type WizardManifests,
	type WizardMuxing,
	type WizardNexGuard,
	type WizardPerTitleCodec,
	type WizardQc,
	type WizardRenditionExtras,
	type WizardSources,
	type WizardSprite,
	type WizardStartOptions,
	type WizardState,
	type WizardSubtitle,
	type WizardThumbnail,
	type WizardTrimmingStream,
	type WizardVideoCodec,
	type WizardVideoRendition,
} from "./build-plan";
import { isPlaceholderCredentialId } from "./placeholder";

/**
 * Inverse of buildPlan — maps a saved EncodingPlan (a sample preset, an
 * exported plan, a pasted golden) back onto the wizard form so the user
 * lands in the familiar step-by-step editor instead of an opaque
 * imported-plan blob (P2 UX: "load preset → wizard", not "load preset →
 * Start (imported plan)").
 *
 * Correctness is GUARANTEED by a round-trip gate, not by this mapping being
 * exhaustive: a plan only loads into the form when
 *   parse(buildPlan(planToWizardState(plan))) deep-equals parse(plan)
 * i.e. the form can rebuild it byte-for-byte. Anything the form cannot yet
 * represent (DRM, Dolby ladders, per-title, AI Scene Analysis, multi-
 * encoding, Azure/HTTPS storage, thumbnails, keyframes …) fails the gate
 * and the caller falls back to the verbatim imported-plan path. So a partial
 * or buggy readback can only ever UNDER-cover (fall back) — it can never
 * silently load a form that would submit a different plan.
 */

/* ------------------------------------------------------------------ *
 * Raw-JSON accessors — the inverse reads the pre-parse fixture shape so
 * absent fields stay absent (clean, sample-minimal form state) instead of
 * carrying every materialized schema default.
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
function asBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/** Order-insensitive for object keys, order-sensitive for arrays. */
export function plansDeepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		return a.every((item, index) => plansDeepEqual(item, b[index]));
	}
	if (isRecord(a) && isRecord(b)) {
		// Treat undefined-valued keys as absent — buildPlan leaves a few
		// (e.g. bitmovin.accountId: undefined) that zod keeps but JSON drops;
		// matches vitest toEqual / how plans persist as JSON.
		const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
		const bKeys = Object.keys(b).filter((key) => b[key] !== undefined);
		if (aKeys.length !== bKeys.length) {
			return false;
		}
		return aKeys.every(
			(key) => Object.hasOwn(b, key) && plansDeepEqual(a[key], b[key]),
		);
	}
	return false;
}

/* ------------------------------------------------------------------ *
 * Form-gap detection — features the wizard form deliberately does not
 * expose yet. Surfaced as a human reason for the fallback note AND a
 * short-circuit so we never attempt a doomed mapping.
 * ------------------------------------------------------------------ */

/**
 * A message KEY for why this plan can't open in the wizard form, or null
 * when the form *might* represent it (the round-trip gate has the final
 * say). Checks the PARSED plan so default-materialized arrays are present.
 */
export function describeFormGap(
	_plan: EncodingPlan,
): PresetFallbackReasonKey | null {
	// Every EncodingPlan feature is now form-representable (storage incl.
	// Azure/HTTPS, DRM, Dolby, Per-Title, AI Scene, keyframes, NexGuard,
	// thumbnails). The round-trip gate alone decides mappability — a plan the
	// form can't yet rebuild exactly (e.g. dual muxing legs) falls back there.
	return null;
}

/* ------------------------------------------------------------------ *
 * Rendition readback — codec option bags mirror buildPlan's emission
 * field-for-field, so re-running buildPlan reproduces the rendition.
 * ------------------------------------------------------------------ */

/** Copies the listed keys from a raw rendition when present (immutable). */
function pickDefined(
	source: Record<string, unknown>,
	keys: string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (source[key] !== undefined) {
			out[key] = source[key];
		}
	}
	return out;
}

function bagOrUndefined<T extends Record<string, unknown>>(
	bag: T,
): T | undefined {
	return Object.keys(bag).length > 0 ? bag : undefined;
}

// Codec option field names = buildPlan's per-codec emission, minus the
// structural (key/ingestKey/codec/height/bitrate) and extras/mode/name
// fields handled separately. level/presetConfiguration are special-cased.
const H264_OPTION_KEYS = [
	"profile",
	"rate",
	"minKeyframeInterval",
	"maxKeyframeInterval",
	"slices",
	"trellis",
	"mvSearchRangeMax",
	"rcLookahead",
	"subMe",
	"motionEstimationMethod",
	"sceneCutThreshold",
	"adaptiveQuantizationMode",
	"adaptiveQuantizationStrength",
	"mvPredictionMode",
	"psyRateDistortionOptimization",
	"psyTrellis",
	"refFrames",
	"bframes",
	"cabac",
	"adaptiveSpatialTransform",
	"weightedPredictionPFrames",
	"colorConfig",
];
const H265_OPTION_KEYS = [
	"motionCompensatedTemporalFiltering",
	"rateControlModeConfig",
	"profile",
	"presetConfiguration",
	"rate",
	"maxBitrate",
	"bufsize",
	"levelHighTier",
	"dynamicRangeFormat",
	"minKeyframeInterval",
	"maxKeyframeInterval",
	"rcLookahead",
	"subMe",
	"maxCtuSize",
	"motionSearch",
	"tuIntraDepth",
	"tuInterDepth",
	"weightPredictionOnPSlice",
	"weightPredictionOnBSlice",
	"sceneCutThreshold",
	"motionSearchRange",
	"adaptiveQuantizationMode",
	"adaptiveQuantizationStrength",
	"psyRateDistortionOptimization",
	"psyRateDistortionOptimizedQuantization",
	"qpMin",
	"sao",
	"hdr",
	"masterDisplay",
	"maxContentLightLevel",
	"maxPictureAverageLightLevel",
	"pixelFormat",
	"colorConfig",
	"dolbyVisionMetadata",
];
const VP9_OPTION_KEYS = [
	"rate",
	"cpuUsed",
	"tileColumns",
	"qpMin",
	"qpMax",
	"rateUndershootPct",
	"rateOvershootPct",
	"quality",
	"lossless",
	"aqMode",
	"arnrType",
	"arnrMaxFrames",
	"arnrStrength",
	"colorConfig",
];
const AV1_OPTION_KEYS = [
	"rate",
	"presetConfiguration",
	"autoLevelSetup",
	"colorConfig",
];

/** Shared rendition extras (streamName/hlsMedia/filters/source/…). */
function readExtras(
	r: Record<string, unknown>,
	implicitSource: "video" | "audio" | null,
): WizardRenditionExtras | undefined {
	const ingestKey = asString(r.ingestKey);
	const extras: WizardRenditionExtras = {};
	if (implicitSource && ingestKey && ingestKey !== implicitSource) {
		extras.source = ingestKey;
	}
	const name = asString(r.name);
	if (name !== undefined) {
		extras.name = name;
	}
	const mode = asString(r.mode);
	if (mode !== undefined && mode !== "STANDARD") {
		extras.mode = mode as WizardRenditionExtras["mode"];
	}
	const streamName = asString(r.streamName);
	if (streamName !== undefined) {
		extras.streamName = streamName;
	}
	const hlsVariantLabel = asString(r.hlsVariantLabel);
	if (hlsVariantLabel !== undefined) {
		extras.hlsVariantLabel = hlsVariantLabel;
	}
	const dashSetKey = asString(r.dashSetKey);
	if (dashSetKey !== undefined) {
		extras.dashSetKey = dashSetKey;
	}
	const encodingKey = asString(r.encodingKey);
	if (encodingKey !== undefined) {
		extras.encodingKey = encodingKey;
	}
	if (isRecord(r.hlsMedia)) {
		extras.hlsMedia = r.hlsMedia as WizardRenditionExtras["hlsMedia"];
	}
	if (Array.isArray(r.filters)) {
		extras.filters = r.filters as WizardRenditionExtras["filters"];
	}
	if (isRecord(r.perTitleSettings)) {
		extras.perTitleSettings =
			r.perTitleSettings as WizardRenditionExtras["perTitleSettings"];
	}
	if (isRecord(r.nexguard)) {
		const ng = r.nexguard;
		const nexguard: WizardNexGuard = {
			credentialId: asString(ng.credentialId) ?? "",
			watermarkType: (asString(ng.watermarkType) ??
				"OTT") as WizardNexGuard["watermarkType"],
			preset: asString(ng.preset) ?? "",
		};
		// strength defaults to DEFAULT in the schema — carry only deviations.
		const strength = nonDefault(asString(ng.strength), "DEFAULT");
		if (strength !== undefined) {
			nexguard.strength = strength as WizardNexGuard["strength"];
		}
		extras.nexguard = nexguard;
	}
	return bagOrUndefined(extras);
}

/** Shared codec-option readback for the VOD and Live form builders. */
export function readH26xCodecOptions(
	r: Record<string, unknown>,
): Pick<WizardVideoRendition, "h264" | "h265"> {
	if (r.codec === "H265") {
		const h265 = bagOrUndefined({
			...pickDefined(r, H265_OPTION_KEYS),
			...(typeof r.level === "string" ? { level: r.level } : {}),
		}) as WizardVideoRendition["h265"] | undefined;
		return h265 ? { h265 } : {};
	}
	if (r.codec === "H264") {
		const bag = pickDefined(r, H264_OPTION_KEYS);
		// buildPlan forces level=null / presetConfiguration=VOD_HIGH_QUALITY;
		// only carry deviations so default ladders stay option-free.
		const level = asString(r.level);
		if (level !== undefined) {
			bag.level = level;
		}
		// null = per-title leaves the preset to the algorithm (carry it);
		// "VOD_HIGH_QUALITY" is buildPlan's default for undefined (omit it).
		if (r.presetConfiguration === null) {
			bag.presetConfiguration = null;
		} else {
			const presetConfiguration = asString(r.presetConfiguration);
			if (
				presetConfiguration !== undefined &&
				presetConfiguration !== "VOD_HIGH_QUALITY"
			) {
				bag.presetConfiguration = presetConfiguration;
			}
		}
		const h264 = bagOrUndefined(bag) as
			| WizardVideoRendition["h264"]
			| undefined;
		return h264 ? { h264 } : {};
	}
	return {};
}

function readVideo(r: Record<string, unknown>): WizardVideoRendition {
	const codec = (asString(r.codec) ?? "H264") as WizardVideoCodec;
	const height = r.height === null ? null : (asNumber(r.height) ?? null);
	const bitrate = r.bitrate === null ? null : (asNumber(r.bitrate) ?? null);
	const extras = readExtras(r, "video");
	const video: WizardVideoRendition = { height, bitrate, codec };
	if (typeof r.width === "number") video.width = r.width;
	if (typeof r.encodingMode === "string")
		video.encodingMode = r.encodingMode as WizardVideoRendition["encodingMode"];
	if (extras) {
		video.extras = extras;
	}
	if (codec === "VP9") {
		video.vp9 = bagOrUndefined(pickDefined(r, VP9_OPTION_KEYS)) as
			| WizardVideoRendition["vp9"]
			| undefined;
	} else if (codec === "AV1") {
		video.av1 = bagOrUndefined(pickDefined(r, AV1_OPTION_KEYS)) as
			| WizardVideoRendition["av1"]
			| undefined;
	} else {
		Object.assign(video, readH26xCodecOptions({ ...r, codec }));
	}
	return video;
}

function readAudio(r: Record<string, unknown>): WizardAudioRendition {
	const codec = (asString(r.codec) ?? "AAC") as WizardAudioCodec;
	const audio: WizardAudioRendition = {
		bitrate: asNumber(r.bitrate) ?? 0,
		rate: asNumber(r.rate) ?? 0,
		codec,
	};
	const extras = readExtras(r, "audio");
	if (extras) {
		audio.extras = extras;
	}
	// CL_STEREO is the schema default for AAC/DD/DDPLUS — carry only overrides.
	const channelLayout = asString(r.channelLayout);
	if (channelLayout !== undefined && channelLayout !== "CL_STEREO") {
		audio.channelLayout = channelLayout;
	}
	if (codec === "DOLBY_ATMOS" && isRecord(r.loudnessControl)) {
		audio.loudness = r.loudnessControl as WizardAudioRendition["loudness"];
	}
	return audio;
}

/* ------------------------------------------------------------------ *
 * Muxing readback — a rendition's muxing is left undefined (buildPlan
 * re-emits the fMP4 default) unless it deviates in kind, destination path,
 * segmentation or naming.
 * ------------------------------------------------------------------ */

function muxingRelPath(
	mux: Record<string, unknown> | undefined,
	base: string,
	expectedRel: string,
): string | undefined {
	const dest = isRecord(mux?.destination) ? mux.destination : undefined;
	const path = asString(dest?.path);
	if (path === undefined) {
		return undefined;
	}
	const rel = path.startsWith(base) ? path.slice(base.length) : path;
	return rel === expectedRel ? undefined : rel;
}

function nonDefault<T>(value: T | undefined, fallback: T): T | undefined {
	return value === undefined || value === fallback ? undefined : value;
}

function readDestinationAcl(
	entry: Record<string, unknown>,
): "PUBLIC_READ" | "PRIVATE" | null {
	const acl = isRecord(entry.destination) ? entry.destination.acl : undefined;
	return acl === "PUBLIC_READ" || acl === "PRIVATE" ? acl : null;
}

function readMuxing(
	mux: Record<string, unknown> | undefined,
	base: string,
	expectedRel: string,
	defaultKind: "FMP4" | "CHUNKED_TEXT" | "TEXT",
	streamKey: string,
): WizardMuxing | undefined {
	if (!mux) {
		return undefined;
	}
	const kind = asString(mux.kind) ?? defaultKind;
	const path = muxingRelPath(mux, base, expectedRel);
	const name = asString(mux.name);
	const muxing: WizardMuxing = {};
	muxing.acl = readDestinationAcl(mux);
	if (kind !== defaultKind) {
		muxing.kind = kind as WizardMuxing["kind"];
	}
	// Muxing resource key defaults to the stream key — carry an override only
	// when the sample named the muxing apart (e.g. "atmos448-mux").
	const muxKey = asString(mux.key);
	if (muxKey !== undefined && muxKey !== streamKey) {
		muxing.key = muxKey;
	}
	if (path !== undefined) {
		muxing.path = path;
	}
	if (name !== undefined) {
		muxing.name = name;
	}
	// The audio this container carries . A straight copy — the
	// wizard now models the same relation the plan does, so a container that
	// carries one track comes back carrying exactly that one.
	const carried = Array.isArray(mux.additionalStreamKeys)
		? mux.additionalStreamKeys.flatMap((raw) => {
				const k = asString(raw);
				return k === undefined ? [] : [k];
			})
		: [];
	if (carried.length > 0) {
		muxing.muxedAudioKeys = carried;
	}
	if (kind === "MP4") {
		// MP4 always needs explicit fields — schema requires filename.
		muxing.filename = asString(mux.filename) ?? "";
		const fragmentDuration = asNumber(mux.fragmentDuration);
		if (fragmentDuration !== undefined) {
			muxing.fragmentDuration = fragmentDuration;
		}
		const manifestType = asString(mux.manifestType);
		if (manifestType !== undefined) {
			muxing.manifestType = manifestType as WizardMuxing["manifestType"];
		}
		const dolby = isRecord(mux.dolbyVisionConfiguration)
			? asString(mux.dolbyVisionConfiguration.trackSampleEntryName)
			: undefined;
		if (dolby !== undefined) {
			muxing.dolbyVisionTrackSampleEntryName =
				dolby as WizardMuxing["dolbyVisionTrackSampleEntryName"];
		}
	} else if (kind === "TEXT") {
		muxing.filename = asString(mux.filename);
	} else {
		const segDefault = defaultKind === "CHUNKED_TEXT" ? 10 : 6;
		const segmentLength = nonDefault(asNumber(mux.segmentLength), segDefault);
		if (segmentLength !== undefined) {
			muxing.segmentLength = segmentLength;
		}
		const segNamingDefault =
			kind === "TS"
				? "seg_%number%.ts"
				: kind === "WEBM"
					? "seg_%number%.chk"
					: kind === "CHUNKED_TEXT"
						? "en_webvtt_seg_%number%.vtt"
						: "segment_%number%.m4s";
		const segmentNaming = nonDefault(
			asString(mux.segmentNaming),
			segNamingDefault,
		);
		if (segmentNaming !== undefined) {
			muxing.segmentNaming = segmentNaming;
		}
		if (kind === "FMP4" || kind === "CMAF" || kind === "TS") {
			const template = asString(mux.segmentNamingTemplate);
			if (template !== undefined) muxing.segmentNamingTemplate = template;
		}
		if (kind === "CMAF") {
			const template = asString(mux.initSegmentNameTemplate);
			if (template !== undefined) muxing.initSegmentNameTemplate = template;
			const frames = asNumber(mux.framesPerCmafChunk);
			if (frames !== undefined) muxing.framesPerCmafChunk = frames;
		}
		if (kind === "FMP4" || kind === "CMAF" || kind === "WEBM") {
			const initDefault = kind === "WEBM" ? "init.hdr" : "init.mp4";
			const initSegmentName = nonDefault(
				asString(mux.initSegmentName),
				initDefault,
			);
			if (initSegmentName !== undefined) {
				muxing.initSegmentName = initSegmentName;
			}
		}
	}
	return bagOrUndefined(muxing);
}

/* ------------------------------------------------------------------ *
 * Manifest readback — the canonical "stream.m3u8 / stream.mpd" pair maps
 * to the primary HLS/DASH toggles (clean checkboxes); anything else (reordered,
 * renamed, multiple, SMOOTH) maps to the editable "extra manifests" list,
 * preserving order verbatim.
 * ------------------------------------------------------------------ */

function hlsBag(
	m: Record<string, unknown>,
	primary: boolean,
	/** What buildPlan would emit with no version set — the value to DROP. */
	defaultVersion: "HLS_V4" | "HLS_V6",
): WizardHlsOptions {
	const bag: WizardHlsOptions = {};
	bag.acl = readDestinationAcl(m);
	const masterVersion = asString(m.masterVersion);
	if (primary && masterVersion === undefined) bag.omitMasterVersion = true;
	// Primary HLS defaults masterVersion/mediaVersion to the DERIVED default
	// in buildPlan ; extra HLS
	// leaves them absent — so only the primary path may drop the default,
	// and it must drop exactly the value buildPlan would re-emit.
	if (
		masterVersion !== undefined &&
		!(primary && masterVersion === defaultVersion)
	) {
		bag.masterVersion = masterVersion as WizardHlsOptions["masterVersion"];
	}
	const mediaVersion = asString(m.mediaVersion);
	if (primary && mediaVersion === undefined) bag.omitMediaVersion = true;
	if (
		mediaVersion !== undefined &&
		!(primary && mediaVersion === defaultVersion)
	) {
		bag.mediaVersion = mediaVersion as WizardHlsOptions["mediaVersion"];
	}
	const audioGroupId = nonDefault(asString(m.audioGroupId), "audio");
	if (audioGroupId !== undefined) {
		bag.audioGroupId = audioGroupId;
	}
	const audioLanguage = nonDefault(asString(m.audioLanguage), "en");
	if (audioLanguage !== undefined) {
		bag.audioLanguage = audioLanguage;
	}
	const closedCaptions = nonDefault(asString(m.closedCaptions), "NONE");
	if (closedCaptions !== undefined) {
		bag.closedCaptions = closedCaptions;
	}
	const perTitleVariantUri = nonDefault(
		asString(m.perTitleVariantUri),
		"AVG_BITRATE",
	);
	if (perTitleVariantUri !== undefined) {
		bag.perTitleVariantUri =
			perTitleVariantUri as WizardHlsOptions["perTitleVariantUri"];
	}
	const videoMuxingKind = asString(m.videoMuxingKind);
	if (videoMuxingKind !== undefined) {
		bag.videoMuxingKind =
			videoMuxingKind as WizardHlsOptions["videoMuxingKind"];
	}
	const audioMuxingKind = asString(m.audioMuxingKind);
	if (audioMuxingKind !== undefined) {
		bag.audioMuxingKind =
			audioMuxingKind as WizardHlsOptions["audioMuxingKind"];
	}
	const audioMediaUri = asString(m.audioMediaUri);
	if (audioMediaUri !== undefined) {
		bag.audioMediaUri = audioMediaUri;
	}
	const drmKind = asString(m.drmKind);
	if (drmKind !== undefined) {
		bag.drmKind = drmKind as WizardHlsOptions["drmKind"];
	}
	const variantsPerAudioGroup = asBool(m.variantsPerAudioGroup);
	if (variantsPerAudioGroup !== undefined) {
		bag.variantsPerAudioGroup = variantsPerAudioGroup;
	}
	const iframePlaylists = asBool(m.iframePlaylists);
	if (iframePlaylists !== undefined) {
		bag.iframePlaylists = iframePlaylists;
	}
	const audioVariantStreams = asBool(m.audioVariantStreams);
	if (audioVariantStreams !== undefined) {
		bag.audioVariantStreams = audioVariantStreams;
	}
	// No default — read verbatim (explicit "VOD" is schema-distinct from
	// absent, and buildPlan re-emits exactly what the bag carries).
	const jitPlacement = asString(m.jitPlacement);
	// (c): "VOD" is compiler-identical to absent — normalise so the
	// select (no longer offering the twin) never renders an off-list value; a
	// plan carrying the verbatim token fails the round-trip gate into the
	// imported-plan path, keeping its bytes.
	if (jitPlacement !== undefined && jitPlacement !== "VOD") {
		bag.jitPlacement = jitPlacement as WizardHlsOptions["jitPlacement"];
	}
	return bag;
}

function dashBag(
	m: Record<string, unknown>,
	primary: boolean,
): WizardDashOptions {
	const bag: WizardDashOptions = {};
	bag.acl = readDestinationAcl(m);
	// Primary DASH defaults audioLanguage to "ja" in buildPlan; extra DASH
	// defaults to the schema "en".
	const audioLanguage = nonDefault(
		asString(m.audioLanguage),
		primary ? "ja" : "en",
	);
	if (audioLanguage !== undefined) {
		bag.audioLanguage = audioLanguage;
	}
	const representationType = nonDefault(
		asString(m.representationType),
		"TEMPLATE",
	);
	if (representationType !== undefined) {
		bag.representationType =
			representationType as WizardDashOptions["representationType"];
	}
	if (asString(m.profile) === "ON_DEMAND") {
		bag.onDemand = true;
	}
	const videoMuxingKind = asString(m.videoMuxingKind);
	if (videoMuxingKind !== undefined) {
		bag.videoMuxingKind =
			videoMuxingKind as WizardDashOptions["videoMuxingKind"];
	}
	const audioMuxingKind = asString(m.audioMuxingKind);
	if (audioMuxingKind !== undefined) {
		bag.audioMuxingKind =
			audioMuxingKind as WizardDashOptions["audioMuxingKind"];
	}
	const drmKind = asString(m.drmKind);
	if (drmKind !== undefined) {
		bag.drmKind = drmKind as WizardDashOptions["drmKind"];
	}
	if (Array.isArray(m.adaptationSets)) {
		bag.adaptationSets =
			m.adaptationSets as WizardDashOptions["adaptationSets"];
	}
	const jitPlacement = asString(m.jitPlacement);
	// (c): "VOD" is compiler-identical to absent — normalise so the
	// select (no longer offering the twin) never renders an off-list value; a
	// plan carrying the verbatim token fails the round-trip gate into the
	// imported-plan path, keeping its bytes.
	if (jitPlacement !== undefined && jitPlacement !== "VOD") {
		bag.jitPlacement = jitPlacement as WizardDashOptions["jitPlacement"];
	}
	return bag;
}

function isCanonical(
	m: Record<string, unknown>,
	kind: "HLS" | "DASH",
): boolean {
	const key = asString(m.key);
	const manifestName = asString(m.manifestName);
	const name = asString(m.name);
	if (kind === "HLS") {
		return (
			asString(m.kind) === "HLS" &&
			key === "hls" &&
			manifestName === "stream.m3u8" &&
			name === "HLS Manifest"
		);
	}
	return (
		asString(m.kind) === "DASH" &&
		key === "dash" &&
		manifestName === "stream.mpd" &&
		name === "DASH Manifest"
	);
}

function toExtraManifest(
	m: Record<string, unknown>,
): WizardExtraManifest | null {
	const kind = asString(m.kind);
	const key = asString(m.key) ?? "";
	if (kind === "HLS") {
		const entry: WizardExtraManifest = { kind: "HLS", key };
		const manifestName = nonDefault(asString(m.manifestName), "stream.m3u8");
		if (manifestName !== undefined) {
			entry.manifestName = manifestName;
		}
		const name = nonDefault(asString(m.name), "HLS Manifest");
		if (name !== undefined) {
			entry.name = name;
		}
		// Non-primary: `primary=false` means nothing is dropped, so the default
		// passed here is inert — spelled anyway so the signature has no gap.
		entry.hls = bagOrUndefined(hlsBag(m, false, "HLS_V4"));
		return entry;
	}
	if (kind === "DASH") {
		const entry: WizardExtraManifest = { kind: "DASH", key };
		const manifestName = nonDefault(asString(m.manifestName), "stream.mpd");
		if (manifestName !== undefined) {
			entry.manifestName = manifestName;
		}
		const name = nonDefault(asString(m.name), "DASH Manifest");
		if (name !== undefined) {
			entry.name = name;
		}
		entry.dash = bagOrUndefined(dashBag(m, false));
		return entry;
	}
	if (kind === "SMOOTH") {
		const entry: WizardExtraManifest = { kind: "SMOOTH", key };
		entry.acl = readDestinationAcl(m);
		const serverManifestName = nonDefault(
			asString(m.serverManifestName),
			"stream.ism",
		);
		if (serverManifestName !== undefined) {
			entry.serverManifestName = serverManifestName;
		}
		const clientManifestName = nonDefault(
			asString(m.clientManifestName),
			"stream.ismc",
		);
		if (clientManifestName !== undefined) {
			entry.clientManifestName = clientManifestName;
		}
		const name = nonDefault(asString(m.name), "Smooth Manifest");
		if (name !== undefined) {
			entry.name = name;
		}
		const language = nonDefault(asString(m.language), "en");
		if (language !== undefined) {
			entry.language = language;
		}
		const drmKind = asString(m.drmKind);
		if (drmKind !== undefined) {
			entry.drmKind = drmKind as Extract<
				WizardExtraManifest,
				{ kind: "SMOOTH" }
			>["drmKind"];
		}
		return entry;
	}
	return null;
}

function readManifests(
	rawManifests: unknown[],
	hlsDefault: "HLS_V4" | "HLS_V6",
): WizardManifests {
	const mans = rawManifests.filter(isRecord);
	const hls = mans.filter((m) => asString(m.kind) === "HLS");
	const dash = mans.filter((m) => asString(m.kind) === "DASH");
	const smooth = mans.filter((m) => asString(m.kind) === "SMOOTH");
	// Canonical = at most one HLS + one DASH, both the sample-named primaries,
	// in buildPlan's [hls, dash] emission order, no SMOOTH.
	const canonical =
		smooth.length === 0 &&
		hls.length <= 1 &&
		dash.length <= 1 &&
		hls.every((m) => isCanonical(m, "HLS")) &&
		dash.every((m) => isCanonical(m, "DASH")) &&
		(mans.length < 2 ||
			(asString(mans[0]?.kind) === "HLS" && hls.length === 1));
	if (canonical) {
		const manifests: WizardManifests = {
			hls: hls.length > 0,
			dash: dash.length > 0,
		};
		if (hls[0]) {
			manifests.hlsOptions = bagOrUndefined(hlsBag(hls[0], true, hlsDefault));
		}
		if (dash[0]) {
			manifests.dashOptions = bagOrUndefined(dashBag(dash[0], true));
		}
		return manifests;
	}
	const extra = mans
		.map(toExtraManifest)
		.filter((entry): entry is WizardExtraManifest => entry !== null);
	return { hls: false, dash: false, extra };
}

/* ------------------------------------------------------------------ *
 * DRM / Per-Title / AI Scene / source collections — invert buildPlan's
 * emission of the advanced families (every one is form-representable;
 * build-plan.test.ts reproduces the fixtures from these shapes).
 * ------------------------------------------------------------------ */

/** Destination path relative to base, or undefined when it equals `derived`. */
function relPathOverride(
	dest: unknown,
	base: string,
	derived: string | undefined,
): string | undefined {
	const path = asString(isRecord(dest) ? dest.path : undefined);
	if (path === undefined) {
		return undefined;
	}
	const rel = path.startsWith(base) ? path.slice(base.length) : path;
	return rel === derived ? undefined : rel;
}

function readDrm(
	raw: Record<string, unknown>,
	base: string,
	relPathByKey: Map<string, string>,
): WizardDrmRow[] {
	const rows: WizardDrmRow[] = [];
	for (const d of asArray(raw.drm)) {
		if (!isRecord(d)) {
			continue;
		}
		const muxingKey = asString(d.muxingKey);
		const credentialId = asString(d.credentialId);
		if (muxingKey === undefined || credentialId === undefined) {
			continue;
		}
		const path = relPathOverride(
			d.destination,
			base,
			relPathByKey.get(muxingKey),
		);
		const name = asString(d.name);
		const rawKey = asString(d.key);
		if (asString(d.kind) === "SPEKE") {
			rows.push({
				kind: "SPEKE",
				muxingKey,
				credentialId,
				systemIds: asArray(d.systemIds).filter(
					(id): id is string => typeof id === "string",
				),
				...(rawKey ? { key: rawKey } : {}),
				...(path !== undefined ? { path } : {}),
				...(name !== undefined ? { name } : {}),
				...(asString(d.contentId) ? { contentId: asString(d.contentId) } : {}),
				...(asString(d.kid) ? { kid: asString(d.kid) } : {}),
				...(asString(d.iv) ? { iv: asString(d.iv) } : {}),
			});
			continue;
		}
		if (asString(d.kind) === "FAIRPLAY") {
			const row: Extract<WizardDrmRow, { kind: "FAIRPLAY" }> = {
				kind: "FAIRPLAY",
				muxingKey,
				credentialId,
				iv: asString(d.iv) ?? "",
				uri: asString(d.uri) ?? "",
			};
			if (rawKey !== undefined && rawKey !== `${muxingKey}-fairplay`) {
				row.key = rawKey;
			}
			if (path !== undefined) {
				row.path = path;
			}
			if (name !== undefined) {
				row.name = name;
			}
			rows.push(row);
			continue;
		}
		const widevine = isRecord(d.widevine) ? d.widevine : undefined;
		const playReady = isRecord(d.playReady) ? d.playReady : undefined;
		const fairPlay = isRecord(d.fairPlay) ? d.fairPlay : undefined;
		const row: Extract<WizardDrmRow, { kind: "CENC" }> = {
			kind: "CENC",
			muxingKey,
			credentialId,
			kid: asString(d.kid) ?? "",
		};
		if (rawKey !== undefined && rawKey !== `${muxingKey}-cenc`) {
			row.key = rawKey;
		}
		const encryptionMode = asString(d.encryptionMode);
		if (encryptionMode === "CTR" || encryptionMode === "CBC") {
			row.encryptionMode = encryptionMode;
		}
		const widevinePssh = asString(widevine?.pssh);
		if (widevinePssh !== undefined) {
			row.widevinePssh = widevinePssh;
		}
		const laUrl = asString(playReady?.laUrl);
		if (laUrl !== undefined) {
			row.playReadyLaUrl = laUrl;
		}
		const prPssh = asString(playReady?.pssh);
		if (prPssh !== undefined) {
			row.playReadyPssh = prPssh;
		}
		const fpIv = asString(fairPlay?.iv);
		if (fpIv !== undefined) {
			row.fairPlayIv = fpIv;
		}
		const fpUri = asString(fairPlay?.uri);
		if (fpUri !== undefined) {
			row.fairPlayUri = fpUri;
		}
		if (path !== undefined) {
			row.path = path;
		}
		if (name !== undefined) {
			row.name = name;
		}
		rows.push(row);
	}
	return rows;
}

const PER_TITLE_NUMBER_KEYS = [
	"minBitrate",
	"maxBitrate",
	"targetQualityCrf",
	"targetQualityQp",
	"minBitrateStepSize",
	"maxBitrateStepSize",
	"complexityFactor",
	"codecMinBitrateFactor",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
] as const;

function readPerTitleCodec(cfg: Record<string, unknown>): WizardPerTitleCodec {
	const out: Record<string, unknown> = {};
	for (const key of PER_TITLE_NUMBER_KEYS) {
		const value = asNumber(cfg[key]);
		if (value !== undefined) {
			out[key] = value;
		}
	}
	if (isRecord(cfg.autoRepresentations)) {
		out.autoRepresentations = true;
		const adopt = asNumber(cfg.autoRepresentations.adoptConfigurationThreshold);
		if (adopt !== undefined) {
			out.adoptConfigurationThreshold = adopt;
		}
	}
	if (isRecord(cfg.fixedResolutionAndBitrateConfiguration)) {
		const fixed = cfg.fixedResolutionAndBitrateConfiguration;
		const forced = asNumber(
			fixed.forcedRenditionAboveHighestFixedRepresentation,
		);
		if (forced !== undefined) {
			out.forcedRenditionAboveHighestFixedRepresentation = forced;
		}
		const forcedFactor = asNumber(
			fixed.forcedRenditionAboveHighestFixedRepresentationFactor,
		);
		if (forcedFactor !== undefined) {
			out.forcedRenditionAboveHighestFixedRepresentationFactor = forcedFactor;
		}
		const mode = asString(
			fixed.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
		);
		if (
			mode === "LAST_CALCULATED_BITRATE" ||
			mode === "MINIMUM" ||
			mode === "MAXIMUM" ||
			mode === "AVERAGE"
		) {
			out.forcedRenditionAboveHighestFixedRepresentationCalculationMode = mode;
		}
	}
	return out as WizardPerTitleCodec;
}

function readPerTitle(
	raw: Record<string, unknown>,
): NonNullable<WizardStartOptions["perTitle"]> | undefined {
	const pt = isRecord(raw.perTitle) ? raw.perTitle : undefined;
	if (!pt) {
		return undefined;
	}
	const out: NonNullable<WizardStartOptions["perTitle"]> = {};
	if (isRecord(pt.h264Configuration)) {
		out.h264 = readPerTitleCodec(pt.h264Configuration);
	}
	if (isRecord(pt.h265Configuration)) {
		out.h265 = readPerTitleCodec(pt.h265Configuration);
	}
	if (isRecord(pt.h265V2Configuration)) {
		out.h265 = readPerTitleCodec(pt.h265V2Configuration);
	}
	if (isRecord(pt.vp9Configuration)) {
		out.vp9 = readPerTitleCodec(pt.vp9Configuration);
	}
	if (isRecord(pt.av1Configuration)) {
		out.av1 = readPerTitleCodec(pt.av1Configuration);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function readAiScene(
	raw: Record<string, unknown>,
	base: string,
): NonNullable<WizardStartOptions["aiSceneAnalysis"]> | undefined {
	const ai = isRecord(raw.aiSceneAnalysis) ? raw.aiSceneAnalysis : undefined;
	if (!ai) {
		return undefined;
	}
	const asset = isRecord(ai.assetDescription) ? ai.assetDescription : {};
	const destPath = asString(
		isRecord(asset.destination) ? asset.destination.path : undefined,
	);
	const out: NonNullable<WizardStartOptions["aiSceneAnalysis"]> = {
		filename: asString(asset.filename) ?? "",
		path: destPath?.startsWith(base)
			? destPath.slice(base.length)
			: (destPath ?? ""),
	};
	const adPlacement = isRecord(ai.automaticAdPlacement)
		? ai.automaticAdPlacement
		: undefined;
	const asb = isRecord(adPlacement?.allSceneBoundaries)
		? adPlacement.allSceneBoundaries
		: undefined;
	if (asb) {
		out.allSceneBoundaries = {
			isEnabled: asBool(asb.isEnabled) ?? false,
			insertCueTags: asBool(asb.insertCueTags) ?? false,
		};
	}
	if (Array.isArray(adPlacement?.schedule)) {
		out.schedule = adPlacement.schedule.map((row) => {
			const entry = isRecord(row) ? row : {};
			return {
				position: asNumber(entry.position) ?? Number.NaN,
				maxDeviation: asNumber(entry.maxDeviation) ?? Number.NaN,
				...(entry.duration !== undefined
					? { duration: asNumber(entry.duration) ?? Number.NaN }
					: {}),
			};
		});
	}
	if (Array.isArray(ai.outputLanguageCodes)) {
		const codes = ai.outputLanguageCodes.filter(
			(c): c is string => typeof c === "string",
		);
		if (codes.length > 0) {
			out.outputLanguageCodes = codes;
		}
	}
	return out;
}

/**
 * Reads `plan.qc` back into the wizard QC toggle. Absent ⇒ undefined (the
 * section renders the default-off state). A present block always has `vmaf`
 * (buildPlan emits `vmaf:true` whenever it emits qc); `model` defaults to the
 * schema default when omitted, `psnr` to false — symmetric with buildPlan's
 * prune so a qc plan round-trips byte-for-byte. `only` (VMAF-only encode)
 * defaults to false — symmetric with buildPlan, which emits it only when set.
 */
function readQc(raw: Record<string, unknown>): WizardQc | undefined {
	const qc = isRecord(raw.qc) ? raw.qc : undefined;
	if (!qc) {
		return undefined;
	}
	// Gate : parsed through its OWN schema, not hand-read —
	// the editor round-trips the exact shape, and a malformed gate on a
	// hand-edited plan reads as absent here while the plan-level validator
	// still rails it where the user can see (tolerant-read convention).
	const gate = qcGateSchema.safeParse(qc.gate);
	const execution = vmafExecutionSchema.safeParse(qc.execution);
	return {
		vmaf: asBool(qc.vmaf) ?? false,
		model: asString(qc.model) ?? DEFAULT_VMAF_MODEL,
		psnr: asBool(qc.psnr) ?? false,
		only: asBool(qc.only) ?? false,
		...(gate.success ? { gate: gate.data } : {}),
		...(execution.success ? { execution: execution.data } : {}),
		...(qc.measurementMethod === "FRAME_INDEX_BT709_10BIT"
			? { measurementMethod: qc.measurementMethod }
			: {}),
	};
}

/**
 * Reads `plan.kantar` (the encoding-level watermark singleton) back into the
 * wizard section. Absent ⇒ undefined and the section stays off.
 *
 * The report path is stored RELATIVE to the base output path (the AISA
 * precedent) and an explicit `acl: "PRIVATE"` becomes `reportPrivate` so a
 * report written privately under a PUBLIC_READ delivery output — what the
 * golden does — rebuilds byte-for-byte. A report leg carrying no `acl` at all
 * reads back as "inherit", which re-emits the output's ACL; that is the one
 * hand-authored shape the boolean cannot distinguish from an explicit
 * PUBLIC_READ, and Bitmovin treats the two identically anyway.
 */
function readKantar(
	raw: Record<string, unknown>,
	base: string,
): WizardKantar | undefined {
	const kantar = isRecord(raw.kantar) ? raw.kantar : undefined;
	if (!kantar) {
		return undefined;
	}
	const dest = isRecord(kantar.reportDestination)
		? kantar.reportDestination
		: {};
	const destPath = asString(dest.path);
	const licenseId = asNumber(kantar.licenseId);
	return {
		credentialId: asString(kantar.credentialId) ?? "",
		...(licenseId !== undefined ? { licenseId } : {}),
		channelName: asString(kantar.channelName) ?? "",
		contentReference: asString(kantar.contentReference) ?? "",
		serverUrl: asString(kantar.serverUrl) ?? "",
		reportPath: destPath?.startsWith(base)
			? destPath.slice(base.length)
			: (destPath ?? ""),
		...(asString(dest.acl) === "PRIVATE" ? { reportPrivate: true } : {}),
	};
}

function readDolbyStreams(
	raw: Record<string, unknown>,
	fileKeyFor: FileKeyFor,
): WizardDolbyStream[] {
	const streams: WizardDolbyStream[] = [];
	for (const s of asArray(raw.dolbyStreams)) {
		if (!isRecord(s)) {
			continue;
		}
		const key = asString(s.key) ?? "";
		const inputKey = asString(s.inputKey);
		const encodingKey = asString(s.encodingKey);
		const encodingKeyField = encodingKey !== undefined ? { encodingKey } : {};
		const kind = asString(s.kind);
		if (kind === "VISION") {
			const metadataInputPath = asString(s.metadataInputPath);
			streams.push({
				kind: "VISION",
				key,
				videoInputFile: fileKeyFor(inputKey, asString(s.videoInputPath) ?? ""),
				...(metadataInputPath !== undefined
					? { metadataInputFile: fileKeyFor(inputKey, metadataInputPath) }
					: {}),
				...encodingKeyField,
			});
		} else if (kind === "VISION_METADATA") {
			streams.push({
				kind: "VISION_METADATA",
				key,
				inputFile: fileKeyFor(inputKey, asString(s.inputPath) ?? ""),
				...encodingKeyField,
			});
		} else {
			streams.push({
				kind: "ATMOS",
				key,
				inputFile: fileKeyFor(inputKey, asString(s.inputPath) ?? ""),
				inputFormat: (asString(s.inputFormat) ?? "DAMF") as Extract<
					WizardDolbyStream,
					{ kind: "ATMOS" }
				>["inputFormat"],
				...encodingKeyField,
			});
		}
	}
	return streams;
}

function readEncodings(raw: Record<string, unknown>): WizardEncodingRow[] {
	return asArray(raw.encodings)
		.filter(isRecord)
		.map((e) => {
			const row: WizardEncodingRow = {
				key: asString(e.key) ?? "",
				name: asString(e.name) ?? "",
			};
			const cloudRegion = asString(e.cloudRegion);
			if (cloudRegion !== undefined) {
				row.cloudRegion = cloudRegion;
			}
			return row;
		});
}

function readThumbnails(
	raw: Record<string, unknown>,
	base: string,
): WizardThumbnail[] {
	return asArray(raw.thumbnails)
		.filter(isRecord)
		.map((t) => {
			const thumb: WizardThumbnail = {
				key: asString(t.key) ?? "",
				streamKey: asString(t.streamKey) ?? "",
				height: asNumber(t.height) ?? 0,
				positions: Array.isArray(t.positions)
					? t.positions.filter((p): p is number => typeof p === "number")
					: [],
			};
			const pattern = nonDefault(asString(t.pattern), "thumbnail-%number%.jpg");
			if (pattern !== undefined) {
				thumb.pattern = pattern;
			}
			const unit = nonDefault(asString(t.unit), "SECONDS");
			if (unit !== undefined) {
				thumb.unit = unit as WizardThumbnail["unit"];
			}
			const rel = relPathOverride(t.destination, base, "");
			if (rel !== undefined) {
				thumb.path = rel;
			}
			return thumb;
		});
}

function readSprites(
	raw: Record<string, unknown>,
	base: string,
): WizardSprite[] {
	return asArray(raw.sprites)
		.filter(isRecord)
		.map((s) => {
			const sprite: WizardSprite = {
				key: asString(s.key) ?? "",
				streamKey: asString(s.streamKey) ?? "",
				distance: asNumber(s.distance) ?? 0,
				filename: asString(s.filename) ?? "",
			};
			const unit = nonDefault(asString(s.unit), "SECONDS");
			if (unit !== undefined) {
				sprite.unit = unit as WizardSprite["unit"];
			}
			const width = asNumber(s.width);
			if (width !== undefined) {
				sprite.width = width;
			}
			const height = asNumber(s.height);
			if (height !== undefined) {
				sprite.height = height;
			}
			const hTiles = asNumber(s.hTiles);
			if (hTiles !== undefined) {
				sprite.hTiles = hTiles;
			}
			const vTiles = asNumber(s.vTiles);
			if (vTiles !== undefined) {
				sprite.vTiles = vTiles;
			}
			const imagesPerFile = asNumber(s.imagesPerFile);
			if (imagesPerFile !== undefined) {
				sprite.imagesPerFile = imagesPerFile;
			}
			const spriteName = asString(s.spriteName);
			if (spriteName !== undefined) {
				sprite.spriteName = spriteName;
			}
			const vttName = asString(s.vttName);
			if (vttName !== undefined) {
				sprite.vttName = vttName;
			}
			const creationMode = asString(s.creationMode);
			if (creationMode !== undefined) {
				sprite.creationMode = creationMode as WizardSprite["creationMode"];
			}
			const rel = relPathOverride(s.destination, base, "");
			if (rel !== undefined) {
				sprite.path = rel;
			}
			return sprite;
		});
}

function readKeyframes(raw: Record<string, unknown>): WizardKeyframe[] {
	return asArray(raw.keyframes)
		.filter(isRecord)
		.map((k) => {
			const row: WizardKeyframe = {
				key: asString(k.key) ?? "",
				time: asNumber(k.time) ?? 0,
			};
			const encodingKey = asString(k.encodingKey);
			if (encodingKey !== undefined) {
				row.encodingKey = encodingKey;
			}
			return row;
		});
}

/** Trimming input streams (the modern path) — intermediate, no input file. */
function readTrimmingStreams(
	raw: Record<string, unknown>,
): WizardTrimmingStream[] {
	return asArray(raw.trimmingStreams)
		.filter(isRecord)
		.map((t) => {
			const key = asString(t.key) ?? "";
			const sourceKey = asString(t.sourceKey) ?? "";
			const encodingKey = asString(t.encodingKey);
			const kind = asString(t.kind);
			if (kind === "TIMECODE_TRACK") {
				const row: WizardTrimmingStream = {
					kind: "TIMECODE_TRACK",
					key,
					sourceKey,
				};
				const start = asString(t.startTimeCode);
				if (start !== undefined) {
					row.startTimeCode = start;
				}
				const end = asString(t.endTimeCode);
				if (end !== undefined) {
					row.endTimeCode = end;
				}
				if (encodingKey !== undefined) {
					row.encodingKey = encodingKey;
				}
				return row;
			}
			if (kind === "H264_PICTURE_TIMING") {
				const row: WizardTrimmingStream = {
					kind: "H264_PICTURE_TIMING",
					key,
					sourceKey,
				};
				const start = asString(t.startPicTiming);
				if (start !== undefined) {
					row.startPicTiming = start;
				}
				const end = asString(t.endPicTiming);
				if (end !== undefined) {
					row.endPicTiming = end;
				}
				if (encodingKey !== undefined) {
					row.encodingKey = encodingKey;
				}
				return row;
			}
			const row: WizardTrimmingStream = {
				kind: "TIME_BASED",
				key,
				sourceKey,
			};
			const offset = asNumber(t.offset);
			if (offset !== undefined) {
				row.offset = offset;
			}
			const duration = asNumber(t.duration);
			if (duration !== undefined) {
				row.duration = duration;
			}
			if (encodingKey !== undefined) {
				row.encodingKey = encodingKey;
			}
			return row;
		});
}

/** Concatenation input streams — ordered source list, no input file. */
function readConcatenationStreams(
	raw: Record<string, unknown>,
): WizardConcatenationStream[] {
	const readPadding = (
		value: unknown,
	): { duration: number; unit?: "SECONDS" | "FRAMES" } | undefined => {
		if (!isRecord(value)) {
			return undefined;
		}
		const pad: { duration: number; unit?: "SECONDS" | "FRAMES" } = {
			duration: asNumber(value.duration) ?? 0,
		};
		const unit = asString(value.unit);
		if (unit === "SECONDS" || unit === "FRAMES") {
			pad.unit = unit;
		}
		return pad;
	};
	return asArray(raw.concatenationStreams)
		.filter(isRecord)
		.map((c) => {
			const stream: WizardConcatenationStream = {
				key: asString(c.key) ?? "",
				sources: asArray(c.sources)
					.filter(isRecord)
					.map((s) => {
						const source: WizardConcatenationSource = {
							sourceKey: asString(s.sourceKey) ?? "",
						};
						if (typeof s.isMain === "boolean") {
							source.isMain = s.isMain;
						}
						const position = asNumber(s.position);
						if (position !== undefined) {
							source.position = position;
						}
						const before = readPadding(s.paddingBefore);
						if (before !== undefined) {
							source.paddingBefore = before;
						}
						const after = readPadding(s.paddingAfter);
						if (after !== undefined) {
							source.paddingAfter = after;
						}
						const aspectMode = asString(s.aspectMode);
						if (
							aspectMode === "PAD" ||
							aspectMode === "CROP" ||
							aspectMode === "STRETCH"
						) {
							source.aspectMode = aspectMode;
						}
						return source;
					}),
			};
			const encodingKey = asString(c.encodingKey);
			if (encodingKey !== undefined) {
				stream.encodingKey = encodingKey;
			}
			return stream;
		});
}

/** Ingest rows that aren't the implicit video/audio pair → source tracks. */
function readTracks(
	ingest: Record<string, unknown>[],
	fileKeyFor: FileKeyFor,
): WizardIngestTrack[] {
	return ingest
		.filter((row) => {
			const key = asString(row.key);
			return key !== "video" && key !== "audio";
		})
		.map((row) => {
			const track: WizardIngestTrack = {
				key: asString(row.key) ?? "",
				inputFile: fileKeyFor(
					asString(row.inputKey),
					asString(row.inputPath) ?? "",
				),
				selectionMode: (asString(row.selectionMode) ??
					"AUTO") as WizardIngestTrack["selectionMode"],
				position: asNumber(row.position) ?? 0,
			};
			const encodingKey = asString(row.encodingKey);
			if (encodingKey !== undefined) {
				track.encodingKey = encodingKey;
			}
			return track;
		});
}

/* ------------------------------------------------------------------ *
 * Top-level inverse
 * ------------------------------------------------------------------ */

/** The location an inputs/outputs row carries: S3 bucket / Azure container /
 * HTTPS host (the wizard stores all three in `bucket`). */
function readLocation(raw: Record<string, unknown>): string {
	const kind = asString(raw.kind);
	if (kind === "AZURE") {
		return asString(raw.container) ?? "";
	}
	if (kind === "HTTPS") {
		return asString(raw.host) ?? "";
	}
	if (kind === "AKAMAI_NETSTORAGE") {
		//  — no location field at all: the upload account is the
		// container. "" is the right answer, and the builders must not then
		// emit a `bucket`, which is why both sides branch on the kind.
		return "";
	}
	// S3 / GENERIC_S3 / GCS / GCS_SERVICE_ACCOUNT all carry `bucket`.
	return asString(raw.bucket) ?? "";
}

/** Plan input `kind` → wizard input kind (unknown ⇒ S3, the legacy default). */
function inputKindOf(kind: string | undefined): WizardInputFile["kind"] {
	switch (kind) {
		case "AZURE":
		case "HTTPS":
		case "GENERIC_S3":
		case "GCS":
		case "GCS_SERVICE_ACCOUNT":
		// . Falling through to the S3 default made the rebuild
		// demand a bucket the plan never had, and the round-trip gate reported
		// the fixture as un-authorable by the form. `default: "S3"` is a legacy
		// leniency that turns a NEW kind into a wrong one rather than a loud
		// one — worth knowing about the next kind too.
		case "AKAMAI_NETSTORAGE":
			return kind;
		default:
			return "S3";
	}
}

/** Plan output `kind` → wizard output kind (unknown ⇒ S3, the legacy default). */
function outputKindOf(kind: string | undefined): WizardState["output"]["kind"] {
	switch (kind) {
		case "SFTP":
		case "AZURE":
		case "GENERIC_S3":
		case "GCS":
		case "GCS_SERVICE_ACCOUNT":
		case "AKAMAI_NETSTORAGE":
			return kind;
		default:
			return "S3";
	}
}

/** Resolves the base output path from the manifests, else the first muxing. */
function readBasePath(
	manifests: Record<string, unknown>[],
	muxings: Record<string, unknown>[],
): { base: string; publicRead: boolean } {
	const destinations = [...manifests, ...muxings]
		.map((entry) => (isRecord(entry.destination) ? entry.destination : null))
		.filter((dest): dest is Record<string, unknown> => dest !== null);
	const publicRead = destinations.some(
		(dest) => asString(dest.acl) === "PUBLIC_READ",
	);
	// Every manifest writes to the base path verbatim (buildPlan), so any
	// manifest destination IS the base. Manifest-less plans aren't in the
	// form-mappable set; "" lets the round-trip gate reject them.
	const firstManifestDest = isRecord(manifests[0]?.destination)
		? manifests[0].destination
		: undefined;
	const base = asString(firstManifestDest?.path) ?? "";
	return { base, publicRead };
}

/** Resolve a stream's (Bitmovin inputKey, object path) to its input-file key. */
type FileKeyFor = (inputKey: string | undefined, path: string) => string;

/**
 * Split the plan's inputs[] + every stream's (inputKey, path) into one input
 * FILE per distinct object. Files sharing a Bitmovin input keep its key as
 * their `inputKey` (the dedupe anchor) so buildPlan re-emits the same inputs[].
 * The implicit video object lands first (inputFiles[0]) via the canonical
 * pair order below.
 */
function collectInputFiles(
	inputs: Record<string, unknown>[],
	ingest: Record<string, unknown>[],
	fileStreams: Record<string, unknown>[],
	dolbyStreams: Record<string, unknown>[],
): { inputFiles: WizardInputFile[]; fileKeyFor: FileKeyFor } {
	// Canonical (inputKey, path) order: implicit video, implicit audio, other
	// ingest, fileStreams, dolby (vision: video then metadata).
	const pairs: { inputKey: string; path: string }[] = [];
	const push = (ik: string | undefined, p: string | undefined) => {
		if (p !== undefined) {
			pairs.push({ inputKey: ik ?? "main", path: p });
		}
	};
	const find = (k: string) => ingest.find((r) => asString(r.key) === k);
	push(asString(find("video")?.inputKey), asString(find("video")?.inputPath));
	push(asString(find("audio")?.inputKey), asString(find("audio")?.inputPath));
	for (const row of ingest) {
		const k = asString(row.key);
		if (k === "video" || k === "audio") {
			continue;
		}
		push(asString(row.inputKey), asString(row.inputPath));
	}
	for (const fs of fileStreams) {
		push(asString(fs.inputKey), asString(fs.inputPath));
	}
	for (const d of dolbyStreams) {
		const ik = asString(d.inputKey);
		if (asString(d.kind) === "VISION") {
			push(ik, asString(d.videoInputPath));
			push(ik, asString(d.metadataInputPath));
		} else {
			push(ik, asString(d.inputPath));
		}
	}

	const inputFiles: WizardInputFile[] = [];
	const keyMap = new Map<string, string>();
	const mapKey = (ik: string, p: string) => `${ik}\u0000${p}`;
	// Process inputs[] in order so inputFiles' inputKey first-occurrence order
	// matches inputs[] — buildPlan re-derives the same Bitmovin input order.
	for (const input of inputs) {
		const ik = asString(input.key) ?? "main";
		const kind = inputKindOf(asString(input.kind));
		const credentialId = asString(input.credentialId) ?? "";
		const bucket = readLocation(input);
		const name = asString(input.name);
		const make = (fileKey: string, path: string): WizardInputFile => {
			const f: WizardInputFile = {
				key: fileKey,
				inputKey: ik,
				kind,
				credentialId,
				bucket,
				path,
			};
			if (
				(kind === "GCS" || kind === "GCS_SERVICE_ACCOUNT") &&
				asString(input.region) !== undefined
			) {
				f.region = asString(input.region);
			}
			if (name !== undefined) {
				f.name = name;
			}
			return f;
		};
		let n = 0;
		const seen = new Set<string>();
		for (const pair of pairs) {
			if (pair.inputKey !== ik || seen.has(pair.path)) {
				continue;
			}
			seen.add(pair.path);
			const fileKey = n === 0 ? ik : `${ik}-${n + 1}`;
			n += 1;
			inputFiles.push(make(fileKey, pair.path));
			keyMap.set(mapKey(ik, pair.path), fileKey);
		}
		// Input declared but read at no path (rare) — keep a path-less file so
		// the inputs[] entry still round-trips.
		if (n === 0) {
			inputFiles.push(make(ik, ""));
		}
	}
	return {
		inputFiles,
		fileKeyFor: (ik, p) => keyMap.get(mapKey(ik ?? "main", p)) ?? ik ?? "main",
	};
}

/**
 * Best-effort inverse of buildPlan. ALWAYS returns a state; correctness is
 * the round-trip gate's job (tryImportPresetIntoWizard), not this function's.
 */
export function planToWizardState(raw: Record<string, unknown>): WizardState {
	const bitmovin = isRecord(raw.bitmovin) ? raw.bitmovin : {};
	const inputs = asArray(raw.inputs).filter(isRecord);
	const outputs = asArray(raw.outputs).filter(isRecord);
	const ingest = asArray(raw.ingest).filter(isRecord);
	const renditions = asArray(raw.renditions).filter(isRecord);
	const muxings = asArray(raw.muxings).filter(isRecord);
	const manifests = asArray(raw.manifests).filter(isRecord);
	const fileStreams = asArray(raw.fileStreams).filter(isRecord);
	const filters = asArray(raw.filters).filter(isRecord);

	const origin = outputs[0] ?? {};
	//  PR-b: mirror outputs map back through the mirror-N key
	// convention buildPlan emits; anything else (odd keys, extra outputs no
	// mirror references) simply fails the round-trip gate and opens via the
	// imported-plan path, like every other fidelity rule here.
	const additionalOutputs = asArray(raw.deliveryMirrors)
		.filter(isRecord)
		.flatMap((mirror) => {
			const key = asString(mirror.outputKey);
			const output = outputs.find((o) => asString(o.key) === key);
			if (!output) {
				return [];
			}
			const kind = (asString(output.kind) ??
				"S3") as WizardState["output"]["kind"];
			return [
				{
					credentialId: asString(output.credentialId) ?? "",
					kind,
					bucket: kind === "SFTP" ? "" : readLocation(output),
					name: asString(output.name) ?? "Mirror Output",
					...((kind === "GCS" || kind === "GCS_SERVICE_ACCOUNT") &&
					asString(output.region) !== undefined
						? { region: asString(output.region) }
						: {}),
				},
			];
		});
	const videoIngest = ingest.find((row) => asString(row.key) === "video");
	const audioIngest = ingest.find((row) => asString(row.key) === "audio");

	// Split inputs[] + every stream's (inputKey, path) into one input FILE per
	// object; streams reference files by key, the object path lives on the file.
	const dolbyStreamsRaw = asArray(raw.dolbyStreams).filter(isRecord);
	const { inputFiles, fileKeyFor } = collectInputFiles(
		inputs,
		ingest,
		[
			...fileStreams,
			...renditions.flatMap((r) =>
				isRecord(r.burnInSrt) ? [r.burnInSrt] : [],
			),
		],
		dolbyStreamsRaw,
	);
	// Separate A/V: the implicit audio reads a different input file than the
	// video (inputFiles[0]); absent = the same object.
	const videoFileKey = inputFiles[0]?.key;
	const audioFileKey =
		audioIngest !== undefined
			? fileKeyFor(
					asString(audioIngest.inputKey),
					asString(audioIngest.inputPath) ?? "",
				)
			: undefined;
	const audioInputFile =
		audioFileKey !== undefined && audioFileKey !== videoFileKey
			? audioFileKey
			: undefined;

	const { base, publicRead } = readBasePath(manifests, muxings);

	const outputKind = outputKindOf(asString(origin.kind));

	const videos: WizardVideoRendition[] = [];
	const audios: WizardAudioRendition[] = [];
	const subtitles: WizardSubtitle[] = [];
	const videoRaw: Record<string, unknown>[] = [];
	const audioRaw: Record<string, unknown>[] = [];
	const subtitleRaw: Record<string, unknown>[] = [];
	for (const r of renditions) {
		const codec = asString(r.codec);
		if (
			codec === "H264" ||
			codec === "H265" ||
			codec === "VP9" ||
			codec === "AV1"
		) {
			const video = readVideo(r);
			if (isRecord(r.burnInSrt)) {
				video.extras = {
					...video.extras,
					burnInSrt: {
						inputFile: fileKeyFor(
							asString(r.burnInSrt.inputKey),
							asString(r.burnInSrt.inputPath) ?? "",
						),
						characterEncoding: r.burnInSrt.characterEncoding as NonNullable<
							WizardRenditionExtras["burnInSrt"]
						>["characterEncoding"],
					},
				};
			}
			videos.push(video);
			videoRaw.push(r);
		} else if (codec === "WEBVTT" || codec === "IMSC") {
			const sub: WizardSubtitle = {
				source: asString(r.ingestKey) ?? "",
				...(codec === "IMSC"
					? { codec: "IMSC", styling: r.styling as WizardSubtitle["styling"] }
					: {}),
			};
			const label = asString(r.label);
			if (
				label !== undefined &&
				label !== (codec === "IMSC" ? "English" : "english - sample")
			) {
				sub.label = label;
			}
			const language = asString(r.language);
			if (language !== undefined && language !== "en") {
				sub.language = language;
			}
			const groupId = asString(r.groupId);
			if (groupId !== undefined && groupId !== "SUBTITLE") {
				sub.groupId = groupId;
			}
			const uri = asString(r.uri);
			if (uri !== undefined && uri !== "subtitles_en.m3u8") {
				sub.uri = uri;
			}
			subtitles.push(sub);
			subtitleRaw.push(r);
		} else {
			audios.push(readAudio(r));
			audioRaw.push(r);
		}
	}

	// Resolve resource keys: leave them derived (clean) when buildPlan's
	// key derivation already reproduces the plan's keys; otherwise pin each
	// via extras.key so multi-bitrate / custom-keyed ladders round-trip.
	const vDerived = videoKeys(videos);
	const vRawKeys = videoRaw.map((r, i) => asString(r.key) ?? vDerived[i] ?? "");
	if (!plansDeepEqual(vDerived, vRawKeys)) {
		videos.forEach((video, i) => {
			video.extras = { ...(video.extras ?? {}), key: vRawKeys[i] };
		});
	}
	const aDerived = audioKeys(audios);
	const aRawKeys = audioRaw.map((r, i) => asString(r.key) ?? aDerived[i] ?? "");
	if (!plansDeepEqual(aDerived, aRawKeys)) {
		audios.forEach((audio, i) => {
			audio.extras = { ...(audio.extras ?? {}), key: aRawKeys[i] };
		});
	}
	const sDerived = subtitleKeys(subtitles);
	const sRawKeys = subtitleRaw.map(
		(r, i) => asString(r.key) ?? sDerived[i] ?? "",
	);
	if (!plansDeepEqual(sDerived, sRawKeys)) {
		subtitles.forEach((sub, i) => {
			sub.extras = { ...(sub.extras ?? {}), key: sRawKeys[i] };
		});
	}

	// Final keys (post key-resolution) drive muxing default-path detection.
	const vKeys = videoKeys(videos);
	const aKeys = audioKeys(audios);
	const sKeys = subtitleKeys(subtitles);
	// Muxings are tied to renditions by streamKey; one stream may have several
	// legs (e.g. fMP4 for DASH + TS for HLS), so collect ALL muxings per stream.
	const muxingsByStreamKey = new Map<string, Record<string, unknown>[]>();
	for (const mux of muxings) {
		const streamKey = asString(mux.streamKey) ?? asString(mux.key);
		if (streamKey !== undefined) {
			const group = muxingsByStreamKey.get(streamKey) ?? [];
			group.push(mux);
			muxingsByStreamKey.set(streamKey, group);
		}
	}
	// Splits a stream's muxings into the primary leg (key === stream key, else
	// the first) and any extra legs.
	const assignMuxings = (
		key: string,
		rel: string,
		defaultKind: "FMP4" | "CHUNKED_TEXT" | "TEXT",
	): { muxing?: WizardMuxing; extraMuxings?: WizardMuxing[] } => {
		const group = muxingsByStreamKey.get(key) ?? [];
		const primaryRaw = group.find((m) => asString(m.key) === key) ?? group[0];
		const muxing = readMuxing(primaryRaw, base, rel, defaultKind, key);
		const extraMuxings = group
			.filter((m) => m !== primaryRaw)
			.map((m) => readMuxing(m, base, rel, defaultKind, key))
			.filter((m): m is WizardMuxing => m !== undefined);
		return {
			...(muxing ? { muxing } : {}),
			...(extraMuxings.length > 0 ? { extraMuxings } : {}),
		};
	};
	// Derived muxing rel path per key — shared with DRM-leg destination recovery
	// (DRM legs write where the plain muxing would, so their muxing carries none).
	const relPathByKey = new Map<string, string>();
	videos.forEach((video, i) => {
		const key = vKeys[i] ?? "";
		const rel = videoMuxingRelPath(video, key);
		relPathByKey.set(key, rel);
		Object.assign(video, assignMuxings(key, rel, "FMP4"));
	});
	/**
	 * Which audio keys each MUXING carries, straight off the plan.
	 *
	 * `additionalStreamKeys` is already the relation the wizard now models, so
	 * this is a copy rather than a reconstruction. The previous readback had to
	 * INVENT wizard state — it collapsed every carrier into a set of container
	 * KINDS and re-broadcast them on reopen, which is how a plan carrying the
	 * track in one rung came back carrying it in all of them.
	 */
	const carriedByMuxingKey = new Map<string, string[]>();
	for (const mux of muxings) {
		const muxKey = asString(mux.key);
		const extra = Array.isArray(mux.additionalStreamKeys)
			? mux.additionalStreamKeys.flatMap((raw) => {
					const k = asString(raw);
					return k === undefined ? [] : [k];
				})
			: [];
		if (muxKey !== undefined && extra.length > 0) {
			carriedByMuxingKey.set(muxKey, extra);
		}
	}
	/** Audio keys some container carries — the other half of `ownContainer`. */
	const carriedAnywhere = new Set([...carriedByMuxingKey.values()].flat());
	audios.forEach((audio, i) => {
		const key = aKeys[i] ?? "";
		const rel = audioMuxingRelPath(audio, key);
		relPathByKey.set(key, rel);
		Object.assign(audio, assignMuxings(key, rel, "FMP4"));
		// A carried track with NO container of its own is the classic muxed
		// layout; say so explicitly, because absent means "build one".
		if (carriedAnywhere.has(key) && audio.muxing === undefined) {
			audio.muxing = { ownContainer: false };
		}
	});
	subtitles.forEach((sub, i) => {
		const key = sKeys[i] ?? "";
		const rel = `subtitles/${key}`;
		relPathByKey.set(key, rel);
		const { muxing } = assignMuxings(
			key,
			rel,
			sub.codec === "IMSC" ? "TEXT" : "CHUNKED_TEXT",
		);
		if (muxing) {
			sub.muxing = muxing;
		}
	});

	// audioGuard is all-or-nothing: every audio rendition carries the
	// AUDIOSTREAMCOUNT>0 condition, nothing else does.
	const audioGuard =
		audioRaw.length > 0 &&
		audioRaw.every((r) => {
			const c = isRecord(r.conditions) ? r.conditions : undefined;
			return (
				asString(c?.attribute) === "AUDIOSTREAMCOUNT" &&
				asString(c?.operator) === "GREATER_THAN" &&
				asString(c?.value) === "0"
			);
		});

	// Read before the literal: `hlsDefaultVersion` needs it (a VMAF-only plan
	// emits no standalone audio containers, so they cannot imply a version).
	const qcState = readQc(raw);
	const state: WizardState = {
		...DEFAULT_WIZARD_STATE,
		name: asString(raw.name) ?? "",
		accountId: asString(bitmovin.accountId) ?? "",
		cloudRegion: asString(bitmovin.cloudRegion) ?? "AUTO",
		encoderVersion: asString(bitmovin.encoderVersion) ?? "STABLE",
		inputFiles,
		output: {
			credentialId: asString(origin.credentialId) ?? "",
			kind: outputKind,
			bucket: outputKind === "SFTP" ? "" : readLocation(origin),
			basePath: base,
			publicRead,
			name: asString(origin.name) ?? "S3 Output",
			...((outputKind === "GCS" || outputKind === "GCS_SERVICE_ACCOUNT") &&
			asString(origin.region) !== undefined
				? { region: asString(origin.region) }
				: {}),
		},
		additionalOutputs,
		videos,
		audios,
		audioGuard,
		manifests: readManifests(
			manifests,
			// The SAME derivation buildPlan will run on the state being built —
			// so the version the importer drops is exactly the one re-emitted.
			// Both pins and both families, or the importer keeps a value the
			// builder would have derived (and vice versa): the two halves of
			// 's lockstep, widened together for HIGH-4.
			hlsDefaultVersion(
				{ videos, audios, qc: qcState },
				(() => {
					const primaryHls = manifests.find((m) => asString(m.kind) === "HLS");
					const pin = (value: unknown) => {
						const leg = asString(value);
						return leg === "FMP4" || leg === "MP4" || leg === "TS"
							? leg
							: undefined;
					};
					if (!primaryHls) {
						return undefined;
					}
					return {
						videoMuxingKind: pin(primaryHls.videoMuxingKind),
						audioMuxingKind: pin(primaryHls.audioMuxingKind),
					};
				})(),
			),
		),
		timing:
			asString(isRecord(raw.generation) ? raw.generation.timing : undefined) ===
			"POST_ENCODING"
				? "POST_ENCODING"
				: "JUST_IN_TIME",
	};

	if (audioInputFile !== undefined) {
		state.audioInputFile = audioInputFile;
	}

	// Encoding labels + Cloud Connect infrastructure (bitmovin block). Absent
	// keys leave the state fields undefined so buildPlan emits nothing back.
	// A present-but-empty labels array is NOT representable (buildPlan only
	// emits non-empty) — the round-trip gate falls back for it, by design.
	if (Array.isArray(bitmovin.prewarmedEncoderPoolIds)) {
		state.prewarmedEncoderPoolIds = bitmovin.prewarmedEncoderPoolIds.filter(
			(id): id is string => typeof id === "string",
		);
	}
	if (Array.isArray(bitmovin.labels) && bitmovin.labels.length > 0) {
		state.labels = bitmovin.labels.filter(
			(label): label is string => typeof label === "string",
		);
	}
	if (
		isRecord(raw.internal) &&
		isRecord(raw.internal.hevcV2) &&
		typeof raw.internal.hevcV2.bcfVersion === "string"
	) {
		state.internal = { hevcV2: { bcfVersion: raw.internal.hevcV2.bcfVersion } };
		state.videos = state.videos.map((video) =>
			video.codec === "H265" ? { ...video, codec: "H265V2" } : video,
		);
	}
	const infrastructure = isRecord(bitmovin.infrastructure)
		? bitmovin.infrastructure
		: undefined;
	if (infrastructure) {
		const infrastructureId = asString(infrastructure.infrastructureId);
		const infraRegion = asString(infrastructure.cloudRegion);
		if (infrastructureId !== undefined && infraRegion !== undefined) {
			state.infrastructure = { infrastructureId, cloudRegion: infraRegion };
		}
	}

	// Sources: WEBVTT sidecar file streams (subtitle inputs).
	if (fileStreams.length > 0) {
		const streams: WizardFileStream[] = fileStreams.map((stream) => {
			const fs: WizardFileStream = {
				...(stream.fileType === "TTML" ? { fileType: "TTML" } : {}),
				key: asString(stream.key) ?? "",
				inputFile: fileKeyFor(
					asString(stream.inputKey),
					asString(stream.inputPath) ?? "",
				),
			};
			const encodingKey = asString(stream.encodingKey);
			if (encodingKey !== undefined) {
				fs.encodingKey = encodingKey;
			}
			return fs;
		});
		state.sources = { ...(state.sources ?? {}), fileStreams: streams };
	}

	if (subtitles.length > 0) {
		state.subtitles = subtitles;
	}

	// Deinterlace filters.
	if (filters.length > 0) {
		const deinterlace: WizardDeinterlaceFilter[] = filters
			.filter((f) => asString(f.kind) === "DEINTERLACE")
			.map((f) => {
				const filter: WizardDeinterlaceFilter = {
					key: asString(f.key) ?? "",
				};
				const parity = nonDefault(asString(f.parity), "AUTO");
				if (parity !== undefined) {
					filter.parity = parity as WizardDeinterlaceFilter["parity"];
				}
				const mode = nonDefault(asString(f.mode), "FRAME");
				if (mode !== undefined) {
					filter.mode = mode as WizardDeinterlaceFilter["mode"];
				}
				const frameSelectionMode = nonDefault(
					asString(f.frameSelectionMode),
					"ALL",
				);
				if (frameSelectionMode !== undefined) {
					filter.frameSelectionMode =
						frameSelectionMode as WizardDeinterlaceFilter["frameSelectionMode"];
				}
				const autoEnable = nonDefault(
					asString(f.autoEnable),
					"META_DATA_AND_CONTENT_BASED",
				);
				if (autoEnable !== undefined) {
					filter.autoEnable =
						autoEnable as WizardDeinterlaceFilter["autoEnable"];
				}
				return filter;
			});
		state.filters = filters.flatMap(
			(f): import("./build-plan").WizardFilter[] => {
				if (asString(f.kind) === "DEINTERLACE")
					return deinterlace.filter((d) => d.key === f.key).slice(0, 1);
				const result = mediaFilterSchema.safeParse(f);
				return result.success ? [result.data] : [];
			},
		);
	}

	// Multi-encoding partitions, Dolby/VISION input streams, ad-cue keyframes,
	// extra ingest tracks, and the implicit-track encoding assignment.
	const encodings = readEncodings(raw);
	const dolbyStreams = readDolbyStreams(raw, fileKeyFor);
	const trimmingStreams = readTrimmingStreams(raw);
	const concatenationStreams = readConcatenationStreams(raw);
	const audioMixStreams = asArray(raw.audioMixStreams).map((s) =>
		audioMixStreamSchema.parse(s),
	);
	const keyframes = readKeyframes(raw);
	const tracks = readTracks(ingest, fileKeyFor);
	const videoEnc = asString(videoIngest?.encodingKey);
	const audioEnc = asString(audioIngest?.encodingKey);
	const sourceAdditions: Partial<WizardSources> = {};
	if (encodings.length > 0) {
		sourceAdditions.encodings = encodings;
	}
	if (dolbyStreams.length > 0) {
		sourceAdditions.dolbyStreams = dolbyStreams;
	}
	if (trimmingStreams.length > 0) {
		sourceAdditions.trimmingStreams = trimmingStreams;
	}
	if (audioMixStreams.length > 0)
		sourceAdditions.audioMixStreams = audioMixStreams;
	if (concatenationStreams.length > 0) {
		sourceAdditions.concatenationStreams = concatenationStreams;
	}
	if (keyframes.length > 0) {
		sourceAdditions.keyframes = keyframes;
	}
	if (tracks.length > 0) {
		sourceAdditions.tracks = tracks;
	}
	if (videoEnc !== undefined || audioEnc !== undefined) {
		sourceAdditions.implicitEncodingKeys = {
			...(videoEnc !== undefined ? { video: videoEnc } : {}),
			...(audioEnc !== undefined ? { audio: audioEnc } : {}),
		};
	}
	if (Object.keys(sourceAdditions).length > 0) {
		state.sources = { ...(state.sources ?? {}), ...sourceAdditions };
	}

	// DRM rows (CENC / FairPlay). credentialId is vault material (cleared by
	// clearSamplePlaceholders); kid/PSSH/iv/uri are public manifest metadata.
	const drm = readDrm(raw, base, relPathByKey);
	if (drm.length > 0) {
		state.drm = drm;
	}

	const thumbnails = readThumbnails(raw, base);
	if (thumbnails.length > 0) {
		state.thumbnails = thumbnails;
	}

	const sprites = readSprites(raw, base);
	if (sprites.length > 0) {
		state.sprites = sprites;
	}

	// Start-request blocks: encodingMode, tweaks (audioVideoSyncMode), VFR
	// handling, Per-Title codec configs, AI Scene.
	const generation = isRecord(raw.generation) ? raw.generation : {};
	const encodingMode = asString(generation.encodingMode);
	const audioVideoSyncMode = asString(generation.audioVideoSyncMode);
	const handleVariableInputFps = asBool(generation.handleVariableInputFps);
	const perTitle = readPerTitle(raw);
	const aiSceneAnalysis = readAiScene(raw, base);
	if (
		encodingMode !== undefined ||
		audioVideoSyncMode !== undefined ||
		handleVariableInputFps !== undefined ||
		perTitle ||
		aiSceneAnalysis
	) {
		state.startOptions = {
			...(state.startOptions ?? {}),
			...(encodingMode !== undefined
				? {
						encodingMode: encodingMode as NonNullable<
							WizardState["startOptions"]
						>["encodingMode"],
					}
				: {}),
			...(audioVideoSyncMode !== undefined
				? {
						audioVideoSyncMode: audioVideoSyncMode as NonNullable<
							WizardState["startOptions"]
						>["audioVideoSyncMode"],
					}
				: {}),
			// Explicit false survives readback (buildPlan re-emits any SET value).
			...(handleVariableInputFps !== undefined
				? { handleVariableInputFps }
				: {}),
			...(perTitle ? { perTitle } : {}),
			...(aiSceneAnalysis ? { aiSceneAnalysis } : {}),
		};
	}

	// QC toggle (VMAF + optional PSNR). Absent ⇒ left off (no qc state).
	// : carry the delivery commitment back into the form state, so a
	// committed plan stays form-representable instead of falling into the
	// verbatim-import path where it can be neither seen nor removed.
	const delivery = isRecord(raw.delivery) ? raw.delivery : undefined;
	if (delivery && typeof delivery.specId === "string") {
		state.delivery = {
			specId: delivery.specId,
			...(delivery.onDeviation === "WARN" || delivery.onDeviation === "REFUSE"
				? { onDeviation: delivery.onDeviation }
				: {}),
		};
	}
	if (qcState) {
		state.qc = qcState;
	}

	// Kantar audio watermarking (plan-root singleton). Absent ⇒ section off.
	const kantar = readKantar(raw, base);
	if (kantar) {
		state.kantar = kantar;
	}

	// Preserve explicit private access without pinning every imported row: the
	// global public-read control must still update destinations that inherit it.
	const destinationRows = [...manifests, ...muxings].filter((row) =>
		isRecord(row.destination),
	);
	const explicitPrivateAcl =
		!publicRead &&
		destinationRows.some((row) => readDestinationAcl(row) === "PRIVATE");
	if (explicitPrivateAcl) state.output.explicitPrivateAcl = true;
	const inheritedAcl = publicRead
		? "PUBLIC_READ"
		: explicitPrivateAcl
			? "PRIVATE"
			: null;
	const inheritAcl = <T extends { acl?: "PUBLIC_READ" | "PRIVATE" | null }>(
		bag: T | undefined,
	): T | undefined => {
		if (!bag) return undefined;
		if (bag.acl === inheritedAcl) delete bag.acl;
		return Object.keys(bag).length ? bag : undefined;
	};
	for (const row of [
		...state.videos,
		...state.audios,
		...(state.subtitles ?? []),
	]) {
		row.muxing = inheritAcl(row.muxing);
		if ("extraMuxings" in row)
			for (const muxing of row.extraMuxings ?? []) inheritAcl(muxing);
	}
	state.manifests.hlsOptions = inheritAcl(state.manifests.hlsOptions);
	state.manifests.dashOptions = inheritAcl(state.manifests.dashOptions);
	for (const manifest of state.manifests.extra ?? []) {
		if (manifest.kind === "HLS") manifest.hls = inheritAcl(manifest.hls);
		else if (manifest.kind === "DASH")
			manifest.dash = inheritAcl(manifest.dash);
		else inheritAcl(manifest);
	}
	return state;
}

/**
 * Zeroes sample/placeholder credential UUIDs so the wizard's credential
 * selects show "Select credential…" (an unmatched fake UUID would otherwise
 * pass z.uuid and arm Start with a credential that isn't in the vault).
 * Sample buckets/paths are kept as editable prefill — they don't gate Start.
 */
export function clearSamplePlaceholders(state: WizardState): WizardState {
	const clear = (id: string) => (isPlaceholderCredentialId(id) ? "" : id);
	const clearNexguard = (
		extras: WizardRenditionExtras | undefined,
	): WizardRenditionExtras | undefined =>
		extras?.nexguard
			? {
					...extras,
					nexguard: {
						...extras.nexguard,
						credentialId: clear(extras.nexguard.credentialId),
					},
				}
			: extras;
	const clearRendition = <T extends { extras?: WizardRenditionExtras }>(
		rendition: T,
	): T => {
		const extras = clearNexguard(rendition.extras);
		return extras === rendition.extras ? rendition : { ...rendition, extras };
	};
	return {
		...state,
		// accountId is "" for sample presets, but clear defensively so this stays
		// safe if reused for user-saved/exported plans carrying a placeholder id.
		accountId: clear(state.accountId),
		inputFiles: state.inputFiles.map((f) => ({
			...f,
			credentialId: clear(f.credentialId),
		})),
		output: { ...state.output, credentialId: clear(state.output.credentialId) },
		videos: state.videos.map(clearRendition),
		audios: state.audios.map(clearRendition),
		...(state.subtitles
			? { subtitles: state.subtitles.map(clearRendition) }
			: {}),
		...(state.drm
			? {
					drm: state.drm.map((row) => ({
						...row,
						credentialId: clear(row.credentialId),
					})),
				}
			: {}),
		// Kantar's vault credential is cleared like NexGuard's: the golden's
		// placeholder id would otherwise pass z.uuid and arm Start against a
		// KANTAR credential that isn't in the vault.
		...(state.kantar
			? {
					kantar: {
						...state.kantar,
						credentialId: clear(state.kantar.credentialId),
					},
				}
			: {}),
	};
}

/**
 * Return a translation message key explaining why a preset cannot open in the
 * wizard form. Returning prose would mix languages inside the caller's
 * translated sentence.
 */
export type PresetFallbackReasonKey =
	| "wizardX.reasonNotAValidPlan"
	| "wizardX.reasonCannotBeRebuilt"
	| "wizardX.reasonUsesUnrepresentedOptions";

export type PresetImportResult =
	| { ok: true; state: WizardState }
	| { ok: false; reasonKey: PresetFallbackReasonKey };

/**
 * Attempts to load a saved plan into the wizard FORM. Succeeds only when the
 * form can rebuild the plan exactly (round-trip gate); otherwise returns a
 * reason for the caller to show beside the verbatim imported-plan fallback.
 */
export function tryImportPresetIntoWizard(
	raw: Record<string, unknown>,
): PresetImportResult {
	// Repair the former HEVCv2 builder's duplicate START mode when copying its plans.
	if (
		isRecord(raw.internal) &&
		isRecord(raw.internal.hevcV2) &&
		isRecord(raw.generation) &&
		raw.generation.encodingMode === "SMART_PASS" &&
		Array.isArray(raw.renditions) &&
		raw.renditions.every(
			(r) =>
				isRecord(r) &&
				(!["H264", "H265", "VP9", "AV1"].includes(String(r.codec)) ||
					(r.codec === "H265" &&
						(r.encodingMode === undefined || r.encodingMode === "SMART_PASS"))),
		)
	) {
		const { encodingMode: _mode, ...generation } = raw.generation;
		raw = {
			...raw,
			generation,
			renditions: raw.renditions.map((r) =>
				isRecord(r) && r.codec === "H265"
					? { ...r, encodingMode: "SMART_PASS" }
					: r,
			),
		};
	}
	const parsed = encodingPlanSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, reasonKey: "wizardX.reasonNotAValidPlan" };
	}
	const gap = describeFormGap(parsed.data);
	if (gap) {
		return { ok: false, reasonKey: gap };
	}
	// Unresolved sample-path tokens (<INSERT…>, <REDACTED…>, {YOUR …}) map into
	// the form like any other field; the wizard's Start gate (formPlaceholders)
	// keeps them from being submitted until the user replaces them in the path
	// inputs. (C4 {uuid}/{bitrate}/{height} are run-time placeholders, kept.)
	const state = planToWizardState(raw);
	let rebuilt: unknown;
	try {
		rebuilt = encodingPlanSchema.parse(buildPlan(state));
	} catch {
		return { ok: false, reasonKey: "wizardX.reasonCannotBeRebuilt" };
	}
	if (!plansDeepEqual(rebuilt, parsed.data)) {
		return {
			ok: false,
			reasonKey: "wizardX.reasonUsesUnrepresentedOptions",
		};
	}
	return { ok: true, state: clearSamplePlaceholders(state) };
}
