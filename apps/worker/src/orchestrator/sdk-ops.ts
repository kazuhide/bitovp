import type {
	H265V2QualityControls,
	ScannedMuxing,
	ScannedStream,
	ScanPage,
	VerificationEncodingIdentity,
} from "@bitovp/core";
import { bitmovinCapturePort } from "@bitovp/core";
import type { AuditEntry } from "@bitovp/db";
import { BitmovinApi } from "../bitmovin/sdk-ctor";
import {
	assertInternalHevcV2Access,
	type InternalHevcV2,
} from "./internal-hevc-v2";
import { createOrphanStopFetch } from "./orphan-stop-fetch";
import { createRetryingFetch } from "./retrying-fetch";
import { type CreateStamp, createStampingFetch } from "./stamping-fetch";

/**
 * The @bitmovin/api-sdk boundary. This file owns the CONTRACT (SdkOps and
 * its param types) and the facade factory; the member implementations live
 * in ops/{io,configs,media,drm,manifests,encoding,live}.ts ( —
 * extracted VERBATIM from the pre-split monolith; facade-freeze.test.ts
 * pins the member set), sharing helpers via ops/shared.ts and the closure
 * context via ops/context.ts. No SDK class escapes this directory — the
 * executor/processor work against SdkOps so they are testable with plain
 * fakes. Every mutating call is audit-logged (REQUIREMENTS §6) through the
 * injected recorder — request snapshots passed in by the executor are
 * already secret-free, and the snapshots built in the ops files for
 * DRM/NexGuard calls never include key/license material.
 * Status polls and list/get reads are deliberately NOT audited (4h × 10s
 * would be noise, and they carry no mutation); the AWAIT step's final
 * task result lands in the step log.
 *
 * Plan vocabulary uses SDK enum NAMES (matching the encoding examples
 * acceptance fixtures); several TS enums have name ≠ wire value
 * (HLS_V4→"4", CL_STEREO→"STEREO", EQUAL→"==", S64→"64", D4→"4",
 * MAIN→"main", IV_16_BYTES→"16_BYTES", ITU_R_BS_1770_4→"ITU-R
 * BS.1770-4"), so names are mapped to enum members here via
 * sdkEnumValue — never bare-cast, even where name === value today.
 */

export type TaskStatusResult = {
	status: string;
	progress?: number;
	messages?: string[];
};

/**
 * One entry of an encoding's status `messages[]`, with its severity and
 * timestamp kept (`TaskStatusResult.messages` flattens both away). The slate
 * failure-reason capture (WP-A3) needs them to attribute a message to one
 * insertion. `date` is ISO 8601, or null when the provider stamped none.
 */
export type EncodingMessage = {
	type: string;
	text: string;
	date: string | null;
};

/**
 * Optional muxing/DRM/thumbnail output target. Muxings whose output is
 * owned by a DRM resource carry NO destination (compiler contract) — the
 * SDK then receives no `outputs` array at all.
 */
export type Destination = {
	outputId: string;
	outputPath: string;
	acl?: string;
	/**
	 * RESOLVED mirror output ids — the facade's `outputs`
	 * expands one EncodingOutput per mirror at the SAME path and acl.
	 */
	mirrorOutputIds?: string[];
	/**
	 * per-mirror output PATHS, aligned with `mirrorOutputIds`.
	 * Absent (or a missing entry) means the mirror shares the primary's path
	 * — the #115 shape; an Akamai MSL mirror of a storage primary needs the
	 * MSL manifest form (`/folder/`) instead.
	 */
	mirrorOutputPaths?: string[];
};

/** ColorConfig with enum NAMES; copy* flags pass through. */
export type ColorConfigParams = {
	copyChromaLocationFlag?: boolean;
	copyColorSpaceFlag?: boolean;
	copyColorPrimariesFlag?: boolean;
	copyColorRangeFlag?: boolean;
	copyColorTransferFlag?: boolean;
	chromaLocation?: string;
	colorSpace?: string;
	colorPrimaries?: string;
	colorRange?: string;
	colorTransfer?: string;
};

/** Full compiler surface for CREATE_CODEC_H264 (enum fields carry NAMES). */
export type H264ConfigParams = {
	encodingMode?: string;
	name?: string;
	width?: number;
	height?: number;
	bitrate?: number;
	rate?: number;
	level?: string;
	presetConfiguration?: string;
	profile?: string;
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
	weightedPredictionPFrames?: string;
	colorConfig?: ColorConfigParams;
};

/** Full compiler surface for CREATE_CODEC_H265 (subMe is numeric here). */
export type H265ConfigParams = H265V2QualityControls & {
	internalHevcV2?: true;
	encodingMode?: string;
	name?: string;
	profile?: string;
	height?: number;
	bitrate?: number;
	rate?: number;
	level?: string;
	pixelFormat?: string;
	minKeyframeInterval?: number;
	maxKeyframeInterval?: number;
	rcLookahead?: number;
	subMe?: number;
	maxCTUSize?: string;
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
	hdr?: boolean;
	masterDisplay?: string;
	maxContentLightLevel?: number;
	maxPictureAverageLightLevel?: number;
	colorConfig?: ColorConfigParams;
	presetConfiguration?: string;
	maxBitrate?: number;
	bufsize?: number;
	dynamicRangeFormat?: string;
	levelHighTier?: boolean;
};

/** Full compiler surface for CREATE_CODEC_VP9. */
export type Vp9ConfigParams = {
	encodingMode?: string;
	name?: string;
	height?: number;
	bitrate?: number;
	rate?: number;
	cpuUsed?: number;
	tileColumns?: number;
	qpMin?: number;
	qpMax?: number;
	rateUndershootPct?: number;
	rateOvershootPct?: number;
	quality?: string;
	lossless?: boolean;
	aqMode?: string;
	arnrType?: string;
	arnrMaxFrames?: number;
	arnrStrength?: number;
	colorConfig?: ColorConfigParams;
};

/** Full compiler surface for CREATE_CODEC_AV1. */
export type Av1ConfigParams = {
	encodingMode?: string;
	name?: string;
	height?: number;
	bitrate?: number;
	rate?: number;
	/** Av1PresetConfiguration name (VOD_QUALITY|VOD_STANDARD|VOD_SPEED). */
	presetConfiguration?: string;
	/** AutoLevelSetup name (ENABLED|DISABLED). */
	autoLevelSetup?: string;
	colorConfig?: ColorConfigParams;
};

/** PaddingSequence (enum field carries the NAME). */
export type PaddingSequenceParams = {
	duration: number;
	unit?: string;
};

/**
 * One concatenation part: the resolved source input-stream id plus ordering
 * and padding. enum fields (unit, aspectMode) carry NAMES, mapped here.
 */
export type ConcatenationSourceParams = {
	inputStreamId: string;
	isMain?: boolean;
	position?: number;
	paddingBefore?: PaddingSequenceParams;
	paddingAfter?: PaddingSequenceParams;
	aspectMode?: string;
};

export type AvMuxingKind = "CMAF" | "FMP4" | "TS" | "MP4" | "WEBM";

