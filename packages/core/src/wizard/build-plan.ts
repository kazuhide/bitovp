import { hlsLegSelected, hlsVersionForLegs } from "../plan/hls-legs";
import type { QcGate } from "../plan/qc-gate";
import {
	type AV1_DYNAMIC_RANGE_FORMATS,
	DEFAULT_VMAF_MODEL,
	type EncodingPlanInput,
	type H265V2PerceptualQualityModeConfig,
	srtCharacterEncodingSchema,
} from "../plan/schema";
import type { VmafExecution } from "../vmaf/cloud";

/**
 * Pure mapping from wizard state to an EncodingPlan (input shape — zod
 * applies defaults at parse). Path/name derivation mirrors the
 * encoding examples family so a wizard-built plan for a fixture scenario is
 * byte-equal to the committed plan fixture (asserted by tests — this is
 * the "reproduce via UI" evidence for the P1/P2 exits).
 *
 * Evolution contract (P2 8b): every field beyond the P1 surface is
 * OPTIONAL and emits nothing when unset, so the four P1 deep-equal
 * fixtures stay byte-identical for default-shaped state. buildPlan only
 * includes keys the user actually set — schema defaults fill the rest at
 * parse time, keeping plans as minimal as the samples.
 */

export { SRT_CHARACTER_ENCODING_VALUES } from "../plan/srt-character-encodings";
export const SRT_CHARACTER_ENCODINGS = srtCharacterEncodingSchema.options;

export type WizardStreamSelectionMode =
	| "AUTO"
	| "POSITION_ABSOLUTE"
	| "VIDEO_RELATIVE"
	| "AUDIO_RELATIVE";

/**
 * One input OBJECT the job reads — a complete (credential + bucket + object
 * path) location. Streams reference an input file by `key`; the object path
 * lives here, not re-entered on each stream.
 *
 * Multiple input files can share one Bitmovin Input (same kind+credential+
 * bucket) read at different object paths — the common Dolby / video+subtitle
 * shape. `inputKey` is that shared Bitmovin-input id (the dedupe anchor):
 * buildPlan groups input files by `inputKey` into one inputs[] entry, and
 * plan-to-wizard preserves the plan's keys (`main`/`metadata`/…) so the
 * round-trip is byte-stable.
 */
/**
 * Storage kinds the wizard can author. The S3-compatible / GCS kinds
 * (GENERIC_S3 backs Akamai/OCI/GenericS3 per C10; GCS = HMAC; GCS_SERVICE_ACCOUNT
 * = service-account JSON) all use a bucket + credential, like S3. GCS inputs
 * and outputs may optionally select a GoogleCloudRegion name.
 */
export type WizardStorageKind =
	| "S3"
	| "AZURE"
	| "HTTPS"
	| "GENERIC_S3"
	| "GCS"
	| "GCS_SERVICE_ACCOUNT"
	/**  — source side of Akamai NetStorage; no bucket, no browse. */
	| "AKAMAI_NETSTORAGE";

/** Storage kinds that carry an object/bucket location AND can be browsed. */
export type WizardBucketKind = Exclude<WizardStorageKind, "AZURE" | "HTTPS">;

export type WizardInputFile = {
	/** Per-object id streams reference. */
	key: string;
	/** Shared Bitmovin Input id (dedupe anchor); files on one input share it. */
	inputKey: string;
	kind: WizardStorageKind;
	/** Empty for HTTPS (no credential). */
	credentialId: string;
	/** S3 bucket / Azure container / HTTPS host. */
	bucket: string;
	path: string;
	/** Optional GoogleCloudRegion name for GCS storage. */
	region?: string;
	/** Bitmovin Input resource name (on the deduped input). */
	name?: string;
};

/** Extra ingest track beyond the implicit video/audio pair. */
export type WizardIngestTrack = {
	key: string;
	/** Input file (object) this track reads. */
	inputFile: string;
	selectionMode: WizardStreamSelectionMode;
	position: number;
	encodingKey?: string;
};

/** WEBVTT sidecar file (whole-file input stream). */
export type WizardFileStream = {
	fileType?: "WEBVTT" | "TTML";
	key: string;
	/** Input file (object) this sidecar reads. */
	inputFile: string;
	encodingKey?: string;
};

export type WizardDolbyStream =
	| {
			kind: "ATMOS";
			key: string;
			/** Input file (the Atmos master object). */
			inputFile: string;
			inputFormat: "DAMF" | "ADM" | "MXF";
			encodingKey?: string;
	  }
	| {
			kind: "VISION";
			key: string;
			/** Input file holding the video mezzanine object. */
			videoInputFile: string;
			/** Optional input file holding the separate metadata sidecar object. */
			metadataInputFile?: string;
			encodingKey?: string;
	  }
	| {
			kind: "VISION_METADATA";
			key: string;
			/** Input file holding the metadata sidecar object. */
			inputFile: string;
			encodingKey?: string;
	  };

/**
 * Trimming input stream (the modern path) — wraps another input stream
 * (`sourceKey`, in the shared namespace) and a rendition references THIS key.
 * One of three variants; offset/duration are seconds, timecodes SMPTE-12M.
 */
export type WizardTrimmingStream =
	| {
			kind: "TIME_BASED";
			key: string;
			sourceKey: string;
			offset?: number;
			duration?: number;
			encodingKey?: string;
	  }
	| {
			kind: "TIMECODE_TRACK";
			key: string;
			sourceKey: string;
			startTimeCode?: string;
			endTimeCode?: string;
			encodingKey?: string;
	  }
	| {
			kind: "H264_PICTURE_TIMING";
			key: string;
			sourceKey: string;
			startPicTiming?: string;
			endPicTiming?: string;
			encodingKey?: string;
	  };

/** One ordered part of a concatenation (references an input stream). */
export type WizardConcatenationSource = {
	sourceKey: string;
	isMain?: boolean;
	position?: number;
	paddingBefore?: { duration: number; unit?: "SECONDS" | "FRAMES" };
	paddingAfter?: { duration: number; unit?: "SECONDS" | "FRAMES" };
	aspectMode?: "PAD" | "CROP" | "STRETCH";
};

/** Concatenation input stream — stitches ordered sources; a rendition reads THIS key. */
export type WizardConcatenationStream = {
	key: string;
	sources: WizardConcatenationSource[];
	encodingKey?: string;
};

/** Multi-encoding partition row (Dolby DV/HDR10/SDR ladders). */
export type WizardEncodingRow = {
	key: string;
	name: string;
	cloudRegion?: string;
};

export type WizardKeyframe = {
	key: string;
	time: number;
	encodingKey?: string;
};

/** Per-stream JPEG thumbnails (encodings.streams.thumbnails). */
export type WizardThumbnail = {
	key: string;
	/** Target rendition key (its stream). */
	streamKey: string;
	height: number;
	positions: number[];
	/** Default "thumbnail-%number%.jpg". */
	pattern?: string;
	/** Default SECONDS. */
	unit?: "SECONDS" | "PERCENTS";
	/** Destination path relative to the base output path. */
	path?: string;
};

/** Per-stream trick-play sprites (encodings.streams.sprites). */
export type WizardSprite = {
	key: string;
	/** Target rendition key (its stream). */
	streamKey: string;
	/** Sampling interval between tiles, in `unit`. */
	distance: number;
	/** Default SECONDS. */
	unit?: "SECONDS" | "PERCENTS";
	/** Tile width in px (≥1 of width/height required). */
	width?: number;
	/** Tile height in px (≥1 of width/height required). */
	height?: number;
	/** Grid rows (with vTiles) — XOR with imagesPerFile. */
	hTiles?: number;
	/** Grid columns (with hTiles) — XOR with imagesPerFile. */
	vTiles?: number;
	/** Tiles per file — XOR with hTiles/vTiles. */
	imagesPerFile?: number;
	/** Resource name (image extension required by the API). */
	spriteName?: string;
	/** Tiled-image filename (e.g. "sprite.jpg"). */
	filename: string;
	/** WebVTT index filename (e.g. "sprite.vtt"). */
	vttName?: string;
	/** INTERVAL_START (recommended for trick-play) | INTERVAL_END. */
	creationMode?: "INTERVAL_START" | "INTERVAL_END";
	/** Destination path relative to the base output path. */
	path?: string;
};

export type WizardSources = {
	audioMixStreams?: import("../plan/audio-mix").AudioMixStream[];
	tracks?: WizardIngestTrack[];
	fileStreams?: WizardFileStream[];
	dolbyStreams?: WizardDolbyStream[];
	/** Trimming/concatenation input streams (the modern path). */
	trimmingStreams?: WizardTrimmingStream[];
	concatenationStreams?: WizardConcatenationStream[];
	encodings?: WizardEncodingRow[];
	keyframes?: WizardKeyframe[];
	/**
	 * Multi-encoding assignment for the IMPLICIT video/audio tracks — a
	 * partitioned plan requires every ingest entry to reference one of
	 * plan.encodings, and the implicit pair has no source row to carry it.
	 */
	implicitEncodingKeys?: { video?: string; audio?: string };
};

export type WizardColorConfig = {
	copyColorPrimariesFlag?: boolean;
	copyColorTransferFlag?: boolean;
	copyColorSpaceFlag?: boolean;
	copyChromaLocationFlag?: boolean;
	copyColorRangeFlag?: boolean;
	colorSpace?: string;
	colorPrimaries?: string;
	colorTransfer?: string;
};

export type WizardPerTitleStreamSettings = {
	minBitrate?: number;
	maxBitrate?: number;
	bitrateSelectionMode?: "OPTIMIZED" | "COMPLEXITY_RANGE";
	lowComplexityBoundaryForMaxBitrate?: number;
	highComplexityBoundaryForMaxBitrate?: number;
};

export type WizardStreamMode =
	| "STANDARD"
	| "PER_TITLE_TEMPLATE"
	| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
	| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";

export type WizardNexGuard = {
	credentialId: string;
	watermarkType: "OTT" | "DUPLICATED";
	preset: string;
	strength?: "LIGHTEST" | "LIGHTER" | "DEFAULT" | "STRONGER" | "STRONGEST";
};

/** Per-rendition "Placement & extras" (all optional — absent = P1 shape). */
export type WizardRenditionExtras = {
	/** Resource-key override (multi-ladder plans where derived keys collide). */
	key?: string;
	/** Codec-config display name override. */
	name?: string;
	streamName?: string;
	/** Source stream key (track/fileStream/dolbyStream); absent = implicit. */
	source?: string;
	encodingKey?: string;
	hlsVariantLabel?: string;
	dashSetKey?: string;
	hlsMedia?: {
		groupId: string;
		name: string;
		uri: string;
		isDefault?: boolean;
		autoselect?: boolean;
	};
	mode?: WizardStreamMode;
	perTitleSettings?: WizardPerTitleStreamSettings;
	nexguard?: WizardNexGuard;
	burnInSrt?: {
		inputFile: string;
		characterEncoding: NonNullable<
			EncodingPlanInput["renditions"][number]["burnInSrt"]
		>["characterEncoding"];
	};
	/** Deinterlace attachments against the plan-level filters collection. */
	filters?: { filterKey: string; position: number }[];
};

export type WizardH264Options = {
	profile?: "BASELINE" | "MAIN" | "HIGH" | "HIGH422";
	level?: string;
	/** null = per-title templates leave the preset to the algorithm. */
	presetConfiguration?: string | null;
	rate?: number;
	minKeyframeInterval?: number;
	maxKeyframeInterval?: number;
	slices?: number;
	trellis?: string;
	mvSearchRangeMax?: number;
	rcLookahead?: number;
	subMe?: string;
	motionEstimationMethod?: string;
	sceneCutThreshold?: number;
	adaptiveQuantizationMode?: string;
	adaptiveQuantizationStrength?: number;
	mvPredictionMode?: string;
	psyRateDistortionOptimization?: number;
	psyTrellis?: number;
	refFrames?: number;
	bframes?: number;
	cabac?: boolean;
	adaptiveSpatialTransform?: boolean;
	weightedPredictionPFrames?: "DISABLED" | "SIMPLE" | "SMART";
	colorConfig?: WizardColorConfig;
};

export type WizardH265Options = {
	/** Native HEVCv2 controls; retained on codec changes for explicit validation. */
	motionCompensatedTemporalFiltering?: "AUTO" | "OFF" | "ON";
	rateControlModeConfig?: H265V2PerceptualQualityModeConfig;
	level?: string;
	profile?: "MAIN" | "MAIN10";
	presetConfiguration?: string;
	/** Explicit null = "leave to the algorithm" (per-title samples). */
	rate?: number | null;
	maxBitrate?: number;
	bufsize?: number;
	levelHighTier?: boolean;
	dynamicRangeFormat?:
		| "DOLBY_VISION"
		| "DOLBY_VISION_PROFILE_5"
		| "DOLBY_VISION_PROFILE_8_1"
		| "HDR10"
		| "HLG"
		| "SDR";
	minKeyframeInterval?: number;
	maxKeyframeInterval?: number;
	rcLookahead?: number;
	subMe?: number;
	maxCtuSize?: string;
	motionSearch?: string;
	tuIntraDepth?: string;
	tuInterDepth?: string;
	weightPredictionOnPSlice?: boolean;
	weightPredictionOnBSlice?: boolean;
	sceneCutThreshold?: number;
	motionSearchRange?: number;
	adaptiveQuantizationMode?: string;
	adaptiveQuantizationStrength?: number;
	psyRateDistortionOptimization?: number;
	psyRateDistortionOptimizedQuantization?: number;
	qpMin?: number;
	sao?: boolean;
	// HDR10 group (MAIN10 + PQ + mastering metadata)
	hdr?: boolean;
	masterDisplay?: string;
	maxContentLightLevel?: number;
	maxPictureAverageLightLevel?: number;
	pixelFormat?: string;
	colorConfig?: WizardColorConfig;
	dolbyVisionMetadata?: {
		profile: "DVHE_04" | "DVHE_05" | "DVHE_07" | "HEV1_08" | "AVC3_09";
		metadataSource: "INPUT_STREAM" | "EMBEDDED";
		metadataStreamKey?: string;
	};
};

export type WizardVp9Options = {
	rate?: number | null;
	cpuUsed?: number;
	tileColumns?: number;
	qpMin?: number;
	qpMax?: number;
	rateUndershootPct?: number;
	rateOvershootPct?: number;
	quality?: string;
	lossless?: boolean | null;
	aqMode?: string;
	arnrType?: string;
	arnrMaxFrames?: number;
	arnrStrength?: number;
	colorConfig?: WizardColorConfig;
};

/** AV1 (Av1VideoConfiguration) — preset, level setup and dynamic range
 * as a subset of the SDK's AV1-specific settings. */
export type WizardAv1Options = {
	rate?: number | null;
	presetConfiguration?: "VOD_QUALITY" | "VOD_STANDARD" | "VOD_SPEED";
	autoLevelSetup?: "ENABLED" | "DISABLED";
	dynamicRangeFormat?: (typeof AV1_DYNAMIC_RANGE_FORMATS)[number];
	colorConfig?: WizardColorConfig;
};

export type WizardLoudnessControl = {
	meteringMode?:
		| "ITU_R_BS_1770_1"
		| "ITU_R_BS_1770_2"
		| "ITU_R_BS_1770_3"
		| "ITU_R_BS_1770_4"
		| "LEQ_A";
	dialogueIntelligence?: "ENABLED" | "DISABLED";
	speechThreshold?: number;
};

export type WizardMuxingKind =
	| "FMP4"
	| "CMAF"
	| "MP4"
	| "TS"
	| "WEBM"
	| "CHUNKED_TEXT"
	| "TEXT";

/** Per-rendition muxing leg (Muxings step). Absent = P1 fMP4 defaults. */
export type WizardMuxing = {
	/** Explicit imported destination ACL; null preserves omission. */
	acl?: "PUBLIC_READ" | "PRIVATE" | null;
	kind?: WizardMuxingKind;
	/** Muxing resource-key override (samples that name it apart from the
	 * stream key, e.g. "atmos448-mux"); streamKey stays the rendition key. */
	key?: string;
	name?: string;
	/**
	 * Destination path relative to the base output path ("" = the base
	 * itself). Absent = derived video/{height}p / audio/{bitrate} — and
	 * omitted entirely when a DRM row owns this muxing's output.
	 */
	path?: string;
	/** Editor-only ownership token: a matching path follows automatic height naming. */
	autoPath?: string;
	segmentLength?: number;
	segmentNaming?: string;
	/** FMP4/TS naming policy; takes precedence over literal segment naming. */
	segmentNamingTemplate?: string;
	initSegmentName?: string;
	initSegmentNameTemplate?: string;
	framesPerCmafChunk?: number;
	// MP4
	filename?: string;
	fragmentDuration?: number;
	manifestType?: "HLS_BYTE_RANGES" | "SMOOTH" | "DASH_ON_DEMAND";
	dolbyVisionTrackSampleEntryName?: "DVHE" | "DVH1";
	/**
	 * VIDEO CONTAINERS — the audio renditions that ride INSIDE this one.
	 *
	 * The choice lives on the CARRIER, which is the only place that can express
	 * what operators actually build. The first cut put it on the audio row as
	 * "muxed into the video", and that is a BROADCAST: one flag meaning "every
	 * video container of my kind". The owner rejected it with the case that
	 * breaks it, and the case is ordinary —
	 *
	 *     videoA ← audioA   videoB ← audioB   videoC ← audioA
	 *     videoD carries no audio   audioC ships standalone
	 *
	 * — a many-to-many relation between containers and tracks, which a flag on
	 * one side of it cannot hold. The PLAN could always express this
	 * (`additionalStreamKeys` is per-muxing, and the compiler, C33 and every
	 * rail handle the case above with zero issues — measured before this was
	 * rewritten); only the wizard could not.
	 *
	 * Maps 1:1 onto `additionalStreamKeys`, so there is nothing to translate.
	 * Absent = an ordinary single-stream container.
	 */
	muxedAudioKeys?: string[];
	/**
	 * AUDIO ROWS — build a standalone container for this track? Default yes.
	 *
	 * Separate from the above because the two are independent: a track can ride
	 * inside two video containers AND have its own (the mixed-ladder case, where
	 * the variants that carry it omit the audio group and the rest point at it),
	 * or ride inside them with no container of its own (the classic muxed
	 * layout), or have only its own and ride nowhere.
	 *
	 * `false` while no container carries it means the track is encoded and
	 * delivered nowhere — refused by PLAN_UNMUXED_RENDITION at error level.
	 */
	ownContainer?: boolean;
	/** Wizard-only provenance: redundant default automatically disabled. Never emitted into a plan. */
	autoOwnContainer?: boolean;
};

export type WizardVideoCodec = "H264" | "H265" | "H265V2" | "VP9" | "AV1";
export type WizardAudioCodec = "AAC" | "OPUS" | "DOLBY_ATMOS" | "DDPLUS" | "DD";

export type WizardVideoRendition = {
	width?: number;
	/** null = per-title template scales freely (height left to the run). */
	height: number | null;
	/** null = per-title leaves bitrate to the algorithm. */
	bitrate: number | null;
	codec?: WizardVideoCodec;
	encodingMode?: WizardStartOptions["encodingMode"];
	h264?: WizardH264Options;
	h265?: WizardH265Options;
	vp9?: WizardVp9Options;
	av1?: WizardAv1Options;
	extras?: WizardRenditionExtras;
	/** Editor-only ownership token: a matching key follows automatic height naming. */
	autoKey?: string;
	muxing?: WizardMuxing;
	/**
	 * Additional muxing legs from the SAME stream (e.g. a TS leg for HLS beside
	 * the fMP4 leg for DASH in the per-title H264 samples). Each needs its own
	 * `key`; streamKey stays the rendition key.
	 */
	extraMuxings?: WizardMuxing[];
};

export type WizardAudioRendition = {
	bitrate: number;
	rate: number;
	codec?: WizardAudioCodec;
	/** AAC / DDPLUS / DD channel layout (CL_*). */
	channelLayout?: string;
	/** DOLBY_ATMOS loudness control. */
	loudness?: WizardLoudnessControl;
	extras?: WizardRenditionExtras;
	muxing?: WizardMuxing;
	/** Additional muxing legs from the same stream (see WizardVideoRendition). */
	extraMuxings?: WizardMuxing[];
};

/** WEBVTT subtitle track fed by a WEBVTT fileStream. */
export type WizardSubtitle = {
	codec?: "WEBVTT" | "IMSC";
	styling?: { mode?: "PASSTHROUGH" | "DROP_STYLING" };
	/** WEBVTT fileStream key (sources.fileStreams). */
	source: string;
	label?: string;
	language?: string;
	groupId?: string;
	uri?: string;
	extras?: WizardRenditionExtras;
	muxing?: WizardMuxing;
};

function isMediaFilter(
	filter: WizardFilter,
): filter is import("../plan/media-filters").MediaFilter {
	return filter.kind !== undefined && filter.kind !== "DEINTERLACE";
}
export type WizardFilter =
	| WizardDeinterlaceFilter
	| import("../plan/media-filters").MediaFilter;
export type WizardDeinterlaceFilter = {
	kind?: "DEINTERLACE";
	key: string;
	parity?: "AUTO" | "TOP_FIELD_FIRST" | "BOTTOM_FIELD_FIRST";
	mode?: "FRAME" | "FIELD" | "FRAME_NOSPATIAL" | "FIELD_NOSPATIAL";
	frameSelectionMode?: "ALL" | "INTERLACED";
	autoEnable?: "ALWAYS_ON" | "META_DATA_BASED" | "META_DATA_AND_CONTENT_BASED";
};

/**
 * Per-muxing DRM row. The 16-byte content key is vault material (DRM_CENC
 * credential) — only public manifest metadata (kid/PSSH/laUrl/iv/uri) is
 * ever wizard input. ivSize is derived from encryptionMode (C9), never an
 * independent input.
 */
export type WizardDrmRow =
	| {
			kind: "CENC";
			/** DRM resource-key override (default `${muxingKey}-cenc`). */
			key?: string;
			/** Target muxing = rendition key (derived ladder key or extras.key). */
			muxingKey: string;
			credentialId: string;
			kid: string;
			/** Absent = API default CTR (the per-title drm samples omit it). */
			encryptionMode?: "CTR" | "CBC";
			widevinePssh?: string;
			playReadyLaUrl?: string;
			playReadyPssh?: string;
			fairPlayIv?: string;
			fairPlayUri?: string;
			/** Relative to base; absent = the muxing's derived default path. */
			path?: string;
			/** Editor-only copied destination ownership; never emitted into a plan. */
			autoPath?: string;
			name?: string;
	  }
	| {
			kind: "SPEKE";
			key?: string;
			muxingKey: string;
			credentialId: string;
			systemIds: string[];
			contentId?: string;
			kid?: string;
			iv?: string;
			path?: string;
			/** Editor-only copied destination ownership; never emitted into a plan. */
			autoPath?: string;
			name?: string;
	  }
	| {
			kind: "FAIRPLAY";
			/** DRM resource-key override (default `${muxingKey}-fairplay`). */
			key?: string;
			muxingKey: string;
			credentialId: string;
			iv: string;
			uri: string;
			path?: string;
			/** Editor-only copied destination ownership; never emitted into a plan. */
			autoPath?: string;
			name?: string;
	  };

export type WizardHlsVersion =
	| "HLS_V3"
	| "HLS_V4"
	| "HLS_V5"
	| "HLS_V6"
	| "HLS_V7"
	| "HLS_V8";

/**
 * JIT-only start-request placement (HLS/DASH; SMOOTH has no preview list in
 * the API): absent/"VOD" = today's vod* list, "PREVIEW" = watch-while-encoding
 * list, "VOD_AND_PREVIEW" = both. Only meaningful with JUST_IN_TIME timing —
 * the PLAN_PREVIEW_REQUIRES_JIT rail rejects preview placements otherwise.
 */
export type WizardJitPlacement = "VOD" | "PREVIEW" | "VOD_AND_PREVIEW";

export type WizardHlsOptions = {
	acl?: "PUBLIC_READ" | "PRIVATE" | null;
	omitMasterVersion?: boolean;
	omitMediaVersion?: boolean;
	masterVersion?: WizardHlsVersion;
	mediaVersion?: WizardHlsVersion;
	audioGroupId?: string;
	audioLanguage?: string;
	closedCaptions?: string;
	videoMuxingKind?: "FMP4" | "MP4" | "TS";
	audioMuxingKind?: "FMP4" | "MP4" | "TS";
	audioMediaUri?: string;
	perTitleVariantUri?: "AVG_BITRATE" | "CODEC_BITRATE";
	drmKind?: "CENC" | "FAIRPLAY" | "SPEKE";
	variantsPerAudioGroup?: boolean;
	iframePlaylists?: boolean;
	audioVariantStreams?: boolean;
	jitPlacement?: WizardJitPlacement;
};

export type WizardDashAdaptationSet = {
	key: string;
	type: "VIDEO" | "AUDIO";
	lang?: string;
	label?: string;
};