/** Listing surface the per-title expansion ops work from (C6 paginated). */
export type MuxingSummary = {
	id: string;
	streamId: string;
	outputPath?: string;
	avgBitrate?: number;
	filename?: string;
};

export type AiSceneAnalysisParams = {
	assetDescription: {
		filename: string;
		outputId: string;
		outputPath: string;
		acl?: string;
	};
	automaticAdPlacement?: {
		schedule?: { position: number; maxDeviation: number; duration?: number }[];
		allSceneBoundaries?: { isEnabled?: boolean; insertCueTags?: boolean };
	};
	outputLanguageCodes?: string[];
};

// --- Live (P3-PR2 channel lifecycle) ---------------------------------------

/**
 * Shared SRT connection surface — the top-level input and every
 * backupSrtInputs entry are full SrtInputs in the SDK. The passphrase is
 * vault material resolved by the executor at execution time; it reaches
 * the SDK call but NEVER the audit snapshot (hand-built below).
 */
export type SrtConnectionParams = {
	mode: string;
	host?: string;
	port: number;
	path?: string;
	latency?: number;
	/** Secret — excluded from the audit snapshot. */
	passphrase?: string;
	keyLength?: number;
};

export type RedundantRtmpInputParams = {
	name: string;
	delayThreshold?: number;
	/** Dynamic ingest points; streamKey is connection-routing material —
	 * it rides the snapshot and redactSecrets masks it at persistence. */
	ingestPoints?: { applicationName: string; streamKey: string }[];
	staticIngestPoints?: {
		name?: string;
		streamKeyConfiguration?: { type: string; streamKeyId?: string };
	}[];
};

/** LiveHlsManifest start options (manifestId zipped in by the executor). */
export type LiveHlsStartOptions = {
	timeshift?: number;
	liveEdgeOffset?: number;
	insertProgramDateTime?: boolean;
	/**
	 * EXT-X-PROGRAM-DATE-TIME source + placement (enum fields carry NAMEs).
	 * Plan-side `source`/`placement.mode` map onto the SDK's longer
	 * `programDateTimeSource`/`programDateTimePlacement.programDateTimePlacementMode`.
	 */
	programDateTimeSettings?: {
		source?: string;
		placement?: { mode: string; interval?: number };
	};
	/** SCTE-35 ad markers (C14); enabledMarkerTypes carry the enum NAMEs. */
	adMarkerSettings?: {
		enabledMarkerTypes?: string[];
		disablePreannouncing?: boolean;
	};
};

/** LiveDashManifest start options (enum field carries the NAME). */
export type LiveDashStartOptions = {
	timeshift?: number;
	liveEdgeOffset?: number;
	/** Milliseconds in app plans/step logs; the SDK adapter converts to seconds. */
	suggestedPresentationDelay?: number;
	/** Milliseconds in app plans/step logs; the SDK adapter converts to seconds. */
	minimumUpdatePeriod?: number;
	availabilityStartTimeMode?: string;
	/** SCTE-35 ad markers (C14); both fields carry the enum NAMEs. */
	adMarkerSettings?: {
		periodOption?: string;
		eventStreamSignalling?: string;
	};
};

export type StartLiveEncodingParams = {
	/** Resolved by the compiler; absent legacy payloads keep Custom Live. */
	encodingOption?: "HD" | "CUSTOM";
	/** Connection-routing material (NOT vault) — rides the audit snapshot;
	 * redactSecrets masks it at persistence (the ledgered exception). */
	streamKey: string;
	hlsManifests?: ({ manifestId: string } & LiveHlsStartOptions)[];
	dashManifests?: ({ manifestId: string } & LiveDashStartOptions)[];
	liveEncodingMode?: string;
	/** Explicit null = "never re-upload" (SDK-documented) — carried through. */
	reuploadSettings?: {
		dashManifestInterval?: number | null;
		muxingInitFileInterval?: number | null;
	};
	manifestGenerator?: string;
	autoRestartConfiguration?: {
		segmentsWrittenTimeout?: number;
		bytesWrittenTimeout?: number;
		framesWrittenTimeout?: number;
		hlsManifestsUpdateTimeout?: number;
		dashManifestsUpdateTimeout?: number;
		scheduleExpression?: string;
		restartOnEncoderError?: boolean;
	};
	autoShutdownConfiguration?: {
		bytesReadTimeoutSeconds?: number;
		streamTimeoutMinutes?: number;
		waitingForFirstConnectTimeoutMinutes?: number;
	};
	/**
	 * ESAM / POIS out-of-band signalling (SCTE-250). username/password are
	 * the RESOLVED vault values — the executor injects them and they are
	 * replaced by presence flags in the audit snapshot (never persisted).
	 */
	esamSettings?: {
		poisEndpoint?: string;
		acquisitionPointIdentity?: string;
		zoneIdentity?: string;
		/** Milliseconds. */
		adAvailOffset?: number;
		/** Secrets — excluded from the audit snapshot. */
		username?: string;
		password?: string;
	};
	/** Per-artifact Cache-Control headers (S3/GCS/Azure outputs only). */
	cacheControlSettings?: {
		hls?: {
			multiVariantPlaylist?: { cacheControl?: string };
			variantPlaylist?: { cacheControl?: string };
		};
		dash?: {
			timelineManifest?: { cacheControl?: string };
			templateManifest?: { cacheControl?: string };
		};
		segments?: {
			initSegment?: { cacheControl?: string };
			mediaSegment?: { cacheControl?: string };
		};
	};
	/** Runtime ESAM media-point gate + PDT clock mode (enum carries the NAME). */
	adInsertionSettings?: {
		enableEsamMediaPointInsertion?: boolean;
		clockSynchronizationMode?: string;
	};
};

/** LiveEncoding (live get): where to point the encoder. */
export type LiveEncodingDetails = {
	streamKey?: string;
	encoderIp?: string;
	application?: string;
};

/**
 * Heartbeat sample as plain JSON (persistable). The four packet counters
 * are CUMULATIVE since encoding start — rate displays need deltas, which
 * the channel worker computes against the previous sample.
 */