export type WizardDashOptions = {
	acl?: "PUBLIC_READ" | "PRIVATE" | null;
	audioLanguage?: string;
	representationType?: "TEMPLATE" | "TIMELINE";
	/** profile: ON_DEMAND (single-MP4 SegmentBase representations). */
	onDemand?: boolean;
	videoMuxingKind?: "FMP4" | "CMAF" | "WEBM";
	audioMuxingKind?: "FMP4" | "CMAF" | "WEBM";
	drmKind?: "CENC" | "SPEKE";
	adaptationSets?: WizardDashAdaptationSet[];
	jitPlacement?: WizardJitPlacement;
};

/**
 * Additional manifests beyond the primary HLS/DASH toggles — multiple
 * manifests of a kind are valid (the dash-segment-timeline sample builds
 * two DASH manifests) and SMOOTH only exists here.
 */
export type WizardExtraManifest =
	| {
			kind: "HLS";
			key: string;
			manifestName?: string;
			name?: string;
			hls?: WizardHlsOptions;
	  }
	| {
			kind: "DASH";
			key: string;
			manifestName?: string;
			name?: string;
			dash?: WizardDashOptions;
	  }
	| {
			kind: "SMOOTH";
			acl?: "PUBLIC_READ" | "PRIVATE" | null;
			key: string;
			serverManifestName?: string;
			clientManifestName?: string;
			name?: string;
			language?: string;
			drmKind?: "CENC";
	  };

export type WizardManifests = {
	hls: boolean;
	dash: boolean;
	hlsOptions?: WizardHlsOptions;
	dashOptions?: WizardDashOptions;
	extra?: WizardExtraManifest[];
};

/** Start-request per-title codec block (flat; nesting derived at build). */
export type WizardPerTitleCodec = {
	autoRepresentations?: boolean;
	adoptConfigurationThreshold?: number;
	targetQualityCrf?: number;
	targetQualityQp?: number;
	complexityFactor?: number;
	minBitrate?: number;
	maxBitrate?: number;
	minBitrateStepSize?: number;
	maxBitrateStepSize?: number;
	codecMinBitrateFactor?: number;
	codecMaxBitrateFactor?: number;
	codecBufsizeFactor?: number;
	forcedRenditionAboveHighestFixedRepresentation?: number;
	forcedRenditionAboveHighestFixedRepresentationFactor?: number;
	forcedRenditionAboveHighestFixedRepresentationCalculationMode?:
		| "LAST_CALCULATED_BITRATE"
		| "MINIMUM"
		| "MAXIMUM"
		| "AVERAGE";
};

export type WizardStartOptions = {
	encodingMode?:
		| "STANDARD"
		| "SINGLE_PASS"
		| "TWO_PASS"
		| "THREE_PASS"
		| "SMART_PASS";
	/**
	 * StartEncodingRequest.tweaks.audioVideoSyncMode — fails with Dolby
	 * Digital (Plus) / Atmos renditions (PLAN_TWEAKS_DOLBY_CONFLICT rail).
	 */
	audioVideoSyncMode?:
		| "STANDARD"
		| "RESYNC_AT_START"
		| "RESYNC_AT_START_AND_END";
	/** StartEncodingRequest.handleVariableInputFps (VFR drop/duplicate). */
	handleVariableInputFps?: boolean;
	perTitle?: {
		h264?: WizardPerTitleCodec;
		h265?: WizardPerTitleCodec;
		vp9?: WizardPerTitleCodec;
		av1?: WizardPerTitleCodec;
	};
	aiSceneAnalysis?: {
		filename: string;
		/** Asset-description destination path relative to base. */
		path: string;
		allSceneBoundaries?: { isEnabled: boolean; insertCueTags: boolean };
		schedule?: { position: number; maxDeviation: number; duration?: number }[];
		outputLanguageCodes?: string[];
	};
};

/**
 * Quality-control (VMAF + optional PSNR) toggle — the wizard mirror of
 * planQcSchema. Always present in state (the section's controls bind to it);
 * buildPlan emits a `plan.qc` block ONLY when `vmaf || psnr` and PRUNES it
 * entirely otherwise, so default-off state keeps the 56 goldens byte-identical
 * (none carry `qc`). `model` defaults to the schema default so an enabled-then-
 * default plan stays minimal. Like Per-Title/AISA, "off" leaves no plan key.
 */
export type WizardQc = {
	/** Automatic measurement execution, carried verbatim to the plan. */
	execution?: VmafExecution;
	measurementMethod?: "FRAME_INDEX_BT709_10BIT";
	/** Run the libvmaf VMAF pass after the encode FINISHES (adds qc/ MP4 mirrors). */
	vmaf: boolean;
	/** libvmaf model name (schema default `DEFAULT_VMAF_MODEL`). */
	model: string;
	/** Also compute PSNR (psnr_y) in the SAME libvmaf pass. */
	psnr: boolean;
	/**
	 * VMAF-only encode: produce ONLY the per-video qc mirror MP4s — no delivery
	 * muxings/manifests/audio/thumbnails/sprites/DRM/keyframes (planQcSchema.only).
	 * When on, buildPlan clears those plan collections so the plan passes
	 * validation, and the wizard disables the now-irrelevant delivery controls.
	 * Optional (absent ≡ false) so existing qc state/fixtures stay valid and a
	 * default-off plan never carries the key.
	 */
	only?: boolean;
	/**
	 * QC gate : carried VERBATIM as the plan's `qc.gate` —
	 * the editor produces exactly the schema shape, so the wizard state does
	 * not re-model it. Only meaningful while vmaf/psnr is on: buildPlan
	 * prunes the whole qc key when both are off, so a gate can never be
	 * emitted over a measurement that will not run (C29's first rail, held
	 * structurally here and loudly by the validator on import paths).
	 */
	gate?: QcGate;
};

export const DEFAULT_WIZARD_QC: WizardQc = {
	vmaf: false,
	model: DEFAULT_VMAF_MODEL,
	psnr: false,
};

/**
 * Kantar audio watermarking — the wizard mirror of `kantarWatermarkSchema`.
 *
 * An ENCODING-LEVEL SINGLETON: one config for the whole plan (the compiler
 * emits one `CREATE_KANTAR_WATERMARK` op per encoding, so a multi-encoding
 * ladder gets the same config on every sibling encoding). That is why it sits
 * on WizardState directly rather than per rendition like NexGuard.
 *
 * The service login (login + password) is vault-only under the KANTAR
 * credential provider — exactly like NexGuard's license — so the state and the
 * plan carry `credentialId` plus public job metadata and nothing else.
 *
 * Absent ⇒ buildPlan emits NO `kantar` key, so the existing goldens stay
 * byte-identical. Present-but-half-filled is emitted VERBATIM so the schema
 * rails it loudly in the preview (the `infrastructure` precedent) — silently
 * pruning a blank field would swallow the license id the user actually typed.
 */
export type WizardKantar = {
	/** Vault KANTAR credential (the login/password never enter a plan). */
	credentialId: string;
	/**
	 * Kantar license id (SDK: integer). Optional in STATE only so a blank input
	 * stays blank: buildPlan emits it verbatim and zod reports "expected number"
	 * rather than the form inventing a 0 the user never typed.
	 */
	licenseId?: number;
	channelName: string;
	contentReference: string;
	serverUrl: string;
	/** Report destination path, RELATIVE to the base output path (AISA precedent). */
	reportPath: string;
	/**
	 * Write the processing report with ACL PRIVATE instead of inheriting the
	 * output's public/private setting. Kantar's report is operational data, so
	 * it is routinely private under a PUBLIC_READ delivery output (the golden
	 * does exactly that) — a single global `output.publicRead` cannot express it.
	 * Absent/false ⇒ inherits the output ACL like every other destination.
	 */
	reportPrivate?: boolean;
};

export type WizardState = {
	/** Internal account-gated profile; never inferred from the selected account. */
	internal?: EncodingPlanInput["internal"];
	name: string;
	accountId: string;
	cloudRegion: string;
	encoderVersion: string;
	/**
	 * Encoding.labels — statistics grouping tags (bitmovin.labels). Optional
	 * and only emitted when non-empty so default plans (and the 56 goldens)
	 * stay byte-identical.
	 */
	labels?: string[];
	/**
	 * Encoding.infrastructure — Cloud Connect (BYOC) pinning
	 * (bitmovin.infrastructure). cloudRegion is the region INSIDE that
	 * infrastructure, independent of the top-level managed-cloud region.
	 */
	infrastructure?: { infrastructureId: string; cloudRegion: string };
	/**
	 * Per-plan prewarmed pool pinning (bitmovin.prewarmedEncoderPoolIds →
	 * the start request). : arrived only via account defaults
	 * (#15) until the wizard grew this control. Absent/empty emits NO key.
	 */
	prewarmedEncoderPoolIds?: string[];
	/**
	 * Every input OBJECT the job reads. inputFiles[0] is the primary "main"
	 * object the implicit video track reads. Files sharing a Bitmovin Input
	 * (kind+credential+bucket) carry the same `inputKey` and dedupe into one
	 * inputs[] entry at build time.
	 */
	inputFiles: WizardInputFile[];
	/**
	 * Input file the implicit AUDIO track reads, when it differs from the video
	 * object (separate-A/V). Absent = the audio reads the primary inputFiles[0].
	 */
	audioInputFile?: string;
	output: {
		credentialId: string;
		kind:
			| "S3"
			| "SFTP"
			| "AZURE"
			| "GENERIC_S3"
			| "GCS"
			| "GCS_SERVICE_ACCOUNT"
			//  — a credential-addressed output with no bucket, like
			// SFTP beside it.
			| "AKAMAI_NETSTORAGE";
		/** Location: S3/GenericS3/GCS bucket / Azure container (unused for SFTP). */
		bucket: string;
		region?: string;
		basePath: string;
		publicRead: boolean;
		/** Retain an imported explicit PRIVATE ACL while public read is disabled. */
		explicitPrivateAcl?: boolean;
		name: string;
	};
	/**
	 *  PR-b: delivery mirrors. Each row becomes a plan output
	 * (key mirror-N, the same convention "origin" follows) plus a
	 * deliveryMirrors entry; paths and acl ride the PRIMARY destination by
	 * the mirror semantics, so a row is only a credential + location.
	 */
	additionalOutputs: {
		region?: string;
		credentialId: string;
		kind:
			| "S3"
			| "SFTP"
			| "AZURE"
			| "GENERIC_S3"
			| "GCS"
			| "GCS_SERVICE_ACCOUNT"
			//  — a credential-addressed output with no bucket, like
			// SFTP beside it.
			| "AKAMAI_NETSTORAGE";
		bucket: string;
		name: string;
	}[];
	videos: WizardVideoRendition[];
	audios: WizardAudioRendition[];
	/** Maps to Condition(AUDIOSTREAMCOUNT > 0) on every audio rendition —
	 * skips audio outputs for silent sources (streamcondition fixtures). */
	audioGuard: boolean;
	manifests: WizardManifests;
	timing: "JUST_IN_TIME" | "POST_ENCODING";
	// P2 8b surface — all optional so default state stays P1-shaped.
	sources?: WizardSources;
	subtitles?: WizardSubtitle[];
	filters?: WizardFilter[];
	/** Editor-only ownership: manually named filter keys must not follow type changes. */
	manualFilterKeys?: string[];
	drm?: WizardDrmRow[];
	thumbnails?: WizardThumbnail[];
	sprites?: WizardSprite[];
	startOptions?: WizardStartOptions;
	/** VMAF/PSNR quality control (optional — absent/off ⇒ no plan.qc key). */
	qc?: WizardQc;
	/**
	 * Delivery-spec commitment . Carried through the wizard round
	 * trip so a committed plan stays FORM-representable: without this slot the
	 * `plansDeepEqual` gate rejected every delivery-carrying plan into the
	 * verbatim-import path, where the commitment could be neither seen nor
	 * removed (review-210 I2).
	 */
	delivery?: { specId: string; onDeviation?: "REFUSE" | "WARN" };
	/**
	 * Kantar audio watermarking (optional — absent ⇒ no plan.kantar key). One
	 * config per plan: the API resource is an encoding-level singleton.
	 */
	kantar?: WizardKantar;
};

/**
 *  PR-b / review-251 B4: the mirror credential-select guard,
 * extracted pure so its three branches are unit-testable — the only
 * genuinely conditional logic the inline mirrors UI added. Returns the
 * next rows, or null when the selection must be IGNORED (a provider with
 * no output mapping is never collapsed to S3 — the same rule the primary
 * output enforces).
 */
export function applyMirrorCredentialSelection(
	rows: WizardState["additionalOutputs"],
	index: number,
	credentialId: string,
	kind: WizardState["output"]["kind"] | null,
): WizardState["additionalOutputs"] | null {
	const current = rows[index];
	if (!current) {
		return null;
	}
	if (credentialId !== "" && kind === null) {
		return null;
	}
	const next = [...rows];
	next[index] = {
		...current,
		credentialId,
		...(kind !== null ? { kind } : {}),
	};
	return next;
}

export const DEFAULT_WIZARD_STATE: WizardState = {
	name: "",
	accountId: "",
	cloudRegion: "AUTO",
	encoderVersion: "STABLE",
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "",
			bucket: "",
			path: "",
			name: "S3 Input",
		},
	],
	output: {
		credentialId: "",
		kind: "S3",
		bucket: "",
		basePath: "",
		publicRead: true,
		name: "S3 Output",
	},
	additionalOutputs: [],
	videos: [{ height: 360, bitrate: 300_000 }],
	audios: [{ bitrate: 64_000, rate: 44_100 }],
	audioGuard: false,
	manifests: { hls: true, dash: false },
	timing: "JUST_IN_TIME",
};

/**
 * Sample-style keys (v360 / a64) with collision suffixes so multi-bitrate
 * same-height ladders stay representable: a second 1080p rendition becomes
 * v1080_8000k. Unique-height ladders keep fixture-identical keys; explicit
 * extras.key overrides win (Dolby multi-ladder fixtures name their own).
 */
/**
 * VMAF-only encode: no manifests, no thumbnails, no DRM — and no standalone
 * audio containers either. Hoisted so `wizardAudioLegs` and `buildPlan` cannot
 * disagree about which state means "qc only".
 */
function isQcOnly(state: Pick<WizardState, "qc">): boolean {
	return Boolean(state.qc?.only && (state.qc.vmaf || state.qc.psnr));
}

/** Audio keys a video container leg carries  — TS/MP4 only. */
function carriedAudioKeysOf(
	leg: WizardMuxing,
	audioKeySet: ReadonlySet<string>,
): string[] {
	const legKind = leg.kind ?? "FMP4";
	if (legKind !== "TS" && legKind !== "MP4") {
		return [];
	}
	return (leg.muxedAudioKeys ?? []).filter((key) => audioKeySet.has(key));
}

/** An audio container the plan will emit: which rendition, and which leg. */
export type WizardAudioLeg = {
	key: string;
	leg: WizardMuxing | undefined;
	/** The row's own muxing, as opposed to one of its `extraMuxings`. */
	primary: boolean;
};

/**
 * Every STANDALONE audio container the plan will emit, in emission order.
 *
 * ONE derivation with two readers: `buildPlan` maps it through `muxingFor` to
 * the plan's muxings, and `hlsDefaultVersion` maps it to leg KINDS. They have
 * to be the same list or the default version describes a plan that was never
 * built — an audio row set to ride inside a TS video container emits no
 * container of its own , and its nominal
 * fMP4 kind must not be read as "this manifest will carry an EXT-X-MAP".
 * `planToWizardState` produces exactly that shape on every muxed import.
 */
export function wizardAudioLegs(
	state: Pick<WizardState, "videos" | "audios" | "qc">,
): WizardAudioLeg[] {
	if (isQcOnly(state)) {
		// VMAF-only keeps ONLY video muxings (each carries its qc mirror's
		// destination); audio muxings are dropped with their renditions.
		return [];
	}
	const aKeys = audioKeys(state.audios);
	const audioKeySet = new Set(aKeys);
	const carriedSomewhere = new Set(
		state.videos.flatMap((video) =>
			[video.muxing, ...(video.extraMuxings ?? [])].flatMap((leg) =>
				leg ? carriedAudioKeysOf(leg, audioKeySet) : [],
			),
		),
	);
	// `false` is only honoured when something else IS carrying the track —
	// otherwise the choice would delete it from the delivery, and a working
	// delivery is the right answer to a choice that cannot be honoured.
	const wantsOwnContainer = (audioKey: string, leg: WizardMuxing): boolean =>
		leg.ownContainer !== false || !carriedSomewhere.has(audioKey);
	return state.audios.flatMap((audio, index) => {
		const key = aKeys[index] ?? `a${Math.round(audio.bitrate / 1000)}`;
		return [
			...(!audio.muxing || wantsOwnContainer(key, audio.muxing)
				? [{ key, leg: audio.muxing, primary: true }]
				: []),
			...(audio.extraMuxings ?? [])
				.filter((m) => wantsOwnContainer(key, m))
				.map((m) => ({ key, leg: m, primary: false })),
		];
	});
}

/**
 * The primary HLS manifest's default playlist version : V6 when
 * any leg it will enumerate is fMP4 — EXT-X-MAP is a version-6 feature per RFC
 * 8216 §7 — and V4 otherwise. ONE definition, read by `buildPlan` to emit and
 * by `planToWizardState` to know which explicit value is "just the default"
 * and may be dropped on import.
 *
 * The scan reads AUDIO legs as well as video ones (2026-08-29 paid re-audit
 * HIGH-4). The first cut asked `state.videos` only, so a plan with zero video
 * legs — an audio-only ladder, which the corpus has three of — could not
 * reach V6 at all: it defaulted to V4 while every media playlist it produced
 * carried EXT-X-MAP. The audit's explicit-V6 audio-only run passed, which is
 * what places the defect in the DEFAULT and not in the compiler. `mediaVersion`
 * is one value covering every child playlist the master lists, so the question
 * was never "is there fMP4 video" but "is there an fMP4 leg", and
 * `hlsVersionForLegs` is that question — the same one the validator's
 * `PLAN_HLS_FMP4_MEDIA_VERSION_BELOW_6` now asks.
 */
export function hlsDefaultVersion(
	state: Pick<WizardState, "videos" | "audios" | "qc">,
	options:
		| Pick<WizardHlsOptions, "videoMuxingKind" | "audioMuxingKind">
		| undefined,
): "HLS_V4" | "HLS_V6" {
	const kinds: string[] = [];
	for (const video of state.videos) {
		for (const leg of [video.muxing, ...(video.extraMuxings ?? [])]) {
			const kind = leg?.kind ?? "FMP4";
			if (hlsLegSelected(kind, options?.videoMuxingKind)) {
				kinds.push(kind);
			}
		}
	}
	for (const { leg } of wizardAudioLegs(state)) {
		const kind = leg?.kind ?? "FMP4";
		if (hlsLegSelected(kind, options?.audioMuxingKind)) {
			kinds.push(kind);
		}
	}
	return hlsVersionForLegs(kinds);
}

export function videoKeys(videos: WizardVideoRendition[]): string[] {
	const heightCounts = new Map<number, number>();
	// review-342 I2: height, then bitrate, then CODEC. A mixed-codec ladder
	// asking for the same rung in both codecs ("1080p at 5 Mbit in H264 and
	// H265") derived one key twice and was stopped by LIVE_DUPLICATE_KEY with
	// no hint of the cause; the live mixed-codec fixture had to dodge it.
	const pairCounts = new Map<string, number>();
	const kbps = (video: WizardVideoRendition) =>
		Math.round((video.bitrate ?? 0) / 1000);
	for (const video of videos) {
		if (video.extras?.key !== undefined || video.height === null) {
			continue;
		}
		heightCounts.set(video.height, (heightCounts.get(video.height) ?? 0) + 1);
		const pair = `${video.height}:${kbps(video)}`;
		pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
	}
	return videos.map((video, index) => {
		if (video.extras?.key !== undefined) {
			return video.extras.key;
		}
		if (video.height === null) {
			// Per-title templates without a pinned height have no natural key.
			return `video${index + 1}`;
		}
		if ((heightCounts.get(video.height) ?? 0) <= 1) {
			return `v${video.height}`;
		}
		const base = `v${video.height}_${kbps(video)}k`;
		return (pairCounts.get(`${video.height}:${kbps(video)}`) ?? 0) > 1
			? `${base}_${(video.codec ?? "H264").toLowerCase()}`
			: base;
	});
}

export function audioKeys(audios: WizardAudioRendition[]): string[] {
	const kbpsCounts = new Map<number, number>();
	const kbps = (a: WizardAudioRendition) => Math.round(a.bitrate / 1000);
	for (const audio of audios) {
		if (audio.extras?.key !== undefined) {
			continue;
		}
		kbpsCounts.set(kbps(audio), (kbpsCounts.get(kbps(audio)) ?? 0) + 1);
	}
	return audios.map(
		(audio) =>
			audio.extras?.key ??
			((kbpsCounts.get(kbps(audio)) ?? 0) > 1
				? `a${kbps(audio)}_${audio.rate}`
				: `a${kbps(audio)}`),
	);
}

export function subtitleKeys(subtitles: WizardSubtitle[]): string[] {
	return subtitles.map(
		(subtitle, index) =>
			subtitle.extras?.key ??
			(subtitles.length > 1 ? `vtt${index + 1}` : "vtt"),
	);
}