export type LiveHeartbeatSample = {
	timestamp?: string;
	ingest?: {
		status?: string;
		healthy?: boolean;
		droppedPacketsVideo?: number;
		droppedPacketsAudio?: number;
		corruptPacketsVideo?: number;
		corruptPacketsAudio?: number;
		ingestPoints?: unknown[];
		streams?: unknown[];
		[key: string]: unknown;
	};
	/**
	 * Delivery-side health (LiveEncodingHeartbeatOutput: manifests +
	 * segments). The raw JSON round-trip below always carried it — this
	 * TYPE omitted it, so every typed reader (alert metrics, panels) was
	 * structurally blind to the output half while the ingest half was
	 * fully modelled .
	 *
	 * Inner shape typed from the FIRST REAL sample ( PR0,
	 *  — the
	 * #125 run's 17 persisted heartbeats), never modeled from the SDK docs
	 * alone. Measured facts a reader must not un-learn: `manifestUpdates`
	 * is NEWEST-FIRST; `manifestUpdateLatency` can be NEGATIVE on a healthy
	 * run (−71/−95 ms observed — sign is noise, not signal); both outlier
	 * arrays are EMPTY on a healthy run (so "no outliers" ≠ evidence of
	 * health — the design's own argument for the origin read); `manifests`
	 * carries `hls` only.
	 */
	output?: {
		manifests?: {
			hls?: Array<{
				manifestId?: string;
				manifestUpdates?: Array<{
					manifestUpdateLatency?: number;
					latestMediaPresentationTime?: string;
					manifestUpdateWallClockTime?: string;
				}>;
				[key: string]: unknown;
			}>;
			[key: string]: unknown;
		};
		segments?: {
			uploadOutliers?: unknown[];
			totalProcessingOutliers?: unknown[];
			totalProcessingStatsMs?: {
				max?: number;
				min?: number;
				mean?: number;
				median?: number;
			};
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	events?: unknown[];
};

export type ResetLiveTimeshiftParams = {
	residualPeriodInSeconds?: number;
	offsetInSeconds?: number;
	/** Absent = all manifests (SDK semantics). */
	manifestIds?: string[];
	shiftProgressiveMuxingStartPosition?: boolean;
};

export type Scte35CueParams = {
	cueDuration: number;
	/** Absent = all manifests (SDK semantics). */
	manifestIds?: string[];
};

export type SdkOps = {
	createS3Input(p: {
		name: string;
		bucketName: string;
		accessKey: string;
		secretKey: string;
	}): Promise<string>;
	createAzureInput(p: {
		name: string;
		container: string;
		accountName: string;
		accountKey: string;
	}): Promise<string>;
	createHttpsInput(p: { name: string; host: string }): Promise<string>;
	/**
	 * S3-compatible input (Akamai/OCI/GenericS3, C10). host/port/ssl come from
	 * the resolved credential; `signatureVersion` carries the S3SignatureVersion
	 * NAME (V4/V2 — Akamai/OCI always V4). accessKey/secretKey are required
	 * secrets (the executor throws rather than pass empty strings).
	 */
	createGenericS3Input(p: {
		name: string;
		bucketName: string;
		host: string;
		port?: number;
		ssl?: boolean;
		signatureVersion?: string;
		accessKey: string;
		secretKey: string;
	}): Promise<string>;
	/** GCS via HMAC keys; `cloudRegion` carries the GoogleCloudRegion NAME. */
	createGcsInput(p: {
		name: string;
		bucketName: string;
		cloudRegion?: string;
		accessKey: string;
		secretKey: string;
	}): Promise<string>;
	/** GCS via a service-account key JSON (vault material). */
	createGcsServiceAccountInput(p: {
		name: string;
		bucketName: string;
		cloudRegion?: string;
		/** Secret — excluded from the audit snapshot. */
		serviceAccountCredentials: string;
	}): Promise<string>;
	createS3Output(p: {
		name: string;
		bucketName: string;
		accessKey: string;
		secretKey: string;
	}): Promise<string>;
	createAzureOutput(p: {
		name: string;
		container: string;
		accountName: string;
		accountKey: string;
	}): Promise<string>;
	createSftpOutput(p: {
		name: string;
		host: string;
		port: number;
		username: string;
		password: string;
	}): Promise<string>;
	/**
	 * Akamai NetStorage . Input and output take the identical
	 * three fields — the SDK models differ only in which resource they create —
	 * so one payload shape serves both.
	 */
	createAkamaiNetStorageInput(p: {
		name: string;
		host: string;
		username: string;
		password: string;
	}): Promise<string>;
	createAkamaiNetStorageOutput(p: {
		name: string;
		host: string;
		username: string;
		password: string;
	}): Promise<string>;
	/** S3-compatible output (Akamai/OCI/GenericS3, C10) — mirrors the input. */
	createGenericS3Output(p: {
		name: string;
		bucketName: string;
		host: string;
		port?: number;
		ssl?: boolean;
		signatureVersion?: string;
		accessKey: string;
		secretKey: string;
	}): Promise<string>;
	/** GCS output via HMAC keys; `cloudRegion` is the GoogleCloudRegion NAME. */
	createGcsOutput(p: {
		name: string;
		bucketName: string;
		cloudRegion?: string;
		accessKey: string;
		secretKey: string;
	}): Promise<string>;
	/** GCS output via a service-account key JSON (vault material). */
	createGcsServiceAccountOutput(p: {
		name: string;
		bucketName: string;
		cloudRegion?: string;
		/** Secret — excluded from the audit snapshot. */
		serviceAccountCredentials: string;
	}): Promise<string>;
	/**
	 * Akamai MSL .
	 *
	 * THIS COMMENT USED TO SAY "the ONLY output factory with no secret …
	 * there is nothing to exclude from the snapshot", and MSL5 made that
	 * false . It is corrected here rather
	 * than in the PR that adds the field, because the sentence itself was the
	 * hazard: every other MSL field has an identical snapshot literal and SDK
	 * argument, so the minimal diff for `publishingAuthentication` adds it to
	 * both — and this note told the implementer that was safe.
	 *
	 * As it stands TODAY the payload is still secret-free: `streamId` +
	 * `eventName` are the provisioned identity and the API authenticates with
	 * the account key (COVERAGE C31). What changes with MSL5 is that
	 * `AkamaiMslOutput` gained `publishingAuthentication` — an HTTP Digest
	 * username/password, both writeOnly. When that field is wired, this
	 * factory joins the majority: the pair goes to the SDK and is
	 * DESTRUCTURED OUT of the snapshot, with a `publishingAuthProvided`
	 * boolean in its place. Destructured, not set to `undefined` — an
	 * `undefined` key still exists, so `redactSecrets` would emit
	 * `"password":"[REDACTED]"` beside `publishingAuthProvided:false`, which
	 * is audit data that contradicts itself (the POIS precedent,
	 * `ops/live.ts`).
	 */
	createLiveMediaIngestOutput(p: {
		name: string;
		publishingPoint: string;
		scte35Passthrough?: boolean;
	}): Promise<string>;
	createAkamaiMslOutput(p: {
		name: string;
		streamId: number;
		eventName: string;
		streamFormat: string;
		mslVersion: string;
		/**
		 * MSL5 HTTP Digest publishing credentials —  PR 2, and the
		 * field the docblock above was corrected in advance of.
		 *
		 * The CALLER derives `enabled` and omits this object entirely when no
		 * pair resolves; there is deliberately no way to send `enabled: false`
		 * with credentials, because that state is indistinguishable from
		 * "authentication is on" on every screen while publishing without it.
		 *
		 * Adding this to the signature is not a formality: the executor's
		 * spread compiled GREEN against the old signature — excess-property
		 * checking does not reach a spread — so the field would have been
		 * dropped silently on the way to the SDK. Found by reading the facade,
		 * not by a failing gate.
		 */
		publishingAuthentication?: {
			enabled: true;
			username: string;
			password: string;
		};
	}): Promise<string>;
	createEncoding(p: {
		name: string;
		cloudRegion: string;
		encoderVersion: string;
		fallbackCloudRegions?: string[];
		/** Encoding.labels — statistics grouping tags (plain strings). */
		labels?: string[];
		/** Cloud Connect pinning (Encoding.infrastructure). */
		infrastructure?: { infrastructureId: string; cloudRegion: string };
		/** Live-only: pin a reserved static IP (Encoding.staticIpId). */
		staticIpId?: string;
	}): Promise<string>;
	findVerificationEncodings(p: {
		jobId: string;
		verificationKey: string;
		requestSha256: string;
		resources: Array<{ step: string; name: string }>;
	}): Promise<VerificationEncodingIdentity[]>;
	createIngestInputStream(
		encodingId: string,
		p: {
			inputId: string;
			inputPath: string;
			selectionMode: string;
			position: number;
		},
	): Promise<string>;
	createFileInputStream(
		encodingId: string,
		p: { inputId: string; inputPath: string; fileType: string },
	): Promise<string>;
	createDolbyAtmosInputStream(
		encodingId: string,
		p: { inputId: string; inputPath: string; inputFormat: string },
	): Promise<string>;
	createDolbyVisionInputStream(
		encodingId: string,
		p: {
			inputId: string;
			videoInputPath: string;
			metadataInputPath?: string;
		},
	): Promise<string>;
	createDolbyVisionMetadataInputStream(
		encodingId: string,
		p: { inputId: string; inputPath: string },
	): Promise<string>;
	createTimeBasedTrimmingInputStream(
		encodingId: string,
		p: { inputStreamId: string; offset?: number; duration?: number },
	): Promise<string>;
	createTimecodeTrackTrimmingInputStream(
		encodingId: string,
		p: { inputStreamId: string; startTimeCode?: string; endTimeCode?: string },
	): Promise<string>;
	createH264PictureTimingTrimmingInputStream(
		encodingId: string,
		p: {
			inputStreamId: string;
			startPicTiming?: string;
			endPicTiming?: string;
		},
	): Promise<string>;
	createAudioMixInputStream(
		encodingId: string,
		p: {
			channelLayout?: string;
			audioMixChannels: Array<{
				inputStreamId: string;
				outputChannelType: string;
				outputChannelNumber?: number;
				sourceChannels: Array<{
					type: string;
					channelNumber?: number;
					gain?: number;
				}>;
			}>;
		},
	): Promise<string>;
	createConcatenationInputStream(
		encodingId: string,
		p: { sources: ConcatenationSourceParams[] },
	): Promise<string>;
	createH264Config(p: H264ConfigParams): Promise<string>;
	createH265Config(p: H265ConfigParams): Promise<string>;
	createVp9Config(p: Vp9ConfigParams): Promise<string>;
	createAv1Config(p: Av1ConfigParams): Promise<string>;
	createAacConfig(p: {
		name?: string;
		bitrate: number;
		rate: number;
		channelLayout: string;
	}): Promise<string>;
	createDolbyAtmosConfig(p: {
		name?: string;
		bitrate: number;
		rate: number;
		loudnessControl?: {
			meteringMode?: string;
			dialogueIntelligence?: string;
			speechThreshold?: number;
		};
	}): Promise<string>;
	createDolbyDigitalPlusConfig(p: {
		name?: string;
		bitrate: number;
		rate: number;
		channelLayout: string;
	}): Promise<string>;
	createDolbyDigitalConfig(p: {
		name?: string;
		bitrate: number;
		rate: number;
		channelLayout: string;
	}): Promise<string>;
	createOpusConfig(p: {
		name?: string;
		bitrate: number;
		rate: number;
		channelLayout: string;
	}): Promise<string>;
	createImscConfig(p: { styling?: { mode?: string } }): Promise<string>;
	createWebVttConfig(p: { name?: string }): Promise<string>;
	createStream(
		encodingId: string,
		p: {
			codecConfigId: string;
			/** VOD / file ingest: reference a pre-created IngestInputStream. */
			inputStreamId?: string;
			/**
			 * Live: reference the input DIRECTLY on the StreamInput. live/start
			 * cannot resolve a standalone IngestInputStream on the account RTMP
			 * input, so live streams carry inputId + inputPath + position (video
			 * 0 / audio 1) inline, matching the working Akamai sample (C13).
			 */
			inputId?: string;
			inputPath?: string;
			position?: number;
			name: string;
			mode: string;
			conditions?: { attribute: string; operator: string; value: string };
			/** SDK-shaped StreamPerTitleSettings (plain object; SDK maps it). */
			perTitleSettings?: Record<string, unknown>;
		},
	): Promise<string>;
	createDolbyVisionStreamHdr(
		encodingId: string,
		streamId: string,
		p: {
			profile: string;
			metadataSource: string;
			metadataInputStreamId?: string;
		},
	): Promise<string>;
	createMediaFilter(
		kind: import("@bitovp/core").MediaFilter["kind"],
		p: Record<string, unknown>,
	): Promise<string>;
	createDeinterlaceFilter(p: {
		parity: string;
		mode: string;
		frameSelectionMode: string;
		autoEnable: string;
	}): Promise<string>;
	/** Attaches an ordered filter chain; returns no own resource id. */
	createBurnInSrt(
		encodingId: string,
		streamId: string,
		p: { inputId: string; inputPath: string; characterEncoding: string },
	): Promise<string>;
	createStreamFilters(
		encodingId: string,
		streamId: string,
		filters: { id: string; position: number }[],
	): Promise<void>;
	createKeyframe(encodingId: string, p: { time: number }): Promise<string>;
	/**
	 * Kantar audio watermarking — an encoding-level SINGLETON (create acts as
	 * create-or-replace). login/password are the vaulted service credentials
	 * and are excluded from the audit snapshot.
	 */
	createKantarWatermark(
		encodingId: string,
		p: {
			/** Secret — excluded from the audit snapshot. */
			login: string;
			/** Secret — excluded from the audit snapshot. */
			password: string;
			licenseId: number;
			channelName: string;
			contentReference: string;
			serverUrl: string;
			report: Destination;
		},
	): Promise<string>;
	createNexGuardFileMarker(
		encodingId: string,
		streamId: string,
		p: {
			/** Secret — excluded from the audit snapshot. */
			license: string;
			watermarkType: string;
			preset?: string;
			strength?: string;
			payload?: number;
		},
	): Promise<string>;
	createThumbnail(
		encodingId: string,
		streamId: string,
		p: {
			height: number;
			pattern: string;
			unit: string;
			positions: number[];
			destination: Destination;
		},
	): Promise<string>;
	createSprite(
		encodingId: string,
		streamId: string,
		p: {
			width?: number;
			height?: number;
			distance: number;
			unit: string;
			hTiles?: number;
			vTiles?: number;
			imagesPerFile?: number;
			spriteName?: string;
			filename: string;
			vttName?: string;
			creationMode?: string;
			name?: string;
			destination: Destination;
		},
	): Promise<string>;
	createCmafMuxing(
		encodingId: string,
		p: {
			streamId: string;
			segmentLength: number;
			segmentNaming?: string;
			segmentNamingTemplate?: string;
			initSegmentName?: string;
			initSegmentNameTemplate?: string;
			framesPerCmafChunk?: number;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createFmp4Muxing(
		encodingId: string,
		p: {
			streamId: string;
			segmentLength: number;
			/**
			 * OPTIONAL, and the optionality is the fix (WP-C6, 2026-09-02): the
			 * compiler omits the literal when the plan carries a template, and
			 * the executor used to coerce that absence to `""` — an empty
			 * `segmentNaming` BESIDE `segmentNamingTemplate`, which the SDK
			 * forbids. Same on every segmented kind below.
			 */
			segmentNaming?: string;
			/**
			 * Placeholder policy — `{rand_chars:x}` / `{segment_rand_chars:x}`.
			 * Bitmovin expands it and copies the result into `segmentNaming`,
			 * so the two are mutually exclusive on the wire; the plan compiler
			 * sends whichever the plan declares. Writing a token into the
			 * literal field ships the braces verbatim (measured on a real
			 * Akamai MSL stream, ).
			 */
			segmentNamingTemplate?: string;
			initSegmentName: string;
			destination?: Destination;
			name?: string;
			/** SCTE-35 emsg boxes into the fMP4 segments (C14). */
			signalScte35AsEmsg?: boolean;
		},
	): Promise<string>;
	/**
	 * Progressive (single-file) WebM — the VP9 QC mirror's container (ledger
	 * #205). The provider refuses a VP9 progressive MP4 outright.
	 */
	createProgressiveWebmMuxing(
		encodingId: string,
		p: {
			streamId: string;
			filename: string;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createMp4Muxing(
		encodingId: string,
		p: {
			streamId: string;
			/**
			 * Streams multiplexed into these segments ALONGSIDE `streamId`.
			 *
			 * `Muxing.streams` has always been a `MuxingStream[]`; this wrapper
			 * hard-coded a one-element array, which is why a container could
			 * hold only one stream no matter what the plan said. Absent for
			 * every single-stream container, so the wire shape is unchanged.
			 */
			additionalStreamIds?: string[];
			filename: string;
			fragmentDuration?: number;
			fragmentedMP4MuxingManifestType?: string;
			dolbyVisionTrackSampleEntryName?: string;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createTsMuxing(
		encodingId: string,
		p: {
			streamId: string;
			/** Muxed-in streams — see createMp4Muxing. Absent = single stream. */
			additionalStreamIds?: string[];
			segmentLength: number;
			segmentNaming?: string;
			/**
			 * Placeholder policy — `{rand_chars:x}` / `{segment_rand_chars:x}`.
			 * Bitmovin expands it and copies the result into `segmentNaming`,
			 * so the two are mutually exclusive on the wire; the plan compiler
			 * sends whichever the plan declares. Writing a token into the
			 * literal field ships the braces verbatim (measured on a real
			 * Akamai MSL stream, ).
			 */
			segmentNamingTemplate?: string;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createWebmMuxing(
		encodingId: string,
		p: {
			streamId: string;
			segmentLength: number;
			segmentNaming?: string;
			/**
			 * Placeholder policy — `{rand_chars:x}` / `{segment_rand_chars:x}`.
			 * Bitmovin expands it and copies the result into `segmentNaming`,
			 * so the two are mutually exclusive on the wire; the plan compiler
			 * sends whichever the plan declares. Writing a token into the
			 * literal field ships the braces verbatim (measured on a real
			 * Akamai MSL stream, ).
			 */
			segmentNamingTemplate?: string;
			initSegmentName: string;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createTextMuxing(
		encodingId: string,
		p: {
			streamId: string;
			filename: string;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createChunkedTextMuxing(
		encodingId: string,
		p: {
			streamId: string;
			segmentLength: number;
			segmentNaming?: string;
			/**
			 * Placeholder policy — `{rand_chars:x}` / `{segment_rand_chars:x}`.
			 * Bitmovin expands it and copies the result into `segmentNaming`,
			 * so the two are mutually exclusive on the wire; the plan compiler
			 * sends whichever the plan declares. Writing a token into the
			 * literal field ships the braces verbatim (measured on a real
			 * Akamai MSL stream, ).
			 */
			segmentNamingTemplate?: string;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createCencDrm(
		encodingId: string,
		muxingId: string,
		p: {
			muxingKind: string;
			/** Secret — excluded from the audit snapshot. */
			key: string;
			kid: string;
			encryptionMode?: string;
			ivSize?: string;
			widevine?: { pssh?: string };
			playReady?: { laUrl?: string; pssh?: string };
			fairPlay?: { iv?: string; uri?: string };
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createSpekeDrm(
		encodingId: string,
		muxingId: string,
		p: {
			muxingKind: string;
			contentId?: string;
			kid?: string;
			iv?: string;
			systemIds: string[];
			provider: {
				url: string;
				username?: string;
				password?: string;
				apiKey?: string;
				roleArn?: string;
				gatewayRegion?: string;
				externalId?: string;
				externalIdMode?: string;
			};
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createFairPlayDrm(
		encodingId: string,
		muxingId: string,
		p: {
			muxingKind: string;
			/** Secret — excluded from the audit snapshot. */
			key: string;
			iv: string;
			uri: string;
			destination?: Destination;
			name?: string;
		},
	): Promise<string>;
	createHlsManifest(p: {
		manifestName: string;
		name: string;
		masterVersion?: string;
		mediaVersion?: string;
		destination: Destination;
	}): Promise<string>;
	/**
	 * DEFAULT manifests (the generator enumerates every muxing of the given
	 * encoding itself). Used by live-to-VOD: a stopped live encoding's
	 * recorded output becomes a VOD manifest with no per-rendition entries
	 * to build. `version` carries the SDK enum NAME (HLS: V1; DASH: V1|V2).
	 */
	createDefaultHlsManifest(p: {
		encodingId: string;
		manifestName: string;
		name: string;
		destination: Destination;
		version?: string;
		/** Live-to-VOD: lookup ambiguity/error blocks a billable create. */
		strictIdentity?: boolean;
		/** Reconciliation-only delivery: may adopt, must never POST. */
		allowCreate?: boolean;
	}): Promise<string>;
	createDefaultDashManifest(p: {
		encodingId: string;
		manifestName: string;
		name: string;
		destination: Destination;
		version?: string;
		/** Live-to-VOD: lookup ambiguity/error blocks a billable create. */
		strictIdentity?: boolean;
		/** Reconciliation-only delivery: may adopt, must never POST. */
		allowCreate?: boolean;
	}): Promise<string>;
	createHlsAudioMedia(
		manifestId: string,
		p: {
			name: string;
			groupId: string;
			language: string;
			isDefault?: boolean;
			autoselect?: boolean;
			segmentPath: string;
			uri: string;
			encodingId: string;
			streamId: string;
			muxingId: string;
			drmId?: string;
		},
	): Promise<string>;
	createHlsStreamInfo(
		manifestId: string,
		p: {
			/**
			 * Optional, as on the SDK model: a muxed self-contained variant has NO
			 * audio group, and the API doc says a present value MUST match an
			 * EXT-X-MEDIA GROUP-ID — so absence is the only correct spelling of
			 * "none".
			 */
			audio?: string;
			subtitles?: string;
			closedCaptions: string;
			segmentPath: string;
			uri: string;
			encodingId: string;
			streamId: string;
			muxingId: string;
			drmId?: string;
		},
	): Promise<string>;
	createHlsSubtitlesMedia(
		manifestId: string,
		p: {
			name: string;
			groupId: string;
			language: string;
			segmentPath: string;
			uri: string;
			encodingId: string;
			streamId: string;
			muxingId: string;
		},
	): Promise<string>;
	createHlsIframePlaylist(
		manifestId: string,
		streamInfoId: string,
		p: { filename: string },
	): Promise<string>;
	createDashManifest(p: {
		manifestName: string;
		name: string;
		profile?: string;
		destination: Destination;
	}): Promise<string>;
	/** Optional explicit start in seconds; omission preserves the provider default. */
	createDashPeriod(manifestId: string, start?: number): Promise<string>;
	createDashVideoAdaptationSet(
		manifestId: string,
		periodId: string,
		p?: { labels?: { value: string }[] },
	): Promise<string>;
	createDashAudioAdaptationSet(
		manifestId: string,
		periodId: string,
		p: { lang?: string; labels?: { value: string }[] },
	): Promise<string>;
	createDashSubtitleAdaptationSet(
		manifestId: string,
		periodId: string,
		p: { lang: string; labels?: { value: string }[] },
	): Promise<string>;
	createDashImscRepresentation(
		manifestId: string,
		periodId: string,
		adaptationSetId: string,
		p: { imscUrl: string },
	): Promise<string>;
	createDashChunkedTextRepresentation(
		manifestId: string,
		periodId: string,
		adaptationSetId: string,
		p: {
			type: string;
			segmentPath: string;
			encodingId: string;
			muxingId: string;
		},
	): Promise<string>;
	createDashFmp4Representation(
		manifestId: string,
		periodId: string,
		adaptationSetId: string,
		p: {
			type: string;
			mode?: string;
			segmentPath: string;
			encodingId: string;
			muxingId: string;
		},
	): Promise<string>;
	createDashCmafRepresentation(
		manifestId: string,
		periodId: string,
		adaptationSetId: string,
		p: {
			type: string;
			mode?: string;
			segmentPath: string;
			encodingId: string;
			muxingId: string;
		},
	): Promise<string>;
	createDashWebmRepresentation(
		manifestId: string,
		periodId: string,
		adaptationSetId: string,
		p: {
			type: string;
			segmentPath: string;
			encodingId: string;
			muxingId: string;
		},
	): Promise<string>;
	createDashMp4Representation(
		manifestId: string,
		periodId: string,
		adaptationSetId: string,
		p: {
			type: string;
			filePath: string;
			encodingId: string;
			muxingId: string;
		},
	): Promise<string>;
	createDashContentProtection(
		path: {
			manifestId: string;
			periodId: string;
			adaptationSetId: string;
			representationId: string;
			/** Which representation endpoint owns the child (URL differs). */
			representationKind: "FMP4" | "WEBM";
		},
		p: { drmId: string; encodingId: string; muxingId: string },
	): Promise<string>;
	createSmoothManifest(p: {
		serverManifestName: string;
		clientManifestName: string;
		name: string;
		destination: Destination;
	}): Promise<string>;
	createSmoothMp4Representation(
		manifestId: string,
		p: {
			mediaFile: string;
			language: string;
			trackName: string;
			encodingId: string;
			muxingId: string;
		},
	): Promise<string>;
	createSmoothContentProtection(
		manifestId: string,
		p: { drmId: string; encodingId: string; muxingId: string },
	): Promise<string>;
	startEncoding(
		encodingId: string,
		p: {
			manifestGenerator?: string;
			vodHlsManifestIds?: string[];
			vodDashManifestIds?: string[];
			vodSmoothManifestIds?: string[];
			/** JIT preview (watch-while-encoding) manifest lists. */
			previewHlsManifestIds?: string[];
			previewDashManifestIds?: string[];
			/** SDK-shaped PerTitle block (plain object; SDK maps it). */
			perTitle?: Record<string, unknown>;
			encodingMode?: string;
			/** StartEncodingRequest.tweaks.audioVideoSyncMode. */
			audioVideoSyncMode?: string;
			handleVariableInputFps?: boolean;
			aiSceneAnalysis?: AiSceneAnalysisParams;
			scheduling?: { priority?: number; prewarmedEncoderPoolIds?: string[] };
		},
	): Promise<void>;
	stopEncoding(encodingId: string): Promise<void>;
	getEncodingStatus(encodingId: string): Promise<TaskStatusResult>;
	/**
	 * The encoding's status messages with severity and timestamp — the only
	 * reason channel Bitmovin offers for a scheduled insertion that reached
	 * ERROR (the entry itself carries no text). Every message, unfiltered;
	 * `selectProviderFailureReason` does the attribution.
	 */
	getEncodingMessages(encodingId: string): Promise<EncodingMessage[]>;
	startHlsManifest(
		manifestId: string,
		p: { manifestGenerator?: string },
	): Promise<void>;
	getHlsManifestStatus(manifestId: string): Promise<TaskStatusResult>;
	/**
	 *  — live-to-VOD's terminal cleanup: a default manifest whose
	 * generation ended ERROR is deleted only after its id and DELETE_PENDING
	 * intent are durable, before another is created. Resolves on 404 too
	 * (already gone is the outcome wanted); the caller still performs readback.
	 */
	deleteHlsManifest(manifestId: string): Promise<void>;
	startDashManifest(
		manifestId: string,
		p: { manifestGenerator?: string },
	): Promise<void>;
	getDashManifestStatus(manifestId: string): Promise<TaskStatusResult>;
	deleteDashManifest(manifestId: string): Promise<void>;
	startSmoothManifest(
		manifestId: string,
		p: { manifestGenerator?: string },
	): Promise<void>;
	getSmoothManifestStatus(manifestId: string): Promise<TaskStatusResult>;
	/** All pages (limit 100 — C6) of one muxing kind, summarized. */
	listMuxings(encodingId: string, kind: AvMuxingKind): Promise<MuxingSummary[]>;
	getStreamContext(
		encodingId: string,
		streamId: string,
	): Promise<{ mode: string; codecConfigId: string }>;
	getVideoConfigBitrate(configId: string): Promise<number | undefined>;
	/**
	 * All pages (C6) of the encoding's streams — every mode, unfiltered. The
	 * per-title capture needs the TEMPLATE rows as well as the RESULT rows (the
	 * templates are what attribution matches against), so filtering here would
	 * throw away half the input. Stops at `SCAN_PAGE_CAP` and says so.
	 */
	listEncodingStreams(encodingId: string): Promise<ScanPage<ScannedStream>>;
	/**
	 * All pages (C6) of the encoding's muxings, kind-agnostic — the polymorphic
	 * list endpoint returns the `type` discriminant, which is what the snapshot
	 * records. Distinct from `listMuxings`, which takes one concrete kind because
	 * its caller needs kind-specific DRM sub-resources.
	 */
	listAllMuxings(encodingId: string): Promise<ScanPage<ScannedMuxing>>;
	/**
	 * The polymorphic codec-config read: `configurations.type.get` for the type,
	 * then the typed endpoint for the full parameter set. An unmapped type comes
	 * back as `{codecType, params: {}}` — never a throw, so one exotic codec
	 * cannot cost the whole ladder its snapshot.
	 */
	getCodecConfigDetail(
		configId: string,
	): Promise<{ codecType: string; params: Record<string, unknown> } | null>;
	listMuxingDrm(
		encodingId: string,
		muxingId: string,
		muxingKind: AvMuxingKind,
		drmKind: "CENC" | "FAIRPLAY" | "SPEKE",
	): Promise<{ id: string; outputPath?: string }[]>;
	// --- live (P3-PR2) ---
	/**
	 * The account's LIVE encodings in a non-terminal state, all pages (C6).
	 *
	 * READ-ONLY DISCOVERY, and that is the whole point . Four live
	 * encodings once billed for up to 7h19m while every `LiveChannel` row said
	 * STOPPED, and the only tool for it required a human to already KNOW the ids —
	 * `stop-orphan-live.ts` takes them as arguments, so nothing could find an orphan
	 * nobody had noticed. This is the missing half: ask Bitmovin what is actually
	 * running.
	 *
	 * It deliberately does NOT stop anything. A sweep that stops encodings our
	 * database cannot account for could stop the owner's own work, which is a
	 * blast-radius decision rather than a bug fix.
	 */
	listRunningLiveEncodings(): Promise<
		Array<{ id: string; name?: string; status: string; createdAt?: string }>
	>;
	/**
	 * All pages (C6) of the account's RTMP inputs — the resolve-by-list
	 * contract: the API has no POST /encoding/inputs/rtmp, accounts come
	 * pre-provisioned with a default input the executor picks.
	 */
	listRtmpInputs(): Promise<{ id: string; name?: string }[]>;
	/**
	 * Ground truth for a live-start failure: the inputId(s) actually baked into
	 * an encoding's ingest input streams. Bitmovin validates these at live/start
	 * (error 2025 names a missing one) — distinct from what we resolved into
	 * ctx.ids, so the diagnostic must read the encoding itself, not our own map.
	 */
	listIngestInputStreams(
		encodingId: string,
	): Promise<{ id: string; inputId?: string }[]>;
	createRedundantRtmpInput(p: RedundantRtmpInputParams): Promise<string>;
	createSrtInput(
		p: SrtConnectionParams & {
			name: string;
			backupSrtInputs?: {
				delayThreshold?: number;
				srtInputs: SrtConnectionParams[];
			};
		},
	): Promise<string>;
	createZixiInput(p: {
		name: string;
		host: string;
		port: number;
		stream: string;
		/** Secrets — excluded from the audit snapshot. */
		password?: string;
		decryptionKey?: string;
		latency?: number;
		minBitrate?: number;
		decryptionType?: string;
	}): Promise<string>;
	createHlsLiveInput(p: {
		name: string;
		url?: string;
		adMarkersSource?: string;
	}): Promise<string>;
	startLiveEncoding(
		encodingId: string,
		p: StartLiveEncodingParams,
	): Promise<void>;
	stopLiveEncoding(encodingId: string): Promise<void>;
	restartLiveEncoding(encodingId: string): Promise<void>;
	updateLiveRtmpIngestPoints(
		encodingId: string,
		ingestPoints: { applicationName: string; streamKey: string }[],
	): Promise<void>;
	getLiveEncodingDetails(encodingId: string): Promise<LiveEncodingDetails>;
	/** The submitted start request as plain JSON — the C7 snapshot source. */
	getLiveStartRequest(encodingId: string): Promise<unknown>;
	getLiveHeartbeat(encodingId: string): Promise<LiveHeartbeatSample>;
	resetLiveManifestTimeshift(
		encodingId: string,
		p: ResetLiveTimeshiftParams,
	): Promise<void>;
	insertScte35Cue(
		encodingId: string,
		p: Scte35CueParams,
	): Promise<{ id: string | null }>;
	/**  (slate insertion): schedule READY insertable content into the live
	    stream, immediately (runAt omitted ⇒ ASAP per the API contract). */
	/** : create slate content on the live encoding (adopt-by-name first). */
	createLiveInsertableContent(
		encodingId: string,
		p: {
			name: string;
			/** : the adopt marker + what the preparer did, readable in the panel's list. */
			description?: string;
			inputs: { inputId: string; inputPath: string }[];
		},
	): Promise<string>;
	/** Content status — READY is the fire gate. */
	getLiveInsertableContent(
		encodingId: string,
		contentId: string,
	): Promise<{ id: string; status: string }>;
	/**
	 * Every page (C6). `description` is where the direct registration route
	 * leaves a stood-down preflight (`preflight UNVERIFIED (…)`), so the fire
	 * path can name it when the insertion later fails.
	 */
	listLiveInsertableContent(encodingId: string): Promise<
		{
			id: string;
			name: string | null;
			status: string;
			description: string | null;
		}[]
	>;
	/**
	 * Schedules the insertion and returns the created entry's ID (null when the
	 * provider gives none). The id is what makes an insertion IDENTIFIABLE, so
	 * the slate guard can ask whether a live entry is one of OURS instead of
	 * subtracting two counts that decay at different rates (review-300).
	 */
	scheduleInsertableContent(
		encodingId: string,
		p: { contentId: string; durationSeconds: number },
	): Promise<string | null>;
	/**
	 * What the PROVIDER thinks is scheduled on this encoding .
	 *
	 * `scheduleInsertableContent` is a POST whose response can be lost while the
	 * provider has already accepted it — and the queue retries it up to five
	 * times. Without a way to ask, a lost response is indistinguishable from a
	 * rejection, and the retry inserts a SECOND slate over the program. This is
	 * the way to ask: `ScheduledInsertableContentStatus` is
	 * CREATED/SCHEDULED/TO_BE_DESCHEDULED/DESCHEDULED/ERROR, and the first two
	 * mean an insertion for that content is pending or live.
	 */
	listScheduledInsertableContent(encodingId: string): Promise<
		{
			id: string | null;
			contentId: string | null;
			status: string;
			createdAt: string | null;
		}[]
	>;
};

/**
 * What an op hands the recorder. `actor` is OPTIONAL here on purpose, while it
 * is required on the db-level writer : the ops do not each know
 * who acted, and `make-sdk.ts` supplies the worker's identity centrally for
 * every one of them. Requiring it at this layer would put the same constant in
 * 82 call sites and buy nothing — the bypass the requirement closes is a NEW
 * consumer of the exported db writer, not these.
 */
export type AuditRecorder = (
	entry: Omit<AuditEntry, "actor"> & { actor?: string | null },
) => Promise<void>;

import { createConfigOps } from "./ops/configs";
import type { OpsContext } from "./ops/context";
import { createDrmOps } from "./ops/drm";
import { createEncodingLifecycleOps } from "./ops/encoding";
import { createIoOps } from "./ops/io";
import { createLiveOps } from "./ops/live";
import { createManifestOps } from "./ops/manifests";
import { createMediaOps } from "./ops/media";
import {
	BitmovinCallError,
	bitmovinErrorText,
	isBitmovinError,
	ProviderResponseBarrierError,
} from "./ops/shared";

export { BitmovinCallError, sdkEnumValue } from "./ops/shared";

export type SdkOpsOptions = {
	internalHevcV2?: InternalHevcV2;
	apiKey: string;
	tenantOrgId?: string | null;
	bitmovinAccountId?: string;
	/** Internal orphan-only transport; refuses every call except status/STOP. */
	orphanStopOnly?: true;
	/**
	 * Idempotency stamp for create ops : when set, eligible
	 * create POSTs carry `customData: {"bitovp": {job, step}}` so a
	 * crash-resume duplicate is identifiable. Per-JOB: the SdkOps instance
	 * is built per job run (processor.ts), steps execute sequentially
	 * within it, so the mutable step slot cannot race.
	 */
	stamp?: CreateStamp;
};

export function createBitmovinSdkOps(
	options: SdkOpsOptions,
	record: AuditRecorder,
): SdkOps {
	if (options.internalHevcV2)
		assertInternalHevcV2Access(
			options.bitmovinAccountId,
			options.internalHevcV2,
		);
	const retrying = options.orphanStopOnly
		? createOrphanStopFetch()
		: createRetryingFetch();
	const api = new BitmovinApi({
		apiKey: options.apiKey,
		...(options.internalHevcV2
			? {
					headers: {
						"X-BITMOVIN-BCF-VERSION": options.internalHevcV2.bcfVersion,
					},
				}
			: {}),
		...(options.tenantOrgId ? { tenantOrgId: options.tenantOrgId } : {}),
		// A dropped connection must not kill a 26-step job. See retrying-fetch.ts:
		// only a fetch REJECTION is retried, never a response the API actually
		// sent. The stamping layer sits OUTSIDE the retrying layer so a retried
		// request carries the same stamp bytes.
		fetch: options.stamp
			? createStampingFetch(retrying, options.stamp)
			: retrying,
	});

	/** Audits one SDK call; `requestSnapshot` must already be secret-free. */
	async function audited<T>(
		method: string,
		path: string,
		requestSnapshot: unknown,
		fn: () => Promise<T>,
		responseSnapshot: (result: T) => unknown,
		beforeRecord?: (result: T) => Promise<void>,
	): Promise<T> {
		const startedAt = Date.now();
		// The recorder must never fail the call it documents.
		const safeRecord = async (entry: Parameters<AuditRecorder>[0]) => {
			try {
				await record(entry);
			} catch (recordErr) {
				console.error(
					"[sdk-ops] audit recorder failed:",
					recordErr instanceof Error ? recordErr.message : recordErr,
				);
			}
		};
		try {
			const result = await fn();
			if (beforeRecord) {
				try {
					await beforeRecord(result);
				} catch (barrierErr) {
					await safeRecord({
						method,
						path,
						statusCode: 200,
						durationMs: Date.now() - startedAt,
						bitmovinAccountId: options.bitmovinAccountId,
						request: requestSnapshot,
						response: responseSnapshot(result),
						error:
							typeof barrierErr === "object" &&
							barrierErr !== null &&
							"code" in barrierErr &&
							typeof barrierErr.code === "string"
								? barrierErr.code
								: "PROVIDER_RESPONSE_BARRIER_FAILED",
					});
					throw new ProviderResponseBarrierError(barrierErr);
				}
			}
			await safeRecord({
				method,
				path,
				statusCode: 200,
				durationMs: Date.now() - startedAt,
				bitmovinAccountId: options.bitmovinAccountId,
				request: requestSnapshot,
				response: responseSnapshot(result),
			});
			return result;
		} catch (err) {
			if (err instanceof ProviderResponseBarrierError) {
				// The response and barrier failure were recorded above. Do not emit a
				// second, misleading provider-call failure row.
				throw err;
			}
			const e = err as {
				httpStatusCode?: number;
				shortMessage?: string;
				requestId?: unknown;
				errorCode?: unknown;
			};
			// review-206 I2: the audit row is the store that OUTLIVES Bitmovin's
			// ~90-day purge (C7) — and it carried exactly the three facts the
			// start-1004 investigation stalled on. The requestId (clamped to
			// the opaque shape) + errorCode now ride `response`, which is
			// unused on the failure path.
			const auditRequestId =
				typeof e.requestId === "string" && /^[\w.:-]{1,128}$/.test(e.requestId)
					? e.requestId
					: undefined;
			await safeRecord({
				method,
				path,
				statusCode: e.httpStatusCode,
				durationMs: Date.now() - startedAt,
				bitmovinAccountId: options.bitmovinAccountId,
				request: requestSnapshot,
				...(auditRequestId !== undefined || typeof e.errorCode === "number"
					? {
							response: {
								...(auditRequestId !== undefined
									? { requestId: auditRequestId }
									: {}),
								...(typeof e.errorCode === "number"
									? { errorCode: e.errorCode }
									: {}),
							},
						}
					: {}),
				error: bitmovinErrorText(err),
			});
			// SECURITY: the SDK builds BitmovinError.message by concatenating the
			// raw REQUEST BODY into it (BitmovinErrorBuilder.appendRequestMessage
			// — "  body: <json>"). Every secret-bearing call therefore produces an
			// error string containing that secret in plaintext: storage keys,
			// SRT passphrases, Zixi passwords, DRM content keys, the POIS pair.
			// Those strings are persisted verbatim (step-log entry.error, the
			// job/channel error columns) and `redactSecrets` on a bare STRING
			// masks only URL userinfo — so the raw error must never escape this
			// facade. Rethrow the API's own curated text instead (mirrors the web
			// layer's bitmovinErrorMessage); non-Bitmovin errors are ours and
			// carry no request body, so they pass through untouched.
			if (isBitmovinError(err)) {
				throw new BitmovinCallError(method, path, err);
			}
			throw err;
		}
	}

	/** C7 trail for a stamped adoption (the manifest precedent, review #164 I4:
	    an adopted resource must not leave ZERO audit rows). */
	const stampAuditAdopt =
		(path: string) => (adoptedId: string, phase: "pre" | "post-failure") =>
			record({
				method: "GET",
				path,
				statusCode: 200,
				durationMs: 0,
				bitmovinAccountId: options.bitmovinAccountId,
				request: { phase, stamped: true },
				response: { id: adoptedId },
			});

	const id = (r: { id?: string }) => {
		if (!r.id) {
			throw new Error("Bitmovin response carried no id");
		}
		return r.id;
	};

	const muxings = () => api.encoding.encodings.muxings;

	/**
	 * The per-title capture's reads, implemented once in core. `api` satisfies
	 * core's structural `EncodingApiSubset` by shape — no SDK import crosses into
	 * the domain package.
	 */
	const capturePort = bitmovinCapturePort(api);

	const ctx: OpsContext = {
		api,
		options,
		record,
		audited,
		stampAuditAdopt,
		id,
		muxings,
		capturePort,
	};

	return {
		...createIoOps(ctx),
		...createConfigOps(ctx),
		...createMediaOps(ctx),
		...createDrmOps(ctx),
		...createManifestOps(ctx),
		...createEncodingLifecycleOps(ctx),
		...createLiveOps(ctx),
	};
}