function basePath(state: WizardState): string {
	const raw = state.output.basePath;
	return raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * Derived default destination paths (relative to base) — also the DRM-leg
 * defaults: the drm samples write the encrypted output where the plain
 * muxing would have gone. Explicit extras.key rows skip the legacy suffix
 * slicing (their keys aren't v{height}-shaped). Shared with the Muxings
 * step so the placeholder shown is exactly what buildPlan derives.
 */
export function videoMuxingRelPath(
	video: WizardVideoRendition,
	key: string,
): string {
	if (video.extras?.mode?.startsWith("PER_TITLE_TEMPLATE")) {
		return `video/${key}/{height}p_{bitrate}_{uuid}`;
	}
	if (video.height === null) {
		return `video/${key}`;
	}
	if (video.extras?.key !== undefined || key === `v${video.height}`) {
		return `video/${video.height}p`;
	}
	return `video/${key.slice(1)}`;
}

export function audioMuxingRelPath(
	audio: WizardAudioRendition,
	key: string,
): string {
	if (
		audio.extras?.key !== undefined ||
		key === `a${Math.round(audio.bitrate / 1000)}`
	) {
		return `audio/${audio.bitrate}`;
	}
	return `audio/${key.slice(1)}`;
}

type RenditionInput = EncodingPlanInput["renditions"][number];
type MuxingInput = EncodingPlanInput["muxings"][number];
type ManifestInput = NonNullable<EncodingPlanInput["manifests"]>[number];
type DrmInput = NonNullable<EncodingPlanInput["drm"]>[number];
type IngestInput = NonNullable<EncodingPlanInput["ingest"]>[number];

/**
 * Drops undefined-valued keys so unset optional form fields emit nothing
 * (schema defaults fill at parse; plans stay sample-minimal). Explicit
 * nulls survive — per-title bitrate/rate null is meaningful.
 */
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
	return value === "" ? undefined : value;
}

function pruneColorConfig(
	colorConfig: WizardColorConfig | undefined,
): WizardColorConfig | undefined {
	if (!colorConfig) {
		return undefined;
	}
	const pruned = prune(colorConfig);
	return Object.keys(pruned).length > 0 ? pruned : undefined;
}

/** Shared rendition fields sourced from "Placement & extras". */
function extrasFields(extras: WizardRenditionExtras | undefined) {
	return prune({
		streamName: str(extras?.streamName),
		encodingKey: str(extras?.encodingKey),
		hlsVariantLabel: str(extras?.hlsVariantLabel),
		dashSetKey: str(extras?.dashSetKey),
		hlsMedia: extras?.hlsMedia ? prune(extras.hlsMedia) : undefined,
		nexguard: extras?.nexguard
			? prune({
					credentialId: extras.nexguard.credentialId,
					watermarkType: extras.nexguard.watermarkType,
					preset: extras.nexguard.preset,
					strength: extras.nexguard.strength,
				})
			: undefined,
		filters: extras?.filters?.length ? extras.filters : undefined,
	});
}

/** Video-only: per-title fixed-resolution settings (audio schemas reject it). */
function perTitleSettingsField(extras: WizardRenditionExtras | undefined) {
	return extras?.perTitleSettings ? prune(extras.perTitleSettings) : undefined;
}

function buildPerTitleCodec(
	codec: "h264" | "h265" | "vp9" | "av1",
	options: WizardPerTitleCodec | undefined,
) {
	if (!options) {
		return undefined;
	}
	const fixed = prune({
		forcedRenditionAboveHighestFixedRepresentation:
			options.forcedRenditionAboveHighestFixedRepresentation,
		forcedRenditionAboveHighestFixedRepresentationFactor:
			options.forcedRenditionAboveHighestFixedRepresentationFactor,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			options.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
	});
	return prune({
		minBitrate: options.minBitrate,
		maxBitrate: options.maxBitrate,
		targetQualityCrf: options.targetQualityCrf,
		targetQualityQp: options.targetQualityQp,
		minBitrateStepSize: options.minBitrateStepSize,
		maxBitrateStepSize: options.maxBitrateStepSize,
		complexityFactor: options.complexityFactor,
		autoRepresentations: options.autoRepresentations
			? prune({
					adoptConfigurationThreshold: options.adoptConfigurationThreshold,
				})
			: undefined,
		fixedResolutionAndBitrateConfiguration:
			Object.keys(fixed).length > 0 ? fixed : undefined,
		// VP9/AV1 PerTitleConfiguration has no codec bitrate/bufsize factors.
		...(codec === "vp9" || codec === "av1"
			? {}
			: {
					codecMinBitrateFactor: options.codecMinBitrateFactor,
					codecMaxBitrateFactor: options.codecMaxBitrateFactor,
					codecBufsizeFactor: options.codecBufsizeFactor,
				}),
	});
}

export class WizardCodecError extends Error {
	constructor() {
		super(
			"HEVCv2 requires a HEVCv2-only ladder and BCF override. Select HEVCv2 for every video rung and BCF override in Basics.",
		);
	}
}
export function hasInvalidHevcV2Ladder(state: WizardState): boolean {
	if (
		state.videos.some(
			(video) =>
				video.codec !== "H265V2" &&
				video.codec !== "H265" &&
				(video.h265?.motionCompensatedTemporalFiltering !== undefined ||
					video.h265?.rateControlModeConfig !== undefined),
		)
	)
		return true;
	const hasV2 = state.videos.some((video) => video.codec === "H265V2");
	return hasV2
		? !state.internal?.hevcV2 ||
				state.videos.some((video) => video.codec !== "H265V2")
		: !!state.internal;
}
export function wizardUsesCodecEncodingMode(
	state: Pick<WizardState, "videos" | "internal">,
): boolean {
	return (
		!!state.internal?.hevcV2 ||
		state.videos.some((video) => {
			if (video.encodingMode || video.codec === "H265V2") return true;
			switch (video.codec ?? "H264") {
				case "H264":
					return (
						video.h264?.presetConfiguration === undefined ||
						!!video.h264.presetConfiguration
					);
				case "H265":
					return !!video.h265?.presetConfiguration;
				case "AV1":
					return !!video.av1?.presetConfiguration;
				default:
					return false;
			}
		})
	);
}
export function buildPlan(state: WizardState): EncodingPlanInput {
	if (hasInvalidHevcV2Ladder(state)) throw new WizardCodecError();
	const hevcV2 = state.videos.some((video) => video.codec === "H265V2");
	const internal = hevcV2 ? state.internal : undefined;
	const base = basePath(state);
	const vKeys = videoKeys(state.videos);
	const aKeys = audioKeys(state.audios);
	const subtitles = state.subtitles ?? [];
	const sKeys = subtitleKeys(subtitles);
	const drmRows = state.drm ?? [];
	const sources = state.sources ?? {};
	// VMAF-only encode: when on, the plan must carry NO manifests/thumbnails/
	// sprites/drm/keyframes (validate rejects them and the compiler drops them).
	// The user still picks the storage output + the per-rendition muxings stay —
	// they carry each qc mirror's destination. qcOnly is only meaningful when a
	// metric is actually requested (vmaf or psnr); otherwise the qc block is
	// pruned entirely below and this stays false so default plans are untouched.
	const qcOnly = isQcOnly(state);
	// Input files (objects). A stream references one by key; its Bitmovin input
	// id + object path come from the file. The implicit video reads inputFiles[0].
	const fileByKey = new Map(state.inputFiles.map((f) => [f.key, f]));
	const primaryFile = state.inputFiles[0];
	const ref = (key: string) => {
		const f = fileByKey.get(key) ?? primaryFile;
		return { inputKey: f?.inputKey ?? "main", inputPath: f?.path ?? "" };
	};
	// Bitmovin inputs[] = input files deduped by their shared inputKey.
	const inputDecls = (): EncodingPlanInput["inputs"] => {
		const seen = new Set<string>();
		const decls: EncodingPlanInput["inputs"] = [];
		for (const f of state.inputFiles) {
			if (seen.has(f.inputKey)) {
				continue;
			}
			seen.add(f.inputKey);
			if (f.kind === "HTTPS") {
				decls.push({
					key: f.inputKey,
					kind: "HTTPS" as const,
					host: f.bucket,
					name: f.name,
				});
			} else if (f.kind === "AZURE") {
				decls.push(
					prune({
						key: f.inputKey,
						kind: "AZURE" as const,
						credentialId: f.credentialId,
						container: f.bucket,
						name: str(f.name),
					}),
				);
			} else if (f.kind === "AKAMAI_NETSTORAGE") {
				// . No bucket: the upload account IS the container,
				// and `planInputSchema` is strict, so falling into the
				// bucket-carrying branch below emitted a field the schema
				// rejects — which is how the wizard-path corpus check found
				// this, by reporting the fixture as un-authorable by the form.
				decls.push(
					prune({
						key: f.inputKey,
						kind: "AKAMAI_NETSTORAGE" as const,
						credentialId: f.credentialId,
						name: str(f.name),
					}),
				);
			} else {
				// S3 / GENERIC_S3 / GCS / GCS_SERVICE_ACCOUNT — all bucket+credential.
				decls.push(
					prune({
						key: f.inputKey,
						kind: f.kind,
						credentialId: f.credentialId,
						bucket: f.bucket,
						...((f.kind === "GCS" || f.kind === "GCS_SERVICE_ACCOUNT") &&
						str(f.region)
							? { region: str(f.region) }
							: {}),
						name: str(f.name),
					}),
				);
			}
		}
		return decls;
	};
	// The single origin output. SFTP has no bucket; Azure uses `container`;
	// S3 / GENERIC_S3 (Akamai/OCI/GenericS3) / GCS (HMAC) / GCS_SERVICE_ACCOUNT
	// all use `bucket` + credential; GCS also accepts an optional region.
	const outputDeclFor = (
		key: string,
		out: {
			credentialId: string;
			kind: WizardState["output"]["kind"];
			region?: string;
			bucket: string;
			name: string;
		},
	): EncodingPlanInput["outputs"][number] => {
		if (out.kind === "SFTP") {
			return {
				key,
				kind: "SFTP" as const,
				credentialId: out.credentialId,
				name: out.name,
			};
		}
		if (out.kind === "AKAMAI_NETSTORAGE") {
			//  — credential only, like SFTP above. The bucket-
			// carrying fall-through below would emit a field `planOutputSchema`
			// rejects.
			return {
				key,
				kind: "AKAMAI_NETSTORAGE" as const,
				credentialId: out.credentialId,
				name: out.name,
			};
		}
		if (out.kind === "AZURE") {
			return {
				key,
				kind: "AZURE" as const,
				credentialId: out.credentialId,
				container: out.bucket,
				name: out.name,
			};
		}
		return {
			key,
			kind: out.kind,
			credentialId: out.credentialId,
			bucket: out.bucket,
			...((out.kind === "GCS" || out.kind === "GCS_SERVICE_ACCOUNT") &&
			str(out.region)
				? { region: str(out.region) }
				: {}),
			name: out.name,
		};
	};
	const outputDecls = (): EncodingPlanInput["outputs"] => [
		outputDeclFor("origin", state.output),
		//  PR-b: mirror declarations, keyed by position — the
		// inverse mapper demands the same convention so round-trips hold.
		...state.additionalOutputs.map((mirror, index) =>
			outputDeclFor(`mirror-${index + 1}`, mirror),
		),
	];
	const acl = state.output.publicRead
		? ("PUBLIC_READ" as const)
		: state.output.explicitPrivateAcl
			? ("PRIVATE" as const)
			: undefined;
	const destination = (
		path: string,
		override?: "PUBLIC_READ" | "PRIVATE" | null,
	) => ({
		outputKey: "origin",
		path,
		...((override === null ? undefined : (override ?? acl))
			? { acl: override ?? acl }
			: {}),
	});

	const relPathByKey = new Map<string, string>();
	state.videos.forEach((video, index) => {
		const key = vKeys[index] ?? `v${video.height}`;
		relPathByKey.set(key, videoMuxingRelPath(video, key));
	});
	state.audios.forEach((audio, index) => {
		const key = aKeys[index] ?? `a${Math.round(audio.bitrate / 1000)}`;
		relPathByKey.set(key, audioMuxingRelPath(audio, key));
	});
	subtitles.forEach((_, index) => {
		const key = sKeys[index] ?? "vtt";
		relPathByKey.set(key, `subtitles/${key}`);
	});

	// Implicit video/audio tracks are emitted only while a rendition uses
	// them — audio-only Dolby plans have ingest: [] and the AI-scene sample
	// has no audio track at all.
	const usesImplicit = (
		extras: WizardRenditionExtras | undefined,
		implicitKey: "video" | "audio",
	) => extras?.source === undefined || extras.source === implicitKey;
	// A trimming/concatenation stream may wrap the implicit video/audio ingest by
	// sourceKey even when no rendition reads that ingest directly — the underlying
	// ingest stream must still be emitted for the wrapper to resolve.
	const wrappedSourceKeys = new Set<string>([
		...(sources.audioMixStreams ?? []).flatMap((s) =>
			s.audioMixChannels.map((c) => c.sourceKey),
		),
		...(sources.trimmingStreams ?? []).map((t) => t.sourceKey),
		...(sources.concatenationStreams ?? []).flatMap((c) =>
			c.sources.map((s) => s.sourceKey),
		),
	]);
	const useVideoIngest =
		state.videos.some((v) => usesImplicit(v.extras, "video")) ||
		wrappedSourceKeys.has("video");
	const useAudioIngest =
		state.audios.some((a) => usesImplicit(a.extras, "audio")) ||
		wrappedSourceKeys.has("audio");
	// Separate A/V: the implicit audio may read a different input file than the
	// video; absent audioInputFile = the same primary object.
	const audioRef = ref(state.audioInputFile ?? primaryFile?.key ?? "");
	const ingest: IngestInput[] = [
		...(useVideoIngest && primaryFile
			? [
					prune({
						key: "video",
						inputKey: primaryFile.inputKey,
						inputPath: primaryFile.path,
						selectionMode: "VIDEO_RELATIVE" as const,
						position: 0,
						encodingKey: str(sources.implicitEncodingKeys?.video),
					}),
				]
			: []),
		...(useAudioIngest
			? [
					prune({
						key: "audio",
						inputKey: audioRef.inputKey,
						inputPath: audioRef.inputPath,
						selectionMode: "AUDIO_RELATIVE" as const,
						position: 0,
						encodingKey: str(sources.implicitEncodingKeys?.audio),
					}),
				]
			: []),
		...(sources.tracks ?? []).map((track) => {
			const t = ref(track.inputFile);
			return prune({
				key: track.key,
				inputKey: t.inputKey,
				inputPath: t.inputPath,
				selectionMode: track.selectionMode,
				position: track.position,
				encodingKey: str(track.encodingKey),
			});
		}),
	];

	const videoRendition = (
		video: WizardVideoRendition,
		key: string,
	): RenditionInput => {
		const codec = video.codec ?? "H264";
		// Imported/stale wizard state must not leak a fixed bitrate into a template.
		const bitrate = video.extras?.mode?.startsWith("PER_TITLE")
			? null
			: video.bitrate;
		const shared = {
			key,
			width: video.width,
			ingestKey: video.extras?.source ?? "video",
			...(hevcV2
				? { encodingMode: "SMART_PASS" as const }
				: video.encodingMode
					? { encodingMode: video.encodingMode }
					: {}),
			...extrasFields(video.extras),
			...(video.extras?.burnInSrt
				? {
						burnInSrt: {
							// Missing references fail closed instead of falling back to the primary video.
							inputKey:
								fileByKey.get(video.extras.burnInSrt.inputFile)?.inputKey ?? "",
							inputPath:
								fileByKey.get(video.extras.burnInSrt.inputFile)?.path ?? "",
							characterEncoding: video.extras.burnInSrt.characterEncoding,
						},
					}
				: {}),
		};
		if (codec === "H265" || codec === "H265V2") {
			const o = video.h265 ?? {};
			return prune({
				...shared,
				codec: "H265" as const,
				name: str(video.extras?.name),
				height: video.height,
				bitrate,
				mode: video.extras?.mode,
				profile: o.profile,
				level: str(o.level),
				presetConfiguration: hevcV2
					? "VOD_HIGH_QUALITY"
					: str(o.presetConfiguration),
				rate: o.rate,
				motionCompensatedTemporalFiltering:
					o.motionCompensatedTemporalFiltering,
				rateControlModeConfig: o.rateControlModeConfig,
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
				colorConfig: pruneColorConfig(o.colorConfig),
				perTitleSettings: perTitleSettingsField(video.extras),
				dolbyVisionMetadata: o.dolbyVisionMetadata
					? prune({
							profile: o.dolbyVisionMetadata.profile,
							metadataSource: o.dolbyVisionMetadata.metadataSource,
							metadataStreamKey: str(o.dolbyVisionMetadata.metadataStreamKey),
						})
					: undefined,
			});
		}
		if (codec === "VP9") {
			const o = video.vp9 ?? {};
			return prune({
				...shared,
				codec: "VP9" as const,
				name: str(video.extras?.name),
				height: video.height,
				bitrate,
				mode: video.extras?.mode,
				rate: o.rate,
				cpuUsed: o.cpuUsed,
				tileColumns: o.tileColumns,
				qpMin: o.qpMin,
				qpMax: o.qpMax,
				rateUndershootPct: o.rateUndershootPct,
				rateOvershootPct: o.rateOvershootPct,
				quality: str(o.quality),
				lossless: o.lossless,
				aqMode: str(o.aqMode),
				arnrType: str(o.arnrType),
				arnrMaxFrames: o.arnrMaxFrames,
				arnrStrength: o.arnrStrength,
				colorConfig: pruneColorConfig(o.colorConfig),
				perTitleSettings: perTitleSettingsField(video.extras),
			});
		}
		if (codec === "AV1") {
			const o = video.av1 ?? {};
			return prune({
				...shared,
				codec: "AV1" as const,
				name: str(video.extras?.name),
				height: video.height,
				bitrate,
				mode: video.extras?.mode,
				rate: o.rate,
				presetConfiguration: o.presetConfiguration,
				autoLevelSetup: o.autoLevelSetup,
				dynamicRangeFormat: o.dynamicRangeFormat,
				colorConfig: pruneColorConfig(o.colorConfig),
				perTitleSettings: perTitleSettingsField(video.extras),
			});
		}
		const o = video.h264 ?? {};
		return prune({
			...shared,
			codec: "H264" as const,
			name: str(video.extras?.name),
			height: video.height,
			bitrate,
			level: o.level ?? null,
			// undefined → the VOD default; explicit null → leave to per-title.
			presetConfiguration:
				o.presetConfiguration === undefined
					? "VOD_HIGH_QUALITY"
					: o.presetConfiguration,
			mode: video.extras?.mode ?? ("STANDARD" as const),
			profile: o.profile,
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
			colorConfig: pruneColorConfig(o.colorConfig),
			perTitleSettings: perTitleSettingsField(video.extras),
		});
	};

	const audioRendition = (
		audio: WizardAudioRendition,
		key: string,
	): RenditionInput => {
		const codec = audio.codec ?? "AAC";
		const shared = {
			key,
			ingestKey: audio.extras?.source ?? "audio",
			name: str(audio.extras?.name),
			...extrasFields(audio.extras),
			...(state.audioGuard
				? {
						conditions: {
							attribute: "AUDIOSTREAMCOUNT",
							operator: "GREATER_THAN" as const,
							value: "0",
						},
					}
				: {}),
		};
		if (codec === "DOLBY_ATMOS") {
			return prune({
				...shared,
				codec: "DOLBY_ATMOS" as const,
				bitrate: audio.bitrate,
				rate: audio.rate,
				loudnessControl: audio.loudness ? prune(audio.loudness) : undefined,
			});
		}
		if (codec === "DDPLUS" || codec === "DD") {
			return prune({
				...shared,
				codec,
				bitrate: audio.bitrate,
				rate: audio.rate,
				channelLayout: str(audio.channelLayout),
			});
		}
		if (codec === "OPUS")
			return prune({
				...shared,
				codec: "OPUS" as const,
				bitrate: audio.bitrate,
				rate: audio.rate,
				channelLayout: (audio.channelLayout ??
					"CL_STEREO") as typeof import("../plan/schema").OPUS_CHANNEL_LAYOUTS[number],
			});
		return prune({
			...shared,
			codec: "AAC" as const,
			bitrate: audio.bitrate,
			rate: audio.rate,
			channelLayout: audio.channelLayout ?? "CL_STEREO",
		});
	};

	const subtitleRendition = (
		subtitle: WizardSubtitle,
		key: string,
	): RenditionInput =>
		prune({
			key,
			codec: subtitle.codec ?? "WEBVTT",
			ingestKey: subtitle.source,
			label: str(subtitle.label),
			language: str(subtitle.language),
			...(subtitle.codec === "IMSC"
				? { styling: subtitle.styling }
				: { groupId: str(subtitle.groupId), uri: str(subtitle.uri) }),
			...extrasFields(subtitle.extras),
		});

	/**
	 * Every container kind the VIDEO ladder actually builds.
	 *
	 * The carrier is chosen by matching kinds, so "the audio row says TS+muxed"
	 * is only half the question — the other half is whether a video TS leg
	 * EXISTS to carry it. Review found the missing half: with both selects at
	 * their fMP4 default and only the audio switched to TS, the track was
	 * skipped here AND had no carrier, so it vanished from the plan entirely.
	 * The encode is billed and delivers silent video, past a warning.
	 *
	 * That is the same shape as the fMP4-flag bug I had just fixed, on the
	 * other axis: I checked the leg's own kind and never checked the pair. The
	 * UI funnels operators straight into it, because the placement control
	 * appears as soon as the AUDIO row is TS while both selects default to fMP4.
	 */
	/**
	 * Which audio renditions ride inside which containers — resolved once.
	 *
	 * The relation lives on the CARRIER (`muxedAudioKeys` on a video leg), so
	 * there is nothing to derive: this only turns the operator's rendition
	 * INDEX choices into the plan's rendition KEYS, and answers the one
	 * question the audio side still has — is anything carrying me?
	 *
	 * Replaces a per-kind broadcast map. That map could only say "this track
	 * goes into every video container of its kind", which cannot express
	 * videoA←audioA, videoB←audioB, videoC←audioA, videoD←nothing. The owner
	 * rejected it on exactly that case.
	 */
	const audioKeySet = new Set(aKeys);
	/**
	 * What this leg will ACTUALLY carry — the same two conditions `muxingFor`
	 * applies when it writes `additionalStreamKeys`.
	 *
	 * The kind check is load-bearing, and my own first cut of this rewrite got
	 * it wrong exactly as the original bug did: an fMP4 leg with an assignment
	 * counted as a carrier here while `muxingFor` silently dropped it, so the
	 * track was skipped on the audio side AND absent on the video side. Gone
	 * from the delivery. The skip and the pickup have to read the same rule, or
	 * the gap between them is where a track falls through — which is C1's
	 * lesson arriving in a model built to replace C1's.
	 */
	const carriedAudioKeys = (leg: WizardMuxing): string[] =>
		carriedAudioKeysOf(leg, audioKeySet);
	/**
	 * Which audio containers this plan emits — module scope, because
	 * `hlsDefaultVersion` has to read the SAME list (see `wizardAudioLegs`).
	 * "Does this audio rendition get a container of its own?" is decided
	 * there: default yes, and `ownContainer: false` is honoured only when
	 * something else IS carrying the track .
	 */
	const audioLegs = wizardAudioLegs(state);

	/**
	 * Audio renditions that ride inside a video container, by container KIND.
	 *
	 * The operator makes this choice on the audio row ("own container, or
	 * inside the video's?") and picks the container kind there too. That kind
	 * is what pairs the two sides: an audio row set to TS+muxed joins the TS
	 * legs, and leaves any fMP4 leg of the same ladder demuxed — which is the
	 * real shape of a plan serving muxed HLS beside CMAF DASH from one encode.
	 */

	const muxingFor = (
		key: string,
		defaultKind: WizardMuxingKind,
		muxing: WizardMuxing | undefined,
		legacyFmp4: boolean,
		/**
		 * Audio renditions muxed INTO this container . Only TS and
		 * MP4 accept them — the plan schema carries the field on those two only,
		 * so passing it anywhere else could not compile even if this builder
		 * tried. Empty is normalised to absent because the schema refuses an
		 * empty list: there is no half-muxed container.
		 */
		muxedIn?: readonly string[],
	): MuxingInput => {
		const m = muxing ?? {};
		const kind = m.kind ?? defaultKind;
		// Muxing resource key defaults to the stream key; a sample may name it
		// apart (e.g. "atmos448-mux") while the streamKey stays the rendition key.
		const muxKey = m.key ?? key;
		// DRM legs own the encrypted output — their muxing carries none
		// (the drm samples omit muxing destinations). Explicit paths win.
		// Keyed on THIS leg's muxing key so a per-leg DRM row (only one of a
		// stream's legs encrypted) is evaluated independently.
		const drmOwned = drmRows.some((row) => row.muxingKey === muxKey);
		const derived = relPathByKey.get(key) ?? "";
		const dest =
			m.path !== undefined
				? destination(`${base}${m.path}`, m.acl)
				: drmOwned
					? undefined
					: destination(`${base}${derived}`, m.acl);
		const name = str(m.name);
		if (kind === "MP4") {
			return prune({
				key: muxKey,
				kind: "MP4" as const,
				streamKey: key,
				additionalStreamKeys:
					muxedIn && muxedIn.length > 0 ? [...muxedIn] : undefined,
				filename: m.filename ?? "",
				fragmentDuration: m.fragmentDuration,
				manifestType: m.manifestType,
				dolbyVisionConfiguration: m.dolbyVisionTrackSampleEntryName
					? { trackSampleEntryName: m.dolbyVisionTrackSampleEntryName }
					: undefined,
				destination: dest,
				name,
			});
		}
		if (kind === "TS") {
			return prune({
				key: muxKey,
				kind: "TS" as const,
				streamKey: key,
				additionalStreamKeys:
					muxedIn && muxedIn.length > 0 ? [...muxedIn] : undefined,
				segmentLength: m.segmentLength,
				segmentNaming: str(m.segmentNaming),
				segmentNamingTemplate: str(m.segmentNamingTemplate),
				destination: dest,
				name,
			});
		}
		if (kind === "WEBM") {
			return prune({
				key: muxKey,
				kind: "WEBM" as const,
				streamKey: key,
				segmentLength: m.segmentLength,
				segmentNaming: str(m.segmentNaming),
				initSegmentName: str(m.initSegmentName),
				destination: dest,
				name,
			});
		}
		if (kind === "TEXT") {
			return prune({
				key: muxKey,
				kind: "TEXT" as const,
				streamKey: key,
				filename: m.filename ?? "subtitles.ttml",
				destination: dest ?? destination(`${base}${derived}`, m.acl),
				name,
			});
		}
		if (kind === "CHUNKED_TEXT") {
			return prune({
				key: muxKey,
				kind: "CHUNKED_TEXT" as const,
				streamKey: key,
				segmentLength: m.segmentLength,
				segmentNaming: str(m.segmentNaming),
				// destination is required on chunked text — never DRM-owned.
				destination: dest ?? destination(`${base}${derived}`, m.acl),
				name,
			});
		}
		if (kind === "CMAF") {
			return prune({
				key: muxKey,
				kind: "CMAF" as const,
				streamKey: key,
				segmentLength: m.segmentLength,
				segmentNaming: str(m.segmentNaming),
				segmentNamingTemplate: str(m.segmentNamingTemplate),
				initSegmentName: str(m.initSegmentName),
				initSegmentNameTemplate: str(m.initSegmentNameTemplate),
				framesPerCmafChunk: m.framesPerCmafChunk,
				destination: dest,
				name,
			});
		}
		if (legacyFmp4) {
			// P1 emission shape: defaults written out (byte-pinned fixtures).
			return prune({
				key: muxKey,
				kind: "FMP4" as const,
				streamKey: key,
				segmentLength: m.segmentLength ?? 6,
				segmentNaming: m.segmentNaming ?? "segment_%number%.m4s",
				segmentNamingTemplate: str(m.segmentNamingTemplate),
				initSegmentName: m.initSegmentName ?? "init.mp4",
				destination: dest,
				name,
			});
		}
		return prune({
			key: muxKey,
			kind: "FMP4" as const,
			streamKey: key,
			segmentLength: m.segmentLength,
			segmentNaming: str(m.segmentNaming),
			segmentNamingTemplate: str(m.segmentNamingTemplate),
			initSegmentName: str(m.initSegmentName),
			destination: dest,
			name,
		});
	};

	const drm: DrmInput[] = drmRows.map((row) => {
		const dest = destination(
			`${base}${row.path ?? relPathByKey.get(row.muxingKey) ?? ""}`,
		);
		if (row.kind === "SPEKE")
			return prune({
				key: row.key ?? `${row.muxingKey}-speke`,
				kind: "SPEKE" as const,
				muxingKey: row.muxingKey,
				credentialId: row.credentialId,
				systemIds: row.systemIds,
				contentId: str(row.contentId),
				kid: str(row.kid),
				iv: str(row.iv),
				destination: dest,
				name: str(row.name),
			});
		if (row.kind === "FAIRPLAY") {
			return prune({
				key: row.key ?? `${row.muxingKey}-fairplay`,
				kind: "FAIRPLAY" as const,
				muxingKey: row.muxingKey,
				credentialId: row.credentialId,
				iv: row.iv,
				uri: row.uri,
				destination: dest,
				name: str(row.name),
			});
		}
		const playReady = prune({
			laUrl: str(row.playReadyLaUrl),
			pssh: str(row.playReadyPssh),
		});
		const widevinePssh = str(row.widevinePssh);
		return prune({
			key: row.key ?? `${row.muxingKey}-cenc`,
			kind: "CENC" as const,
			muxingKey: row.muxingKey,
			credentialId: row.credentialId,
			kid: row.kid,
			encryptionMode: row.encryptionMode,
			// C9 pairing is derived, never an input: CTR (and the API default
			// when omitted) → 8-byte IV; CBC → 16-byte IV.
			ivSize:
				row.encryptionMode === "CBC"
					? ("IV_16_BYTES" as const)
					: ("IV_8_BYTES" as const),
			widevine: widevinePssh ? { pssh: widevinePssh } : undefined,
			playReady: Object.keys(playReady).length > 0 ? playReady : undefined,
			fairPlay:
				str(row.fairPlayIv) || str(row.fairPlayUri)
					? { iv: row.fairPlayIv ?? "", uri: row.fairPlayUri ?? "" }
					: undefined,
			destination: dest,
			name: str(row.name),
		});
	});

	const hlsManifest = (
		key: string,
		manifestName: string | undefined,
		name: string | undefined,
		options: WizardHlsOptions | undefined,
		primary: boolean,
	): ManifestInput => {
		const o = options ?? {};
		return prune({
			key,
			kind: "HLS" as const,
			// Primary keeps the P1 literal emission; extra rows stay minimal
			// and let schema defaults fill.
			manifestName: primary ? "stream.m3u8" : str(manifestName),
			name: primary ? "HLS Manifest" : str(name),
			destination: destination(base, o.acl),
			// V6 when the manifest's video legs are fMP4 (EXT-X-MAP needs it,
			// RFC 8216 §7), V4 for a
			// TS/MP4 leg, which is what the vendor samples do. The importer
			// drops exactly this derived default on read-back so a fixture
			// round-trips whichever way it was written.
			masterVersion:
				primary && !o.omitMasterVersion
					? (o.masterVersion ?? hlsDefaultVersion(state, o))
					: o.masterVersion,
			mediaVersion:
				primary && !o.omitMediaVersion
					? (o.mediaVersion ?? hlsDefaultVersion(state, o))
					: o.mediaVersion,
			audioGroupId: primary ? (o.audioGroupId ?? "audio") : str(o.audioGroupId),
			audioLanguage: primary ? (o.audioLanguage ?? "en") : str(o.audioLanguage),
			closedCaptions: primary
				? (o.closedCaptions ?? "NONE")
				: str(o.closedCaptions),
			videoMuxingKind: o.videoMuxingKind,
			audioMuxingKind: o.audioMuxingKind,
			audioMediaUri: str(o.audioMediaUri),
			perTitleVariantUri: o.perTitleVariantUri,
			drmKind: o.drmKind,
			variantsPerAudioGroup: o.variantsPerAudioGroup,
			iframePlaylists: o.iframePlaylists,
			audioVariantStreams: o.audioVariantStreams,
			jitPlacement: o.jitPlacement,
		});
	};

	const dashManifest = (
		key: string,
		manifestName: string | undefined,
		name: string | undefined,
		options: WizardDashOptions | undefined,
		primary: boolean,
	): ManifestInput => {
		const o = options ?? {};
		return prune({
			key,
			kind: "DASH" as const,
			manifestName: primary ? "stream.mpd" : str(manifestName),
			name: primary ? "DASH Manifest" : str(name),
			destination: destination(base, o.acl),
			// "ja" is the pinned P1 emission (the sftp fixtures carry it).
			audioLanguage: primary ? (o.audioLanguage ?? "ja") : str(o.audioLanguage),
			representationType: primary
				? (o.representationType ?? ("TEMPLATE" as const))
				: o.representationType,
			profile: o.onDemand ? ("ON_DEMAND" as const) : undefined,
			videoMuxingKind: o.videoMuxingKind,
			audioMuxingKind: o.audioMuxingKind,
			drmKind: o.drmKind,
			adaptationSets: o.adaptationSets?.length
				? o.adaptationSets.map((set) =>
						prune({
							key: set.key,
							type: set.type,
							lang: str(set.lang),
							label: str(set.label),
						}),
					)
				: undefined,
			jitPlacement: o.jitPlacement,
		});
	};

	const manifests: ManifestInput[] = [
		...(state.manifests.hls
			? [
					hlsManifest(
						"hls",
						undefined,
						undefined,
						state.manifests.hlsOptions,
						true,
					),
				]
			: []),
		...(state.manifests.dash
			? [
					dashManifest(
						"dash",
						undefined,
						undefined,
						state.manifests.dashOptions,
						true,
					),
				]
			: []),
		...(state.manifests.extra ?? []).map((manifest) => {
			if (manifest.kind === "HLS") {
				return hlsManifest(
					manifest.key,
					manifest.manifestName,
					manifest.name,
					manifest.hls,
					false,
				);
			}
			if (manifest.kind === "DASH") {
				return dashManifest(
					manifest.key,
					manifest.manifestName,
					manifest.name,
					manifest.dash,
					false,
				);
			}
			return prune({
				key: manifest.key,
				kind: "SMOOTH" as const,
				serverManifestName: str(manifest.serverManifestName),
				clientManifestName: str(manifest.clientManifestName),
				name: str(manifest.name),
				destination: destination(base, manifest.acl),
				language: str(manifest.language),
				drmKind: manifest.drmKind,
			});
		}),
	];

	const perTitle = state.startOptions?.perTitle
		? prune({
				h264Configuration: buildPerTitleCodec(
					"h264",
					state.startOptions.perTitle.h264,
				),
				[hevcV2 ? "h265V2Configuration" : "h265Configuration"]:
					buildPerTitleCodec("h265", state.startOptions.perTitle.h265),
				vp9Configuration: buildPerTitleCodec(
					"vp9",
					state.startOptions.perTitle.vp9,
				),
				av1Configuration: buildPerTitleCodec(
					"av1",
					state.startOptions.perTitle.av1,
				),
			})
		: undefined;

	const ai = state.startOptions?.aiSceneAnalysis;
	const encodings = sources.encodings ?? [];
	const keyframes = sources.keyframes ?? [];
	const fileStreams = sources.fileStreams ?? [];
	const dolbyStreams = sources.dolbyStreams ?? [];
	const trimmingStreams = sources.trimmingStreams ?? [];
	const concatenationStreams = sources.concatenationStreams ?? [];
	const filters = state.filters ?? [];
	const thumbnails = state.thumbnails ?? [];
	const sprites = state.sprites ?? [];

	return {
		planVersion: 1,
		...(internal ? { internal } : {}),
		name: state.name,
		bitmovin: {
			accountId: state.accountId || undefined,
			cloudRegion: state.cloudRegion,
			encoderVersion: state.encoderVersion,
			// Conditional spreads (not `?? undefined`): absent state must emit NO
			// plan keys so the 56 goldens stay byte-identical.
			...(state.labels && state.labels.length > 0
				? { labels: state.labels }
				: {}),
			...(state.infrastructure ? { infrastructure: state.infrastructure } : {}),
			...(state.prewarmedEncoderPoolIds !== undefined
				? { prewarmedEncoderPoolIds: state.prewarmedEncoderPoolIds }
				: {}),
		},
		inputs: inputDecls(),
		outputs: outputDecls(),
		...(state.additionalOutputs.length > 0
			? {
					deliveryMirrors: state.additionalOutputs.map((_, index) => ({
						outputKey: `mirror-${index + 1}`,
					})),
				}
			: {}),
		...(encodings.length > 0
			? {
					encodings: encodings.map((encoding) =>
						prune({
							key: encoding.key,
							name: encoding.name,
							cloudRegion: str(encoding.cloudRegion),
						}),
					),
				}
			: {}),
		ingest,
		...(fileStreams.length > 0
			? {
					fileStreams: fileStreams.map((stream) => {
						const f = ref(stream.inputFile);
						return prune({
							key: stream.key,
							inputKey: f.inputKey,
							inputPath: f.inputPath,
							fileType: stream.fileType ?? "WEBVTT",
							encodingKey: str(stream.encodingKey),
						});
					}),
				}
			: {}),
		...(dolbyStreams.length > 0
			? {
					dolbyStreams: dolbyStreams.map((stream) => {
						if (stream.kind === "ATMOS") {
							const f = ref(stream.inputFile);
							return prune({
								key: stream.key,
								kind: "ATMOS" as const,
								inputKey: f.inputKey,
								inputPath: f.inputPath,
								inputFormat: stream.inputFormat,
								encodingKey: str(stream.encodingKey),
							});
						}
						if (stream.kind === "VISION") {
							const video = ref(stream.videoInputFile);
							return prune({
								key: stream.key,
								kind: "VISION" as const,
								inputKey: video.inputKey,
								videoInputPath: video.inputPath,
								metadataInputPath: stream.metadataInputFile
									? ref(stream.metadataInputFile).inputPath
									: undefined,
								encodingKey: str(stream.encodingKey),
							});
						}
						const f = ref(stream.inputFile);
						return prune({
							key: stream.key,
							kind: "VISION_METADATA" as const,
							inputKey: f.inputKey,
							inputPath: f.inputPath,
							encodingKey: str(stream.encodingKey),
						});
					}),
				}
			: {}),
		...(trimmingStreams.length > 0
			? {
					trimmingStreams: trimmingStreams.map((stream) => {
						if (stream.kind === "TIMECODE_TRACK") {
							return prune({
								key: stream.key,
								kind: "TIMECODE_TRACK" as const,
								sourceKey: stream.sourceKey,
								startTimeCode: str(stream.startTimeCode),
								endTimeCode: str(stream.endTimeCode),
								encodingKey: str(stream.encodingKey),
							});
						}
						if (stream.kind === "H264_PICTURE_TIMING") {
							return prune({
								key: stream.key,
								kind: "H264_PICTURE_TIMING" as const,
								sourceKey: stream.sourceKey,
								startPicTiming: str(stream.startPicTiming),
								endPicTiming: str(stream.endPicTiming),
								encodingKey: str(stream.encodingKey),
							});
						}
						return prune({
							key: stream.key,
							kind: "TIME_BASED" as const,
							sourceKey: stream.sourceKey,
							offset: stream.offset,
							duration: stream.duration,
							encodingKey: str(stream.encodingKey),
						});
					}),
				}
			: {}),
		...((sources.audioMixStreams?.length ?? 0) > 0
			? { audioMixStreams: sources.audioMixStreams }
			: {}),
		...(concatenationStreams.length > 0
			? {
					concatenationStreams: concatenationStreams.map((stream) =>
						prune({
							key: stream.key,
							sources: stream.sources.map((source) =>
								prune({
									sourceKey: source.sourceKey,
									isMain: source.isMain,
									position: source.position,
									paddingBefore: source.paddingBefore,
									paddingAfter: source.paddingAfter,
									aspectMode: source.aspectMode,
								}),
							),
							encodingKey: str(stream.encodingKey),
						}),
					),
				}
			: {}),
		...(filters.length > 0
			? {
					filters: filters.map((filter) =>
						isMediaFilter(filter)
							? prune(filter)
							: prune({ ...filter, kind: "DEINTERLACE" as const }),
					),
				}
			: {}),
		renditions: [
			...state.videos.map((video, index) =>
				videoRendition(video, vKeys[index] ?? `v${video.height}`),
			),
			// VMAF-only scores video only — audio/subtitle renditions are dropped
			// (validate forbids them under qc.only; the compiler skips them).
			...(qcOnly
				? []
				: state.audios.map((audio, index) =>
						audioRendition(
							audio,
							aKeys[index] ?? `a${Math.round(audio.bitrate / 1000)}`,
						),
					)),
			...(qcOnly
				? []
				: subtitles.map((subtitle, index) =>
						subtitleRendition(subtitle, sKeys[index] ?? "vtt"),
					)),
		],
		muxings: [
			// Primary leg first, then any extra legs (e.g. fMP4 for DASH + TS for
			// HLS from one stream) — matches the per-rendition sample ordering.
			...state.videos.flatMap((video, index) => {
				const key = vKeys[index] ?? `v${video.height}`;
				return [
					muxingFor(
						key,
						"FMP4",
						video.muxing,
						true,
						video.muxing ? carriedAudioKeys(video.muxing) : [],
					),
					...(video.extraMuxings ?? []).map((m) =>
						muxingFor(key, "FMP4", m, false, carriedAudioKeys(m)),
					),
				];
			}),
			// A leg the operator asked to ride inside the video emits NO container
			// of its own — the stream is already listed on the video's. Emitting
			// both would encode the audio twice and give the master playlist a
			// group nothing points at. VMAF-only keeps ONLY video muxings (each
			// carries its qc mirror's destination); both rules live in
			// `wizardAudioLegs`, which the default HLS version reads too.
			...audioLegs.map(({ key, leg, primary }) =>
				muxingFor(
					key,
					state.audios.find((_, i) => aKeys[i] === key)?.codec === "OPUS"
						? "WEBM"
						: "FMP4",
					leg,
					primary,
				),
			),
			...(qcOnly
				? []
				: subtitles.map((subtitle, index) => {
						const key = sKeys[index] ?? "vtt";
						return muxingFor(
							key,
							subtitle.codec === "IMSC" ? "TEXT" : "CHUNKED_TEXT",
							subtitle.muxing,
							false,
						);
					})),
		],
		...(drm.length > 0 && !qcOnly ? { drm } : {}),
		...(thumbnails.length > 0 && !qcOnly
			? {
					thumbnails: thumbnails.map((thumb) =>
						prune({
							key: thumb.key,
							streamKey: thumb.streamKey,
							height: thumb.height,
							// pattern/unit have schema defaults — emit only deviations.
							pattern: str(thumb.pattern),
							unit: thumb.unit,
							positions: thumb.positions,
							destination: destination(`${base}${thumb.path ?? ""}`),
						}),
					),
				}
			: {}),
		// Sprites emit only when present (default state ⇒ no `sprites` key, so
		// the 56 goldens + P1 round-trip fixtures stay byte-stable). Optional
		// grid/dimension fields are pruned when unset; unit has a schema default.
		...(sprites.length > 0 && !qcOnly
			? {
					sprites: sprites.map((sprite) =>
						prune({
							key: sprite.key,
							streamKey: sprite.streamKey,
							distance: sprite.distance,
							unit: sprite.unit,
							width: sprite.width,
							height: sprite.height,
							hTiles: sprite.hTiles,
							vTiles: sprite.vTiles,
							imagesPerFile: sprite.imagesPerFile,
							spriteName: str(sprite.spriteName),
							filename: sprite.filename,
							vttName: str(sprite.vttName),
							creationMode: sprite.creationMode,
							destination: destination(`${base}${sprite.path ?? ""}`),
						}),
					),
				}
			: {}),
		...(keyframes.length > 0 && !qcOnly
			? {
					keyframes: keyframes.map((keyframe) =>
						prune({
							key: keyframe.key,
							time: keyframe.time,
							encodingKey: str(keyframe.encodingKey),
						}),
					),
				}
			: {}),
		// VMAF-only encodes carry no manifests (validate rejects them); the
		// compiler would drop them anyway. Otherwise emit the built list.
		manifests: qcOnly ? [] : manifests,
		...(perTitle && Object.keys(perTitle).length > 0 ? { perTitle } : {}),
		...(ai && !qcOnly
			? {
					aiSceneAnalysis: prune({
						assetDescription: {
							filename: ai.filename.trim() || "analysis.json",
							destination: destination(`${base}${ai.path}`),
						},
						automaticAdPlacement:
							ai.allSceneBoundaries || ai.schedule !== undefined
								? prune({
										allSceneBoundaries: ai.allSceneBoundaries,
										schedule: ai.schedule,
									})
								: undefined,
						outputLanguageCodes: ai.outputLanguageCodes?.length
							? ai.outputLanguageCodes
							: undefined,
					}),
				}
			: {}),
		generation: {
			timing: state.timing,
			...(!wizardUsesCodecEncodingMode(state) &&
			state.startOptions?.encodingMode
				? { encodingMode: state.startOptions.encodingMode }
				: {}),
			...(state.startOptions?.audioVideoSyncMode
				? { audioVideoSyncMode: state.startOptions.audioVideoSyncMode }
				: {}),
			// Boolean: emit whenever SET (an explicit false round-trips); the
			// checkbox maps unchecked to undefined so default plans stay minimal.
			...(state.startOptions?.handleVariableInputFps !== undefined
				? { handleVariableInputFps: state.startOptions.handleVariableInputFps }
				: {}),
		},
		// Delivery commitment : carried verbatim so a committed plan
		// round-trips through the form instead of falling into verbatim import.
		...(state.delivery ? { delivery: state.delivery } : {}),
		// QC (VMAF + optional PSNR) is emitted ONLY when on; default-off prunes
		// the whole key so the 56 goldens (none carry `qc`) stay byte-identical
		// (mirrors how Per-Title/AISA emit nothing when their toggles are off).
		...(state.qc && (state.qc.vmaf || state.qc.psnr)
			? {
					// PSNR rides the SAME libvmaf pass (planQcSchema): a psnr-on
					// plan always runs VMAF too, so normalize psnr-without-vmaf to
					// vmaf:true. The compiler mirror gate is `vmaf||psnr` either
					// way; this keeps the emitted plan unambiguous and round-trips
					// cleanly back through plan-to-wizard.
					qc: prune({
						execution: state.qc.execution,
						measurementMethod: state.qc.measurementMethod,
						vmaf: state.qc.vmaf || state.qc.psnr,
						// The schema default is emitted as absence — deviations only
						// so an enabled-but-default plan stays sample-minimal.
						model:
							state.qc.model === DEFAULT_VMAF_MODEL
								? undefined
								: state.qc.model,
						psnr: state.qc.psnr ? true : undefined,
						// VMAF-only: emit `only: true` (and the spreads above cleared
						// manifests/thumbnails/sprites/drm/keyframes). Absent otherwise.
						only: qcOnly ? true : undefined,
						// QC gate : VERBATIM — the editor produces the
						// schema shape and the preview's validator rails a bad one
						// loudly (the infrastructure precedent); pruning would swallow
						// rules the user typed.
						gate: state.qc.gate,
					}),
				}
			: {}),
		// Kantar audio watermarking — ONE plan-root block (the API resource is an
		// encoding-level singleton, so the compiler fans it out to every sibling
		// encoding). Emitted VERBATIM whenever the section is on: a half-filled
		// form must reach the schema and fail loudly in the preview (the
		// `infrastructure` precedent above) instead of being quietly pruned.
		// Absent state ⇒ no key at all, so the goldens stay byte-identical.
		...(state.kantar
			? {
					kantar: {
						credentialId: state.kantar.credentialId,
						// Deliberate cast: a blank license-id input must reach zod as
						// `undefined` so the preview reads "expected number, received
						// undefined". str/prune-ing it would drop what the user typed.
						licenseId: state.kantar.licenseId as number,
						channelName: state.kantar.channelName,
						contentReference: state.kantar.contentReference,
						serverUrl: state.kantar.serverUrl,
						reportDestination: {
							outputKey: "origin",
							path: `${base}${state.kantar.reportPath}`,
							// PRIVATE is a per-leg override; otherwise the report inherits
							// the output's ACL exactly like every other destination.
							...(state.kantar.reportPrivate
								? { acl: "PRIVATE" as const }
								: acl
									? { acl }
									: {}),
						},
					},
				}
			: {}),
	};
}

/**
 * Cascades an input-file key rename through every reference: the implicit
 * audio file and source rows (tracks, fileStreams, dolbyStreams — the Dolby
 * Vision row carries two refs). Removal deliberately does NOT cascade:
 * silently retargeting a stream would change which object it reads; the
 * input-file selects surface the stale key as "(missing)" instead and the
 * preview raises PLAN_UNRESOLVED_REF.
 */
export function remapInputKeyRefs(
	state: WizardState,
	from: string,
	to: string,
): Partial<WizardState> {
	const patch: Partial<WizardState> = {};
	if (state.audioInputFile === from) {
		patch.audioInputFile = to;
	}
	if (state.videos.some((v) => v.extras?.burnInSrt?.inputFile === from)) {
		patch.videos = state.videos.map((v) =>
			v.extras?.burnInSrt?.inputFile === from
				? {
						...v,
						extras: {
							...v.extras,
							burnInSrt: { ...v.extras.burnInSrt, inputFile: to },
						},
					}
				: v,
		);
	}
	const sources = state.sources;
	if (sources) {
		const mapFile = <T extends { inputFile: string }>(row: T): T =>
			row.inputFile === from ? { ...row, inputFile: to } : row;
		const mapDolby = (row: WizardDolbyStream): WizardDolbyStream => {
			if (row.kind === "VISION") {
				return {
					...row,
					videoInputFile: row.videoInputFile === from ? to : row.videoInputFile,
					metadataInputFile:
						row.metadataInputFile === from ? to : row.metadataInputFile,
				};
			}
			return row.inputFile === from ? { ...row, inputFile: to } : row;
		};
		patch.sources = {
			...sources,
			tracks: sources.tracks?.map(mapFile),
			fileStreams: sources.fileStreams?.map(mapFile),
			dolbyStreams: sources.dolbyStreams?.map(mapDolby),
		};
	}
	return patch;
}

/**
 * Cascades a multi-encoding key rename (removal when `to` is undefined)
 * through every reference: source rows, the implicit-track assignments,
 * rendition extras and keyframes. Editing the partition must never strand
 * stale encodingKey refs — they would surface as PLAN_UNRESOLVED_REF
 * errors the user cannot see the origin of.
 */
export function remapEncodingKeyRefs(
	state: WizardState,
	from: string,
	to: string | undefined,
): Partial<WizardState> {
	const mapKey = (key: string | undefined) => (key === from ? to : key);
	const mapExtras = (
		extras: WizardRenditionExtras | undefined,
	): WizardRenditionExtras | undefined =>
		extras?.encodingKey === from ? { ...extras, encodingKey: to } : extras;
	const sources = state.sources;
	return {
		videos: state.videos.map((video) =>
			video.extras?.encodingKey === from
				? { ...video, extras: mapExtras(video.extras) }
				: video,
		),
		audios: state.audios.map((audio) =>
			audio.extras?.encodingKey === from
				? { ...audio, extras: mapExtras(audio.extras) }
				: audio,
		),
		...(state.subtitles
			? {
					subtitles: state.subtitles.map((subtitle) =>
						subtitle.extras?.encodingKey === from
							? { ...subtitle, extras: mapExtras(subtitle.extras) }
							: subtitle,
					),
				}
			: {}),
		...(sources
			? {
					sources: {
						...sources,
						tracks: sources.tracks?.map((track) =>
							track.encodingKey === from
								? { ...track, encodingKey: to }
								: track,
						),
						fileStreams: sources.fileStreams?.map((stream) =>
							stream.encodingKey === from
								? { ...stream, encodingKey: to }
								: stream,
						),
						dolbyStreams: sources.dolbyStreams?.map((stream) =>
							stream.encodingKey === from
								? { ...stream, encodingKey: to }
								: stream,
						),
						trimmingStreams: sources.trimmingStreams?.map((stream) =>
							stream.encodingKey === from
								? { ...stream, encodingKey: to }
								: stream,
						),
						audioMixStreams: sources.audioMixStreams?.map((s) =>
							s.encodingKey === from ? { ...s, encodingKey: to } : s,
						),
						concatenationStreams: sources.concatenationStreams?.map((stream) =>
							stream.encodingKey === from
								? { ...stream, encodingKey: to }
								: stream,
						),
						keyframes: sources.keyframes?.map((keyframe) =>
							keyframe.encodingKey === from
								? { ...keyframe, encodingKey: to }
								: keyframe,
						),
						...(sources.implicitEncodingKeys
							? {
									implicitEncodingKeys: {
										video: mapKey(sources.implicitEncodingKeys.video),
										audio: mapKey(sources.implicitEncodingKeys.audio),
									},
								}
							: {}),
					},
				}
			: {}),
	};
}
