import { stringify } from "yaml";
import { h26xPictureControls } from "./codec-controls";
import {
	joinFilePath,
	relativeFilePath,
	relativeSegmentPath,
} from "./compiler";
import { dashAudioLegSelected, dashVideoLegSelected } from "./dash-legs";
import { hlsSubtitleGroups } from "./hls-media-defaults";
import { FILTER_ENDPOINTS, filterParameters } from "./media-filters";
import { muxingStreamKeys } from "./muxing-streams";
import type { EncodingPlan } from "./schema";
import { AUDIO_CODECS } from "./schema";
import { SRT_CHARACTER_ENCODING_VALUES } from "./srt-character-encodings";

/**
 * Exports an EncodingPlan as a Bitmovin Encoding Template (YAML) — the
 * structure mirrors the Java-SDK hierarchy with `$/section/.../name`
 * references, per developer.bitmovin.com/encoding/docs/encoding-templates.
 *
 * Deliberate properties of the export:
 * - DRAFT SUBSET: covers the P1 plan surface; validate against the
 *   official JSON schema before submitting to the API (link in header).
 * - Secrets never leave the vault: credential material is emitted as
 *   {{PLACEHOLDER}} variables derived from the plan keys.
 * - POST_ENCODING timing is not representable in templates (a template
 *   start is immediate); those plans export manifests for reference and a
 *   header comment says so.
 */

const ENCODING_NAME = "main";

/**
 * Templates take WIRE values where plans store SDK enum NAMES (the
 * orchestrator translates via sdkEnumValue at runtime). core is
 * client-shared and cannot import the SDK, so the divergent enums are
 * hand-extracted from @bitmovin/api-sdk 1.269.0 — same approach as
 * BITMOVIN_CLOUD_REGIONS. Unknown names pass through unchanged.
 */
const AAC_CHANNEL_LAYOUT_WIRE: Record<string, string> = {
	NONE: "NONE",
	MONO: "MONO",
	CL_STEREO: "STEREO",
	CL_SURROUND: "SURROUND",
	CL_4_0: "4.0",
	CL_5_0_BACK: "5.0_BACK",
	CL_5_1_BACK: "5.1_BACK",
	CL_7_1: "7.1",
	CL_7_1_WIDE_BACK: "7.1_WIDE_BACK",
};

const HLS_VERSION_WIRE: Record<string, string> = {
	HLS_V3: "3",
	HLS_V4: "4",
	HLS_V5: "5",
	HLS_V6: "6",
	HLS_V7: "7",
	HLS_V8: "8",
};

const CONDITION_OPERATOR_WIRE: Record<string, string> = {
	EQUAL: "==",
	NOT_EQUAL: "!=",
	LESS_THAN: "<",
	LESS_THAN_OR_EQUAL: "<=",
	GREATER_THAN: ">",
	GREATER_THAN_OR_EQUAL: ">=",
};

const PROFILE_H265_WIRE: Record<string, string> = {
	MAIN: "main",
	MAIN10: "main10",
};

const TU_DEPTH_WIRE: Record<string, string> = {
	D1: "1",
	D2: "2",
	D3: "3",
	D4: "4",
};

const MAX_CTU_SIZE_WIRE: Record<string, string> = {
	S16: "16",
	S32: "32",
	S64: "64",
};

/** DolbyDigital[Plus]ChannelLayout — distinct from AAC's (3.1/QUAD/5.1 vs 4.0/5.1_BACK/7.1). */
const DOLBY_DIGITAL_CHANNEL_LAYOUT_WIRE: Record<string, string> = {
	NONE: "NONE",
	MONO: "MONO",
	CL_STEREO: "STEREO",
	CL_SURROUND: "SURROUND",
	CL_3_1: "3.1",
	CL_BACK_SURROUND: "BACK_SURROUND",
	CL_BACK_SURROUND_LFE: "BACK_SURROUND_LFE",
	CL_QUAD: "QUAD",
	CL_QUAD_LFE: "QUAD_LFE",
	CL_4_0: "4.0",
	CL_4_1: "4.1",
	CL_5_0: "5.0",
	CL_5_1: "5.1",
};

const METERING_MODE_WIRE: Record<string, string> = {
	ITU_R_BS_1770_1: "ITU-R BS.1770-1",
	ITU_R_BS_1770_2: "ITU-R BS.1770-2",
	ITU_R_BS_1770_3: "ITU-R BS.1770-3",
	ITU_R_BS_1770_4: "ITU-R BS.1770-4",
	LEQ_A: "Leq (A)",
};

const IV_SIZE_WIRE: Record<string, string> = {
	IV_8_BYTES: "8_BYTES",
	IV_16_BYTES: "16_BYTES",
};

function wire(map: Record<string, string>, name: string): string {
	return map[name] ?? name;
}

/** Plan unions widen per phase — fail loudly when this exporter lags. */
function unreachable(variant: never): never {
	throw new Error(
		`Template exporter: unhandled plan variant ${JSON.stringify(variant)}`,
	);
}

/**
 * Placeholders are section-prefixed because key uniqueness is only
 * enforced within each collection (an input and an output may both be
 * named "main").
 */
function placeholder(
	section: "INPUT" | "OUTPUT" | "DRM",
	key: string,
	suffix: string,
): string {
	return `{{${section}_${key.toUpperCase().replaceAll("-", "_")}_${suffix}}}`;
}

type Tree = Record<string, unknown>;

/** Template muxing section per plan muxing kind. */
const MUXING_SECTION = {
	FMP4: "fmp4",
	CMAF: "cmaf",
	MP4: "mp4",
	CHUNKED_TEXT: "chunkedText",
	TEXT: "text",
	TS: "ts",
	WEBM: "webm",
} as const;

type AnyRendition = EncodingPlan["renditions"][number];

function isVideoCodec(
	rendition: AnyRendition,
): rendition is Extract<
	AnyRendition,
	{ codec: "H264" | "H265" | "VP9" | "AV1" }
> {
	return (
		rendition.codec === "H264" ||
		rendition.codec === "H265" ||
		rendition.codec === "VP9" ||
		rendition.codec === "AV1"
	);
}

function isAudioCodec(
	rendition: AnyRendition,
): rendition is Extract<
	AnyRendition,
	{ codec: "AAC" | "OPUS" | "DOLBY_ATMOS" | "DDPLUS" | "DD" }
> {
	return (
		rendition.codec === "AAC" ||
		rendition.codec === "OPUS" ||
		rendition.codec === "DOLBY_ATMOS" ||
		rendition.codec === "DDPLUS" ||
		rendition.codec === "DD"
	);
}

function isPerTitle(rendition: AnyRendition): boolean {
	return isVideoCodec(rendition) && rendition.mode.startsWith("PER_TITLE");
}

/**
 * Strip undefined AND null entries: templates express "unset" by omission
 * (the official schema types every field non-null), while ops keep
 * explicit nulls where the python samples pass None.
 */
function dense(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
	);
}

function buildTemplate(plan: EncodingPlan): Tree {
	// Key-derived placeholder names can collide ("a-b" vs "a_b") — with DRM
	// keys in play a silent merge would unify two content keys. Fail loudly.
	const usedPlaceholders = new Set<string>();
	const ph = (
		section: "INPUT" | "OUTPUT" | "DRM",
		key: string,
		suffix: string,
	): string => {
		const name = placeholder(section, key, suffix);
		if (usedPlaceholders.has(name)) {
			throw new Error(`Template placeholder collision: ${name}`);
		}
		usedPlaceholders.add(name);
		return name;
	};
	/**
	 * Literal placeholder for a plan-ROOT singleton, where the
	 * {{SECTION_KEY_SUFFIX}} shape has no key to carry: Kantar is one config
	 * per plan, so {{KANTAR_LOGIN}}/{{KANTAR_PASSWORD}} are the honest names.
	 * Still routed through the same collision registry so a future singleton
	 * cannot silently reuse a name (review catch m1 — these were the only
	 * placeholders bypassing it).
	 */
	const phLiteral = (name: string): string => {
		if (usedPlaceholders.has(name)) {
			throw new Error(`Template placeholder collision: ${name}`);
		}
		usedPlaceholders.add(name);
		return name;
	};
	// Multi-encoding plans render one encodings.<key> section each; the
	// implicit single encoding keeps the legacy "main" name.
	const encNames = plan.encodings?.length
		? plan.encodings.map((e) => e.key)
		: [ENCODING_NAME];
	const renditionEnc = new Map(
		plan.renditions.map((r) => [
			r.key,
			plan.encodings?.length
				? (r.encodingKey ?? encNames[0] ?? ENCODING_NAME)
				: ENCODING_NAME,
		]),
	);
	const encName = (renditionKey: string): string =>
		renditionEnc.get(renditionKey) ?? encNames[0] ?? ENCODING_NAME;
	const perEnc = <T extends Tree>(store: Map<string, T>, name: string): T => {
		let tree = store.get(name);
		if (!tree) {
			tree = {} as T;
			store.set(name, tree);
		}
		return tree;
	};

	const inputsS3: Tree = {};
	const inputsAzure: Tree = {};
	const inputsHttps: Tree = {};
	const inputsGenericS3: Tree = {};
	const inputsGcs: Tree = {};
	const inputsGcsServiceAccount: Tree = {};
	const inputsAkamaiNetStorage: Tree = {};
	const inputRef = new Map<string, string>();
	for (const input of plan.inputs) {
		if (input.kind === "S3") {
			inputsS3[input.key] = {
				properties: {
					name: input.name,
					bucketName: input.bucket,
					accessKey: ph("INPUT", input.key, "ACCESS_KEY"),
					secretKey: ph("INPUT", input.key, "SECRET_KEY"),
				},
			};
			inputRef.set(input.key, `$/inputs/s3/${input.key}`);
		} else if (input.kind === "HTTPS") {
			inputsHttps[input.key] = {
				properties: { name: input.name, host: input.host },
			};
			inputRef.set(input.key, `$/inputs/https/${input.key}`);
		} else if (input.kind === "AZURE") {
			inputsAzure[input.key] = {
				properties: {
					name: input.name,
					accountName: ph("INPUT", input.key, "ACCOUNT_NAME"),
					accountKey: ph("INPUT", input.key, "ACCOUNT_KEY"),
					container: input.container,
				},
			};
			inputRef.set(input.key, `$/inputs/azure/${input.key}`);
		} else if (input.kind === "GENERIC_S3") {
			// Host/port/signing are credential-resolved at our execution; in an
			// exported template the operator supplies them as placeholders (C10).
			inputsGenericS3[input.key] = {
				properties: {
					name: input.name,
					bucketName: input.bucket,
					host: ph("INPUT", input.key, "HOST"),
					accessKey: ph("INPUT", input.key, "ACCESS_KEY"),
					secretKey: ph("INPUT", input.key, "SECRET_KEY"),
				},
			};
			inputRef.set(input.key, `$/inputs/genericS3/${input.key}`);
		} else if (input.kind === "GCS") {
			inputsGcs[input.key] = {
				properties: {
					name: input.name,
					bucketName: input.bucket,
					...(input.region !== undefined ? { cloudRegion: input.region } : {}),
					accessKey: ph("INPUT", input.key, "ACCESS_KEY"),
					secretKey: ph("INPUT", input.key, "SECRET_KEY"),
				},
			};
			inputRef.set(input.key, `$/inputs/gcs/${input.key}`);
		} else if (input.kind === "GCS_SERVICE_ACCOUNT") {
			inputsGcsServiceAccount[input.key] = {
				properties: {
					name: input.name,
					bucketName: input.bucket,
					...(input.region !== undefined ? { cloudRegion: input.region } : {}),
					serviceAccountCredentials: ph(
						"INPUT",
						input.key,
						"SERVICE_ACCOUNT_JSON",
					),
				},
			};
			inputRef.set(input.key, `$/inputs/gcsServiceAccount/${input.key}`);
		} else if (input.kind === "AKAMAI_NETSTORAGE") {
			// . host/username/password are vault material, so the
			// template carries placeholders for all three — unlike MSL, whose
			// identity is not secret.
			inputsAkamaiNetStorage[input.key] = {
				properties: {
					name: input.name,
					host: ph("INPUT", input.key, "NETSTORAGE_HOST"),
					username: ph("INPUT", input.key, "NETSTORAGE_USERNAME"),
					password: ph("INPUT", input.key, "NETSTORAGE_PASSWORD"),
				},
			};
			inputRef.set(input.key, `$/inputs/akamaiNetstorage/${input.key}`);
		} else {
			unreachable(input);
		}
	}

	const outputsS3: Tree = {};
	const outputsAzure: Tree = {};
	const outputsSftp: Tree = {};
	const outputsGenericS3: Tree = {};
	const outputsGcs: Tree = {};
	const outputsGcsServiceAccount: Tree = {};
	const outputsAkamaiMsl: Tree = {};
	const outputsAkamaiNetStorage: Tree = {};
	const outputRef = new Map<string, string>();
	for (const output of plan.outputs) {
		if (output.kind === "AZURE") {
			outputsAzure[output.key] = {
				properties: {
					name: output.name,
					accountName: ph("OUTPUT", output.key, "ACCOUNT_NAME"),
					accountKey: ph("OUTPUT", output.key, "ACCOUNT_KEY"),
					container: output.container,
				},
			};
			outputRef.set(output.key, `$/outputs/azure/${output.key}`);
		} else if (output.kind === "S3") {
			outputsS3[output.key] = {
				properties: {
					name: output.name,
					bucketName: output.bucket,
					accessKey: ph("OUTPUT", output.key, "ACCESS_KEY"),
					secretKey: ph("OUTPUT", output.key, "SECRET_KEY"),
				},
			};
			outputRef.set(output.key, `$/outputs/s3/${output.key}`);
		} else if (output.kind === "SFTP") {
			outputsSftp[output.key] = {
				properties: {
					name: output.name,
					host: ph("OUTPUT", output.key, "SFTP_HOST"),
					port: ph("OUTPUT", output.key, "SFTP_PORT"),
					username: ph("OUTPUT", output.key, "SFTP_USERNAME"),
					password: ph("OUTPUT", output.key, "SFTP_PASSWORD"),
				},
			};
			outputRef.set(output.key, `$/outputs/sftp/${output.key}`);
		} else if (output.kind === "GENERIC_S3") {
			outputsGenericS3[output.key] = {
				properties: {
					name: output.name,
					bucketName: output.bucket,
					host: ph("OUTPUT", output.key, "HOST"),
					accessKey: ph("OUTPUT", output.key, "ACCESS_KEY"),
					secretKey: ph("OUTPUT", output.key, "SECRET_KEY"),
				},
			};
			outputRef.set(output.key, `$/outputs/genericS3/${output.key}`);
		} else if (output.kind === "GCS") {
			outputsGcs[output.key] = {
				properties: {
					name: output.name,
					bucketName: output.bucket,
					...(output.region !== undefined
						? { cloudRegion: output.region }
						: {}),
					accessKey: ph("OUTPUT", output.key, "ACCESS_KEY"),
					secretKey: ph("OUTPUT", output.key, "SECRET_KEY"),
				},
			};
			outputRef.set(output.key, `$/outputs/gcs/${output.key}`);
		} else if (output.kind === "GCS_SERVICE_ACCOUNT") {
			outputsGcsServiceAccount[output.key] = {
				properties: {
					name: output.name,
					bucketName: output.bucket,
					...(output.region !== undefined
						? { cloudRegion: output.region }
						: {}),
					serviceAccountCredentials: ph(
						"OUTPUT",
						output.key,
						"SERVICE_ACCOUNT_JSON",
					),
				},
			};
			outputRef.set(output.key, `$/outputs/gcsServiceAccount/${output.key}`);
		} else if (output.kind === "AKAMAI_MSL") {
			// This block described the pre-2026-08-19 shape — no placeholders,
			// because the identity was plan literals rather than vault material
			// — while the lines below it already emitted placeholders.
			// Corrected 2026-08-25 along with the same stale claim in
			// compiler.ts, exec-io.ts, manifest-links.ts, playback-links.ts,
			// en.ts and schema.ts: seven sites, found by pattern rather than by
			// memory after review caught two of them.
			outputsAkamaiMsl[output.key] = {
				properties: {
					name: output.name,
					// Placeholders now: the identity is vault material like
					// every other output's, so a shared template must not carry
					// one customer's provisioned stream .
					streamId: ph("OUTPUT", output.key, "MSL_STREAM_ID"),
					eventName: ph("OUTPUT", output.key, "MSL_EVENT_NAME"),
					streamFormat: output.streamFormat,
					mslVersion: output.mslVersion,
					// MSL5's Digest publishing pair — , review S6.
					//
					// The pair is NOT in the plan (it lives in the AKAMAI_MSL
					// credential's secret and the executor injects it), so
					// nothing here can leak it. But an exported template that
					// omits the field entirely is not REPRODUCIBLE: an operator
					// importing it gets a channel that publishes
					// unauthenticated, silently — the same state rail 3b warns
					// about, arrived at by omission instead of by an empty
					// vault. The NetStorage neighbour below shows the shape;
					// placeholders are how this file says "supply your own".
					//
					// MSL4 gets nothing, because Bitmovin REJECTS the field
					// there ("The MSL5-only field publishingAuthentication
					// cannot be set on MSL4 outputs", the vendor's own test
					// asserts the message) — emitting a placeholder an importer
					// would dutifully fill is how you hand someone a 400.
					...(output.mslVersion === "MSL5"
						? {
								publishingAuthentication: {
									enabled: true,
									username: ph("OUTPUT", output.key, "MSL_PUBLISHING_USERNAME"),
									password: ph("OUTPUT", output.key, "MSL_PUBLISHING_PASSWORD"),
								},
							}
						: {}),
				},
			};
			outputRef.set(output.key, `$/outputs/akamaiMsl/${output.key}`);
		} else if (output.kind === "LIVE_MEDIA_INGEST") {
			throw new Error(
				"Live Media Ingest uses an encrypted publishing-point credential; export the bitovp plan instead",
			);
		} else if (output.kind === "AKAMAI_NETSTORAGE") {
			outputsAkamaiNetStorage[output.key] = {
				properties: {
					name: output.name,
					host: ph("OUTPUT", output.key, "NETSTORAGE_HOST"),
					username: ph("OUTPUT", output.key, "NETSTORAGE_USERNAME"),
					password: ph("OUTPUT", output.key, "NETSTORAGE_PASSWORD"),
				},
			};
			outputRef.set(output.key, `$/outputs/akamaiNetstorage/${output.key}`);
		} else {
			unreachable(output);
		}
	}

	const h264: Tree = {};
	const h265: Tree = {};
	const vp9: Tree = {};
	const av1: Tree = {};
	const aac: Tree = {};
	const opus: Tree = {};
	const imsc: Tree = {};
	const dolbyAtmos: Tree = {};
	const ddPlus: Tree = {};
	const dd: Tree = {};
	const webvtt: Tree = {};
	const codecRef = new Map<string, string>();
	for (const rendition of plan.renditions) {
		if (rendition.codec === "IMSC") {
			imsc[rendition.key] = {
				properties: dense({ styling: rendition.styling }),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/subtitles/imsc/${rendition.key}`,
			);
			continue;
		}
		if (rendition.codec === "WEBVTT") {
			webvtt[rendition.key] = { properties: {} };
			codecRef.set(
				rendition.key,
				`$/configurations/subtitles/webvtt/${rendition.key}`,
			);
			continue;
		}
		if (rendition.codec === "H265") {
			h265[rendition.key] = {
				properties: dense({
					encodingMode: rendition.encodingMode,
					...h26xPictureControls(rendition),
					width: rendition.width,
					bframes: rendition.bframes,
					refFrames: rendition.refFrames,
					qp: rendition.qp,
					qpMax: rendition.qpMax,
					strictCbr: rendition.strictCbr,
					crf: rendition.crf,
					minBitrate: rendition.minBitrate,
					name: rendition.name,
					profile: rendition.profile
						? wire(PROFILE_H265_WIRE, rendition.profile)
						: undefined,
					height: rendition.height,
					bitrate: rendition.bitrate,
					// DRF/preset enum NAMES are the wire values per the schema.
					dynamicRangeFormat: rendition.dynamicRangeFormat,
					maxBitrate: rendition.maxBitrate,
					bufsize: rendition.bufsize,
					presetConfiguration: rendition.presetConfiguration,
					levelHighTier: rendition.levelHighTier,
					level: rendition.level,
					pixelFormat: rendition.pixelFormat,
					rate: rendition.rate,
					minKeyframeInterval: rendition.minKeyframeInterval,
					maxKeyframeInterval: rendition.maxKeyframeInterval,
					rcLookahead: rendition.rcLookahead,
					subMe: rendition.subMe,
					// REST/schema field really is capital-CTU.
					maxCTUSize: rendition.maxCtuSize
						? wire(MAX_CTU_SIZE_WIRE, rendition.maxCtuSize)
						: undefined,
					motionSearch: rendition.motionSearch,
					tuIntraDepth: rendition.tuIntraDepth
						? wire(TU_DEPTH_WIRE, rendition.tuIntraDepth)
						: undefined,
					tuInterDepth: rendition.tuInterDepth
						? wire(TU_DEPTH_WIRE, rendition.tuInterDepth)
						: undefined,
					weightPredictionOnPSlice: rendition.weightPredictionOnPSlice,
					weightPredictionOnBSlice: rendition.weightPredictionOnBSlice,
					sceneCutThreshold: rendition.sceneCutThreshold,
					motionSearchRange: rendition.motionSearchRange,
					adaptiveQuantizationMode: rendition.adaptiveQuantizationMode,
					adaptiveQuantizationStrength: rendition.adaptiveQuantizationStrength,
					psyRateDistortionOptimization:
						rendition.psyRateDistortionOptimization,
					psyRateDistortionOptimizedQuantization:
						rendition.psyRateDistortionOptimizedQuantization,
					qpMin: rendition.qpMin,
					sao: rendition.sao,
					hdr: rendition.hdr,
					masterDisplay: rendition.masterDisplay,
					maxContentLightLevel: rendition.maxContentLightLevel,
					maxPictureAverageLightLevel: rendition.maxPictureAverageLightLevel,
					colorConfig: rendition.colorConfig
						? dense({ ...rendition.colorConfig })
						: undefined,
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/video/h265/${rendition.key}`,
			);
			continue;
		}
		if (rendition.codec === "VP9") {
			vp9[rendition.key] = {
				properties: dense({
					encodingMode: rendition.encodingMode,
					name: rendition.name,
					height: rendition.height,
					bitrate: rendition.bitrate,
					rate: rendition.rate,
					cpuUsed: rendition.cpuUsed,
					tileColumns: rendition.tileColumns,
					qpMin: rendition.qpMin,
					qpMax: rendition.qpMax,
					rateUndershootPct: rendition.rateUndershootPct,
					rateOvershootPct: rendition.rateOvershootPct,
					quality: rendition.quality,
					lossless: rendition.lossless,
					aqMode: rendition.aqMode,
					arnrType: rendition.arnrType,
					arnrMaxFrames: rendition.arnrMaxFrames,
					arnrStrength: rendition.arnrStrength,
					colorConfig: rendition.colorConfig
						? dense({ ...rendition.colorConfig })
						: undefined,
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/video/vp9/${rendition.key}`,
			);
			continue;
		}
		if (rendition.codec === "AV1") {
			av1[rendition.key] = {
				properties: dense({
					encodingMode: rendition.encodingMode,
					name: rendition.name,
					height: rendition.height,
					bitrate: rendition.bitrate,
					rate: rendition.rate,
					// Av1PresetConfiguration / AutoLevelSetup enum NAMES are the
					// wire values per the schema.
					presetConfiguration: rendition.presetConfiguration,
					autoLevelSetup: rendition.autoLevelSetup,
					dynamicRangeFormat: rendition.dynamicRangeFormat,
					colorConfig: rendition.colorConfig
						? dense({ ...rendition.colorConfig })
						: undefined,
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/video/av1/${rendition.key}`,
			);
			continue;
		}
		if (rendition.codec === "H264") {
			h264[rendition.key] = {
				properties: dense({
					encodingMode: rendition.encodingMode,
					...h26xPictureControls(rendition),
					width: rendition.width,
					crf: rendition.crf,
					minBitrate: rendition.minBitrate,
					maxBitrate: rendition.maxBitrate,
					bufsize: rendition.bufsize,
					name: rendition.name,
					height: rendition.height,
					bitrate: rendition.bitrate,
					level: rendition.level,
					presetConfiguration: rendition.presetConfiguration,
					profile: rendition.profile,
					rate: rendition.rate,
					minKeyframeInterval: rendition.minKeyframeInterval,
					maxKeyframeInterval: rendition.maxKeyframeInterval,
					slices: rendition.slices,
					trellis: rendition.trellis,
					mvSearchRangeMax: rendition.mvSearchRangeMax,
					rcLookahead: rendition.rcLookahead,
					subMe: rendition.subMe,
					motionEstimationMethod: rendition.motionEstimationMethod,
					sceneCutThreshold: rendition.sceneCutThreshold,
					adaptiveQuantizationMode: rendition.adaptiveQuantizationMode,
					adaptiveQuantizationStrength: rendition.adaptiveQuantizationStrength,
					mvPredictionMode: rendition.mvPredictionMode,
					psyRateDistortionOptimization:
						rendition.psyRateDistortionOptimization,
					psyTrellis: rendition.psyTrellis,
					refFrames: rendition.refFrames,
					bframes: rendition.bframes,
					cabac: rendition.cabac,
					adaptiveSpatialTransform: rendition.adaptiveSpatialTransform,
					// WeightedPredictionPFrames NAME = wire per the schema.
					weightedPredictionPFrames: rendition.weightedPredictionPFrames,
					colorConfig: rendition.colorConfig
						? dense({ ...rendition.colorConfig })
						: undefined,
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/video/h264/${rendition.key}`,
			);
		} else if (rendition.codec === "OPUS") {
			const wireLayouts: Record<string, string> = {
				CL_STEREO: "STEREO",
				CL_SURROUND: "SURROUND",
				CL_QUAD: "QUAD",
				CL_4_1: "4.1",
				CL_5_0_BACK: "5.0_BACK",
				XCL_5_1_BACK: "5.1_BACK",
				CL_6_1: "6.1",
				CL_7_1: "7.1",
			};
			opus[rendition.key] = {
				properties: dense({
					name: rendition.name,
					bitrate: rendition.bitrate,
					rate: rendition.rate,
					channelLayout: wire(wireLayouts, rendition.channelLayout),
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/audio/opus/${rendition.key}`,
			);
		} else if (rendition.codec === "AAC") {
			aac[rendition.key] = {
				properties: {
					...(rendition.name ? { name: rendition.name } : {}),
					bitrate: rendition.bitrate,
					rate: rendition.rate,
					channelLayout: wire(AAC_CHANNEL_LAYOUT_WIRE, rendition.channelLayout),
				},
			};
			codecRef.set(
				rendition.key,
				`$/configurations/audio/aac/${rendition.key}`,
			);
		} else if (rendition.codec === "DOLBY_ATMOS") {
			dolbyAtmos[rendition.key] = {
				properties: dense({
					name: rendition.name,
					bitrate: rendition.bitrate,
					rate: rendition.rate,
					loudnessControl: {
						meteringMode: wire(
							METERING_MODE_WIRE,
							rendition.loudnessControl.meteringMode,
						),
						dialogueIntelligence:
							rendition.loudnessControl.dialogueIntelligence,
						speechThreshold: rendition.loudnessControl.speechThreshold,
					},
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/audio/dolbyAtmos/${rendition.key}`,
			);
		} else if (rendition.codec === "DDPLUS") {
			ddPlus[rendition.key] = {
				properties: dense({
					name: rendition.name,
					bitrate: rendition.bitrate,
					rate: rendition.rate,
					channelLayout: wire(
						DOLBY_DIGITAL_CHANNEL_LAYOUT_WIRE,
						rendition.channelLayout,
					),
					// Required by the template schema; empty = API defaults
					// (the samples never set DD/DDP loudness control).
					loudnessControl: {},
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/audio/dolbyDigitalPlus/${rendition.key}`,
			);
		} else if (rendition.codec === "DD") {
			dd[rendition.key] = {
				properties: dense({
					name: rendition.name,
					bitrate: rendition.bitrate,
					rate: rendition.rate,
					channelLayout: wire(
						DOLBY_DIGITAL_CHANNEL_LAYOUT_WIRE,
						rendition.channelLayout,
					),
					// Required by the template schema; empty = API defaults
					// (the samples never set DD/DDP loudness control).
					loudnessControl: {},
				}),
			};
			codecRef.set(
				rendition.key,
				`$/configurations/audio/dolbyDigital/${rendition.key}`,
			);
		} else {
			unreachable(rendition);
		}
	}

	const ingestByKey = new Map(plan.ingest.map((s) => [s.key, s]));
	const fileByKey = new Map(plan.fileStreams.map((f) => [f.key, f]));
	const dolbyByKey = new Map(plan.dolbyStreams.map((d) => [d.key, d]));

	// FileInputStreams are named template resources (the typed entry keeps
	// fileType); streams reference them via $/ refs.
	const fileInputStreamsByEnc = new Map<string, Tree>();
	for (const file of plan.fileStreams) {
		const owner = plan.encodings?.length
			? (file.encodingKey ?? encNames[0] ?? ENCODING_NAME)
			: ENCODING_NAME;
		perEnc(fileInputStreamsByEnc, owner)[file.key] = {
			properties: {
				inputId: inputRef.get(file.inputKey),
				inputPath: file.inputPath,
				fileType: file.fileType,
			},
		};
	}

	// Dolby input streams are named template resources too: schema sections
	// inputStreams.dolbyAtmos / .dolbyVision / .sidecar.dolbyVisionMetadataIngest.
	const dolbyAtmosByEnc = new Map<string, Tree>();
	const dolbyVisionByEnc = new Map<string, Tree>();
	const dolbySidecarByEnc = new Map<string, Tree>();
	// $/ ref target per dolbyStream key — section depends on the variant.
	const dolbyStreamRef = (encName: string, key: string): string => {
		const dolby = dolbyByKey.get(key);
		if (dolby?.kind === "ATMOS") {
			return `$/encodings/${encName}/inputStreams/dolbyAtmos/${key}`;
		}
		if (dolby?.kind === "VISION_METADATA") {
			return `$/encodings/${encName}/inputStreams/sidecar/dolbyVisionMetadataIngest/${key}`;
		}
		return `$/encodings/${encName}/inputStreams/dolbyVision/${key}`;
	};
	for (const dolby of plan.dolbyStreams) {
		const owner = plan.encodings?.length
			? (dolby.encodingKey ?? encNames[0] ?? ENCODING_NAME)
			: ENCODING_NAME;
		if (dolby.kind === "ATMOS") {
			perEnc(dolbyAtmosByEnc, owner)[dolby.key] = {
				properties: {
					inputId: inputRef.get(dolby.inputKey),
					inputPath: dolby.inputPath,
					inputFormat: dolby.inputFormat,
				},
			};
		} else if (dolby.kind === "VISION") {
			perEnc(dolbyVisionByEnc, owner)[dolby.key] = {
				properties: dense({
					inputId: inputRef.get(dolby.inputKey),
					videoInputPath: dolby.videoInputPath,
					metadataInputPath: dolby.metadataInputPath,
				}),
			};
		} else {
			perEnc(dolbySidecarByEnc, owner)[dolby.key] = {
				properties: {
					inputId: inputRef.get(dolby.inputKey),
					inputPath: dolby.inputPath,
				},
			};
		}
	}

	const mixResources = new Map<string, Tree>();
	const required = new Set<string>();
	const streamRef = (owner: string, key: string): string => {
		if (dolbyByKey.has(key)) return dolbyStreamRef(owner, key);
		const trim = plan.trimmingStreams.find((s) => s.key === key);
		const section = trim
			? `trimming/${trim.kind === "TIME_BASED" ? "timeBased" : trim.kind === "TIMECODE_TRACK" ? "timecodeTrack" : "h264PictureTiming"}`
			: plan.audioMixStreams.some((s) => s.key === key)
				? "audioMix"
				: plan.concatenationStreams.some((s) => s.key === key)
					? "concatenation"
					: fileByKey.has(key)
						? "file"
						: "ingest";
		return `$/encodings/${owner}/inputStreams/${section}/${key}`;
	};
	const requireStream = (key: string): void => {
		if (required.has(key)) return;
		required.add(key);
		const stream = [
			...plan.ingest,
			...plan.trimmingStreams,
			...plan.concatenationStreams,
			...plan.audioMixStreams,
		].find((s) => s.key === key);
		if (!stream) return;
		const owner = plan.encodings?.length
			? (stream.encodingKey ?? encNames[0] ?? ENCODING_NAME)
			: ENCODING_NAME;
		const node = perEnc(mixResources, owner);
		const add = (section: string, properties: Tree) => {
			node[section] ??= {};
			const entries = node[section] as Tree;
			entries[key] = { properties };
		};
		if ("audioMixChannels" in stream) {
			for (const c of stream.audioMixChannels) requireStream(c.sourceKey);
			add(
				"audioMix",
				dense({
					channelLayout: stream.channelLayout,
					audioMixChannels: stream.audioMixChannels.map(
						({ sourceKey, ...c }) => ({
							...c,
							inputStreamId: streamRef(owner, sourceKey),
						}),
					),
				}),
			);
		} else if ("sourceKey" in stream) {
			requireStream(stream.sourceKey);
			const { key: _, encodingKey: __, kind, ...properties } = stream;
			const { sourceKey, ...rest } = properties;
			const section =
				kind === "TIME_BASED"
					? "timeBased"
					: kind === "TIMECODE_TRACK"
						? "timecodeTrack"
						: "h264PictureTiming";
			node.trimming ??= {};
			const trims = node.trimming as Tree;
			trims[section] ??= {};
			const entries = trims[section] as Tree;
			entries[key] = {
				properties: { ...rest, inputStreamId: streamRef(owner, sourceKey) },
			};
		} else if ("sources" in stream) {
			for (const c of stream.sources) requireStream(c.sourceKey);
			add("concatenation", {
				concatenation: stream.sources.map(({ sourceKey, ...c }) => ({
					...c,
					inputStreamId: streamRef(owner, sourceKey),
				})),
			});
		} else
			add("ingest", {
				inputId: inputRef.get(stream.inputKey),
				inputPath: stream.inputPath,
				selectionMode: stream.selectionMode,
				position: stream.position,
			});
	};
	for (const mix of plan.audioMixStreams) requireStream(mix.key);
	const streamsByEnc = new Map<string, Tree>();
	for (const rendition of plan.renditions) {
		const streams = perEnc(streamsByEnc, encName(rendition.key));
		const ingest = ingestByKey.get(rendition.ingestKey);
		const file = fileByKey.get(rendition.ingestKey);
		const dolby = dolbyByKey.get(rendition.ingestKey);
		streams[rendition.key] = {
			properties: {
				// Display names are omitted by convention, except explicit
				// plan-level overrides (user intent, e.g. "Video 360p").
				...(rendition.streamName ? { name: rendition.streamName } : {}),
				inputStreams: [
					required.has(rendition.ingestKey)
						? {
								inputStreamId: streamRef(
									encName(rendition.key),
									rendition.ingestKey,
								),
							}
						: file
							? {
									inputStreamId: `$/encodings/${encName(rendition.key)}/inputStreams/file/${file.key}`,
								}
							: dolby
								? {
										inputStreamId: dolbyStreamRef(
											encName(rendition.key),
											dolby.key,
										),
									}
								: {
										inputId: inputRef.get(ingest?.inputKey ?? ""),
										inputPath: ingest?.inputPath ?? "",
										selectionMode: ingest?.selectionMode ?? "AUTO",
										position: ingest?.position ?? 0,
									},
				],
				codecConfigId: codecRef.get(rendition.key),
				mode: isVideoCodec(rendition) ? rendition.mode : "STANDARD",
				...(rendition.conditions
					? {
							conditions: {
								type: "CONDITION",
								attribute: rendition.conditions.attribute,
								operator: wire(
									CONDITION_OPERATOR_WIRE,
									rendition.conditions.operator,
								),
								value: rendition.conditions.value,
							},
						}
					: {}),
				...(isVideoCodec(rendition) && rendition.perTitleSettings
					? {
							perTitleSettings: {
								fixedResolutionAndBitrateSettings: rendition.perTitleSettings,
							},
						}
					: {}),
			},
		};
		if (rendition.burnInSrt) {
			const burn = rendition.burnInSrt;
			(streams[rendition.key] as Tree).burnInSubtitles = {
				srt: {
					subtitles: {
						properties: {
							name: "SRT subtitles",
							characterEncoding:
								SRT_CHARACTER_ENCODING_VALUES[burn.characterEncoding],
							input: {
								inputId: inputRef.get(burn.inputKey),
								inputPath: burn.inputPath,
							},
						},
					},
				},
			};
		}
		const thumbs: Tree = {};
		for (const thumbnail of plan.thumbnails) {
			if (thumbnail.streamKey !== rendition.key) {
				continue;
			}
			thumbs[thumbnail.key] = {
				properties: {
					height: thumbnail.height,
					pattern: thumbnail.pattern,
					unit: thumbnail.unit,
					positions: thumbnail.positions,
					outputs: [
						{
							outputId: outputRef.get(thumbnail.destination.outputKey),
							outputPath: thumbnail.destination.path,
							...(thumbnail.destination.acl
								? { acl: [{ permission: thumbnail.destination.acl }] }
								: {}),
						},
					],
				},
			};
		}
		if (Object.keys(thumbs).length > 0) {
			(streams[rendition.key] as Tree).thumbnails = thumbs;
		}
		// Trick-play sprites: a streams.<key>.sprites node (sibling of
		// properties, like thumbnails). Optional grid/dimension fields are
		// dropped by dense; the destination becomes an EncodingOutput.
		const sprites: Tree = {};
		for (const sprite of plan.sprites) {
			if (sprite.streamKey !== rendition.key) {
				continue;
			}
			sprites[sprite.key] = {
				properties: dense({
					name: sprite.name,
					width: sprite.width,
					height: sprite.height,
					distance: sprite.distance,
					unit: sprite.unit,
					hTiles: sprite.hTiles,
					vTiles: sprite.vTiles,
					imagesPerFile: sprite.imagesPerFile,
					spriteName: sprite.spriteName,
					filename: sprite.filename,
					vttName: sprite.vttName,
					creationMode: sprite.creationMode,
					outputs: [
						{
							outputId: outputRef.get(sprite.destination.outputKey),
							outputPath: sprite.destination.path,
							...(sprite.destination.acl
								? { acl: [{ permission: sprite.destination.acl }] }
								: {}),
						},
					],
				}),
			};
		}
		if (Object.keys(sprites).length > 0) {
			(streams[rendition.key] as Tree).sprites = sprites;
		}
		// Stream-level DolbyVision HDR attach: hdr.dolbyVision node (sibling
		// of properties, like thumbnails/filters). The sidecar id resolves to
		// the inputStreams.sidecar.dolbyVisionMetadataIngest entry.
		if (
			"dolbyVisionMetadata" in rendition &&
			rendition.dolbyVisionMetadata !== undefined
		) {
			const meta = rendition.dolbyVisionMetadata;
			(streams[rendition.key] as Tree).hdr = {
				dolbyVision: {
					[rendition.key]: {
						properties: dense({
							profile: meta.profile,
							metadataSource: meta.metadataSource,
							metadataInputStreamId: meta.metadataStreamKey
								? dolbyStreamRef(encName(rendition.key), meta.metadataStreamKey)
								: undefined,
						}),
					},
				},
			};
		}
	}

	// Filter resources mirror the compiler: one instance per attachment.
	// Attachment lives on the stream NODE (sibling of `properties`, like
	// thumbnails): filters.properties = [{id, position}] per the official
	// schema.
	const filterByKey = new Map(plan.filters.map((f) => [f.key, f]));
	const filterResources: Record<string, Tree> = {};
	const usedFilterInstanceKeys = new Set<string>();
	for (const rendition of plan.renditions) {
		const attachmentRefs: { id: string; position: number }[] = [];
		for (const attachment of rendition.filters ?? []) {
			const filter = filterByKey.get(attachment.filterKey);
			if (!filter) {
				continue;
			}
			// refKey allows '-', so composed instance keys can collide
			// across renditions — disambiguate deterministically.
			let instanceKey = `${rendition.key}-${attachment.filterKey}`;
			for (let n = 2; usedFilterInstanceKeys.has(instanceKey); n++) {
				instanceKey = `${rendition.key}-${attachment.filterKey}-${n}`;
			}
			usedFilterInstanceKeys.add(instanceKey);
			const endpoint = FILTER_ENDPOINTS[filter.kind];
			filterResources[endpoint] ??= {};
			const group = filterResources[endpoint];
			const properties = filterParameters(filter);
			if (filter.kind === "WATERMARK") {
				delete properties.inputKey;
				delete properties.imagePath;
				properties.image = placeholder(
					"INPUT",
					filter.inputKey,
					`WATERMARK_${instanceKey.replaceAll("-", "_").toUpperCase()}_URL`,
				);
			}
			group[instanceKey] = { properties };
			attachmentRefs.push({
				id: `$/filters/${endpoint}/${instanceKey}`,
				position: attachment.position,
			});
		}
		if (attachmentRefs.length > 0) {
			(
				perEnc(streamsByEnc, encName(rendition.key))[rendition.key] as Tree
			).filters = {
				properties: attachmentRefs,
			};
		}
	}

	const keyframesByEnc = new Map<string, Tree>();
	for (const keyframe of plan.keyframes) {
		const owner = plan.encodings?.length
			? (keyframe.encodingKey ?? encNames[0] ?? ENCODING_NAME)
			: ENCODING_NAME;
		perEnc(keyframesByEnc, owner)[keyframe.key] = {
			properties: { time: keyframe.time },
		};
	}

	const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
	const muxingsByEnc = new Map<
		string,
		{
			fmp4: Tree;
			cmaf: Tree;
			mp4: Tree;
			text: Tree;
			chunkedText: Tree;
			ts: Tree;
			webm: Tree;
		}
	>();
	for (const muxing of plan.muxings) {
		const ownerEnc = encName(muxing.streamKey);
		let legs = muxingsByEnc.get(ownerEnc);
		if (!legs) {
			legs = {
				fmp4: {},
				cmaf: {},
				mp4: {},
				text: {},
				chunkedText: {},
				ts: {},
				webm: {},
			};
			muxingsByEnc.set(ownerEnc, legs);
		}
		const { fmp4, cmaf, mp4, text, chunkedText, ts, webm } = legs;
		const shared = {
			// EVERY stream the container packages . This emitted a
			// one-element list, which was a complete description of a
			// single-stream muxing and a SILENT truncation of a multiplexed one:
			// the wizard exposes this YAML as "Template YAML" for the operator
			// to copy, so a muxed plan would have handed them a template that
			// encodes without the audio.
			streams: muxingStreamKeys(muxing).map((streamKey) => ({
				streamId: `$/encodings/${encName(streamKey)}/streams/${streamKey}`,
			})),
			// DRM'd muxings have no destination — the drm node below owns
			// the (encrypted) outputs.
			...(muxing.destination
				? {
						outputs: [
							{
								outputId: outputRef.get(muxing.destination.outputKey),
								outputPath: muxing.destination.path,
								...(muxing.destination.acl
									? { acl: [{ permission: muxing.destination.acl }] }
									: {}),
							},
						],
					}
				: {}),
		};
		// Muxing-node drm section (sibling of properties, per the official
		// schema). The content key is vault material → {{PLACEHOLDER}}.
		const cencEntries: Tree = {};
		const fairplayEntries: Tree = {};
		for (const drm of plan.drm) {
			if (drm.muxingKey !== muxing.key) {
				continue;
			}
			const drmOutputs = [
				{
					outputId: outputRef.get(drm.destination.outputKey),
					outputPath: drm.destination.path,
					...(drm.destination.acl
						? { acl: [{ permission: drm.destination.acl }] }
						: {}),
				},
			];
			if (drm.kind === "CENC") {
				cencEntries[drm.key] = {
					properties: dense({
						key: ph("DRM", drm.key, "KEY"),
						kid: drm.kid,
						// Required by the template schema; the API (and our
						// ops) default to CTR when the plan omits it.
						encryptionMode: drm.encryptionMode ?? "CTR",
						ivSize: drm.ivSize ? wire(IV_SIZE_WIRE, drm.ivSize) : undefined,
						widevine: drm.widevine,
						playReady: drm.playReady,
						fairPlay: drm.fairPlay,
						name: drm.name,
						outputs: drmOutputs,
					}),
				};
			} else if (drm.kind === "FAIRPLAY") {
				fairplayEntries[drm.key] = {
					properties: dense({
						key: ph("DRM", drm.key, "KEY"),
						iv: drm.iv,
						uri: drm.uri,
						name: drm.name,
						outputs: drmOutputs,
					}),
				};
			}
		}
		const drmNode =
			Object.keys(cencEntries).length > 0 ||
			Object.keys(fairplayEntries).length > 0
				? {
						drm: {
							...(Object.keys(cencEntries).length > 0
								? { cenc: cencEntries }
								: {}),
							...(Object.keys(fairplayEntries).length > 0
								? { fairplay: fairplayEntries }
								: {}),
						},
					}
				: {};
		if (muxing.kind === "FMP4" || muxing.kind === "CMAF") {
			(muxing.kind === "CMAF" ? cmaf : fmp4)[muxing.key] = {
				...drmNode,
				properties: {
					segmentLength: muxing.segmentLength,
					...(muxing.kind === "CMAF" && muxing.segmentNamingTemplate
						? { segmentNamingTemplate: muxing.segmentNamingTemplate }
						: { segmentNaming: muxing.segmentNaming }),
					...(muxing.kind === "CMAF" && muxing.initSegmentNameTemplate
						? { initSegmentNameTemplate: muxing.initSegmentNameTemplate }
						: { initSegmentName: muxing.initSegmentName }),
					...(muxing.kind === "CMAF" && muxing.framesPerCmafChunk !== undefined
						? { framesPerCmafChunk: muxing.framesPerCmafChunk }
						: {}),
					...shared,
				},
			};
		} else if (muxing.kind === "MP4") {
			mp4[muxing.key] = {
				...drmNode,
				properties: {
					filename: muxing.filename,
					// Progressive MP4 omits both fragment fields entirely.
					// SDK/schema field really is capital-MP4.
					...dense({
						fragmentedMP4MuxingManifestType: muxing.manifestType,
						fragmentDuration: muxing.fragmentDuration,
						// trackSampleEntryName NAME = wire (DVHE/DVH1).
						dolbyVisionConfiguration: muxing.dolbyVisionConfiguration,
					}),
					...shared,
				},
			};
		} else if (muxing.kind === "TEXT") {
			text[muxing.key] = {
				properties: { filename: muxing.filename, ...shared },
			};
		} else if (muxing.kind === "CHUNKED_TEXT") {
			chunkedText[muxing.key] = {
				properties: {
					segmentLength: muxing.segmentLength,
					segmentNaming: muxing.segmentNaming,
					...shared,
				},
			};
		} else if (muxing.kind === "TS") {
			ts[muxing.key] = {
				...drmNode,
				properties: {
					segmentLength: muxing.segmentLength,
					segmentNaming: muxing.segmentNaming,
					...shared,
				},
			};
		} else if (muxing.kind === "WEBM") {
			webm[muxing.key] = {
				...drmNode,
				properties: {
					segmentLength: muxing.segmentLength,
					segmentNaming: muxing.segmentNaming,
					initSegmentName: muxing.initSegmentName,
					...shared,
				},
			};
		} else {
			unreachable(muxing);
		}
	}

	const jit = plan.generation.timing === "JUST_IN_TIME";
	const hlsManifests: Tree = {};
	const dashManifests: Tree = {};
	const smoothManifests: Tree = {};
	for (const manifest of plan.manifests) {
		const manifestOutput = {
			outputId: outputRef.get(manifest.destination.outputKey),
			outputPath: manifest.destination.path,
			...(manifest.destination.acl
				? { acl: [{ permission: manifest.destination.acl }] }
				: {}),
		};
		if (manifest.kind === "HLS") {
			const subtitleGroup = hlsSubtitleGroups(plan)[0];
			const subtitleReference = subtitleGroup
				? { subtitles: subtitleGroup }
				: {};
			const media: Tree = {};
			const subtitles: Tree = {};
			const variantStreams: Tree = {};
			for (const muxing of plan.muxings) {
				const rendition = renditionByKey.get(muxing.streamKey);
				// Per-title entries expand at run time — not representable
				// in a template (header note).
				if (!rendition || isPerTitle(rendition)) {
					continue;
				}
				const entryEnc = encName(rendition.key);
				const refs = {
					encodingId: `$/encodings/${entryEnc}`,
					streamId: `$/encodings/${entryEnc}/streams/${rendition.key}`,
					muxingId: `$/encodings/${entryEnc}/muxings/${
						MUXING_SECTION[muxing.kind]
					}/${muxing.key}`,
				};
				const entryDrm = manifest.drmKind
					? plan.drm.find(
							(d) => d.muxingKey === muxing.key && d.kind === manifest.drmKind,
						)
					: undefined;
				const segmentPath = relativeSegmentPath(
					entryDrm?.destination.path ?? muxing.destination?.path ?? "",
					manifest.destination.path,
				);
				if (entryDrm) {
					(refs as Tree).drmId =
						`$/encodings/${entryEnc}/muxings/${MUXING_SECTION[muxing.kind]}/${muxing.key}/drm/${entryDrm.kind === "CENC" ? "cenc" : "fairplay"}/${entryDrm.key}`;
				}
				if (rendition.codec === "IMSC") continue;
				if (rendition.codec === "WEBVTT") {
					if (muxing.kind === "CHUNKED_TEXT") {
						subtitles[muxing.key] = {
							properties: {
								name: rendition.label,
								groupId: rendition.groupId,
								language: rendition.language,
								segmentPath,
								uri: rendition.uri,
								...refs,
							},
						};
					}
				} else if (isAudioCodec(rendition)) {
					if (
						manifest.audioMuxingKind &&
						muxing.kind !== manifest.audioMuxingKind
					) {
						continue;
					}
					media[muxing.key] = {
						properties: rendition.hlsMedia
							? dense({
									name: rendition.hlsMedia.name,
									groupId: rendition.hlsMedia.groupId,
									language: manifest.audioLanguage,
									isDefault: rendition.hlsMedia.isDefault,
									autoselect: rendition.hlsMedia.autoselect,
									segmentPath,
									uri: rendition.hlsMedia.uri,
									...refs,
								})
							: {
									name: "HLS Audio Media",
									groupId: manifest.audioGroupId,
									language: manifest.audioLanguage,
									segmentPath,
									uri:
										manifest.audioMediaUri ?? `audio_${rendition.bitrate}.m3u8`,
									...refs,
								},
					};
					if (manifest.audioVariantStreams) {
						variantStreams[muxing.key] = {
							properties: {
								audio: rendition.hlsMedia?.groupId ?? manifest.audioGroupId,
								closedCaptions: manifest.closedCaptions,
								segmentPath,
								uri:
									rendition.hlsMedia?.uri ??
									manifest.audioMediaUri ??
									`audio_${rendition.bitrate}.m3u8`,
								...refs,
							},
						};
					}
				} else {
					if (
						manifest.videoMuxingKind &&
						muxing.kind !== manifest.videoMuxingKind
					) {
						continue;
					}
					if (manifest.variantsPerAudioGroup && isVideoCodec(rendition)) {
						const groups = [
							...new Set(
								plan.renditions.flatMap((r) =>
									r.hlsMedia ? [r.hlsMedia.groupId] : [],
								),
							),
						].sort();
						const label = rendition.hlsVariantLabel ?? "video";
						for (const group of groups) {
							variantStreams[`${muxing.key}-${group}`] = {
								properties: {
									audio: group,
									...subtitleReference,
									closedCaptions: manifest.closedCaptions,
									segmentPath,
									uri: `video_${label}_${rendition.height}p_${rendition.bitrate}_${group}.m3u8`,
									...refs,
								},
							};
						}
					} else {
						variantStreams[muxing.key] = {
							properties: {
								audio: manifest.audioGroupId,
								...subtitleReference,
								closedCaptions: manifest.closedCaptions,
								segmentPath,
								uri: `video_${rendition.bitrate}.m3u8`,
								...refs,
							},
						};
					}
				}
			}
			hlsManifests[manifest.key] = {
				properties: {
					manifestName: manifest.manifestName,
					name: manifest.name,
					...(manifest.masterVersion
						? {
								hlsMasterPlaylistVersion: wire(
									HLS_VERSION_WIRE,
									manifest.masterVersion,
								),
							}
						: {}),
					...(manifest.mediaVersion
						? {
								hlsMediaPlaylistVersion: wire(
									HLS_VERSION_WIRE,
									manifest.mediaVersion,
								),
							}
						: {}),
					outputs: [manifestOutput],
				},
				media: {
					...(Object.keys(media).length > 0 ? { audio: media } : {}),
					...(Object.keys(subtitles).length > 0 ? { subtitles } : {}),
				},
				streams: variantStreams,
			};
		} else if (manifest.kind === "DASH") {
			// Explicit adaptation sets route representations by dashSetKey
			// (PLAN_DASH_SET_UNRESOLVED guarantees routing); the implicit
			// shape keeps the legacy single video_set/audio_set pair.
			const explicitSets = manifest.adaptationSets?.length
				? manifest.adaptationSets
				: undefined;
			// ON_DEMAND selects single-file MP4 muxings into SegmentBase
			// mp4 representations; segmented profiles select fMP4 legs.
			const dashOnDemand = manifest.profile === "ON_DEMAND";
			const repSection = dashOnDemand
				? "mp4"
				: manifest.videoMuxingKind === "WEBM"
					? "webm"
					: manifest.videoMuxingKind === "CMAF"
						? "cmaf"
						: "fmp4";
			const audioRepSection = dashOnDemand
				? "mp4"
				: manifest.audioMuxingKind === "WEBM"
					? "webm"
					: manifest.audioMuxingKind === "CMAF"
						? "cmaf"
						: "fmp4";
			const repsBySet = new Map<string, Tree>();
			const representations: Tree = {};
			const subtitleSets: Tree = {};
			for (const muxing of plan.muxings) {
				const rendition = renditionByKey.get(muxing.streamKey);
				if (muxing.kind !== "TEXT" || rendition?.codec !== "IMSC") continue;
				subtitleSets[`subtitle-${muxing.key}`] = {
					properties: {
						lang: rendition.language,
						labels: [{ value: rendition.label }],
					},
					representations: {
						imsc: {
							[muxing.key]: {
								properties: {
									imscUrl: relativeFilePath(
										muxing.destination.path,
										muxing.filename,
										manifest.destination.path,
									),
								},
							},
						},
					},
				};
			}
			for (const muxing of plan.muxings) {
				const rendition = renditionByKey.get(muxing.streamKey);
				if (muxing.kind !== "CHUNKED_TEXT" || rendition?.codec !== "WEBVTT")
					continue;
				subtitleSets[`subtitle-${muxing.key}`] = {
					properties: {
						lang: rendition.language,
						labels: [{ value: rendition.label }],
					},
					representations: {
						chunkedText: {
							[muxing.key]: {
								properties: {
									type: manifest.representationType,
									segmentPath: relativeSegmentPath(
										muxing.destination?.path ?? "",
										manifest.destination.path,
									),
									encodingId: `$/encodings/${encName(muxing.streamKey)}`,
									muxingId: `$/encodings/${encName(muxing.streamKey)}/muxings/chunkedText/${muxing.key}`,
								},
							},
						},
					},
				};
			}
			const subtitleTree = Object.keys(subtitleSets).length
				? { subtitle: subtitleSets }
				: {};
			const audioRepresentations: Tree = {};
			for (const muxing of plan.muxings) {
				const rendition = renditionByKey.get(muxing.streamKey);
				// Only the selected muxing kind of STANDARD AV renditions
				// becomes a static representation (per-title video expands at
				// run time).
				if (
					!rendition ||
					(isAudioCodec(rendition)
						? !dashAudioLegSelected(muxing, manifest, dashOnDemand)
						: !dashVideoLegSelected(muxing, manifest, dashOnDemand)) ||
					(dashOnDemand &&
						muxing.kind === "MP4" &&
						muxing.manifestType !== "DASH_ON_DEMAND") ||
					rendition.codec === "WEBVTT" ||
					rendition.codec === "IMSC" ||
					isPerTitle(rendition)
				) {
					continue;
				}
				if (
					rendition.codec === "AAC" &&
					!dashOnDemand &&
					manifest.audioMuxingKind &&
					muxing.kind !== manifest.audioMuxingKind
				) {
					continue;
				}
				const target = explicitSets
					? rendition.dashSetKey
						? perEnc(repsBySet, rendition.dashSetKey)
						: undefined
					: isVideoCodec(rendition)
						? representations
						: audioRepresentations;
				if (!target) {
					continue;
				}
				const repDrm = manifest.drmKind
					? plan.drm.find(
							(d) => d.muxingKey === muxing.key && d.kind === manifest.drmKind,
						)
					: undefined;
				const repBase = relativeSegmentPath(
					repDrm?.destination.path ?? muxing.destination?.path ?? "",
					manifest.destination.path,
				);
				const repRefs = {
					encodingId: `$/encodings/${encName(muxing.streamKey)}`,
					muxingId: `$/encodings/${encName(muxing.streamKey)}/muxings/${MUXING_SECTION[muxing.kind]}/${muxing.key}`,
				};
				target[muxing.key] =
					dashOnDemand && muxing.kind === "MP4"
						? {
								properties: {
									type: "SEGMENT_BASE",
									filePath: joinFilePath(repBase, muxing.filename),
									...repRefs,
								},
							}
						: {
								properties: {
									type: manifest.representationType,
									mode: "TEMPLATE_REPRESENTATION",
									segmentPath: repBase,
									...repRefs,
									...(repDrm
										? {
												drmId: `$/encodings/${encName(muxing.streamKey)}/muxings/fmp4/${muxing.key}/drm/cenc/${repDrm.key}`,
											}
										: {}),
								},
							};
			}
			// The official schema requires `properties` on periods and
			// adaptation sets even when empty. Implicit sets exist only when
			// they hold a representation (audio-only sample has no video
			// set); explicit sets are all emitted (mirroring the create ops),
			// with `representations` only where routed. Video set nodes take
			// labels only; audio set nodes also take lang.
			const setNode = (set: NonNullable<typeof explicitSets>[number]): Tree => {
				const reps = repsBySet.get(set.key) ?? {};
				return {
					properties: dense({
						lang: set.type === "AUDIO" ? set.lang : undefined,
						labels: set.label ? [{ value: set.label }] : undefined,
					}),
					...(Object.keys(reps).length > 0
						? {
								representations: {
									[set.type === "AUDIO" ? audioRepSection : repSection]: reps,
								},
							}
						: {}),
				};
			};
			const explicitTrees = explicitSets
				? (["VIDEO", "AUDIO"] as const).map((type) =>
						Object.fromEntries(
							explicitSets
								.filter((set) => set.type === type)
								.map((set) => [set.key, setNode(set)]),
						),
					)
				: undefined;
			dashManifests[manifest.key] = {
				properties: {
					manifestName: manifest.manifestName,
					...(manifest.profile ? { profile: manifest.profile } : {}),
					name: manifest.name,
					outputs: [manifestOutput],
				},
				periods: {
					period: {
						properties: {},
						adaptationsets: explicitTrees
							? {
									...subtitleTree,
									...(Object.keys(explicitTrees[0] ?? {}).length > 0
										? { video: explicitTrees[0] }
										: {}),
									...(Object.keys(explicitTrees[1] ?? {}).length > 0
										? { audio: explicitTrees[1] }
										: {}),
								}
							: {
									...subtitleTree,
									...(Object.keys(representations).length > 0
										? {
												video: {
													video_set: {
														properties: {},
														representations: {
															[repSection]: representations,
														},
													},
												},
											}
										: {}),
									...(Object.keys(audioRepresentations).length > 0
										? {
												audio: {
													audio_set: {
														properties: { lang: manifest.audioLanguage },
														representations: {
															[audioRepSection]: audioRepresentations,
														},
													},
												},
											}
										: {}),
								},
					},
				},
			};
		} else if (manifest.kind === "SMOOTH") {
			// Static (STANDARD) MP4 representations only; per-title entries
			// expand at run time (header note). drmId refs point into the
			// muxing's drm node by $/ path.
			const representations: Tree = {};
			const contentProtections: Tree = {};
			for (const muxing of plan.muxings) {
				const rendition = renditionByKey.get(muxing.streamKey);
				if (
					!rendition ||
					muxing.kind !== "MP4" ||
					rendition.codec === "WEBVTT" ||
					rendition.codec === "IMSC" ||
					isPerTitle(rendition)
				) {
					continue;
				}
				const drm = manifest.drmKind
					? plan.drm.find(
							(d) => d.muxingKey === muxing.key && d.kind === manifest.drmKind,
						)
					: undefined;
				const base = relativeSegmentPath(
					drm?.destination.path ?? muxing.destination?.path ?? "",
					manifest.destination.path,
				);
				representations[muxing.key] = {
					properties: {
						encodingId: `$/encodings/${encName(muxing.streamKey)}`,
						muxingId: `$/encodings/${encName(muxing.streamKey)}/muxings/mp4/${muxing.key}`,
						mediaFile: joinFilePath(base, muxing.filename),
						language: manifest.language,
						trackName: isVideoCodec(rendition) ? "video" : "audio",
					},
				};
				if (drm) {
					contentProtections[muxing.key] = {
						properties: {
							encodingId: `$/encodings/${encName(muxing.streamKey)}`,
							muxingId: `$/encodings/${encName(muxing.streamKey)}/muxings/mp4/${muxing.key}`,
							drmId: `$/encodings/${encName(muxing.streamKey)}/muxings/mp4/${muxing.key}/drm/cenc/${drm.key}`,
						},
					};
				}
			}
			smoothManifests[manifest.key] = {
				properties: {
					serverManifestName: manifest.serverManifestName,
					clientManifestName: manifest.clientManifestName,
					name: manifest.name,
					outputs: [manifestOutput],
				},
				...(Object.keys(representations).length > 0
					? { representations: { mp4: representations } }
					: {}),
				...(Object.keys(contentProtections).length > 0
					? { contentprotection: contentProtections }
					: {}),
			};
		} else {
			unreachable(manifest);
		}
	}

	const hlsKeys = plan.manifests
		.filter((m) => m.kind === "HLS")
		.map((m) => m.key);
	const dashKeys = plan.manifests
		.filter((m) => m.kind === "DASH")
		.map((m) => m.key);
	const smoothKeys = plan.manifests
		.filter((m) => m.kind === "SMOOTH")
		.map((m) => m.key);
	// Start-request placement split (mirrors the compiler): the manifests
	// SECTION defines every manifest; the start lists route by jitPlacement.
	const ridesVod = (m: { kind: string; jitPlacement?: string }) =>
		m.jitPlacement === undefined ||
		m.jitPlacement === "VOD" ||
		m.jitPlacement === "VOD_AND_PREVIEW";
	const ridesPreview = (m: { kind: string; jitPlacement?: string }) =>
		m.jitPlacement === "PREVIEW" || m.jitPlacement === "VOD_AND_PREVIEW";
	const hlsVodKeys = plan.manifests
		.filter((m) => m.kind === "HLS")
		.filter(ridesVod)
		.map((m) => m.key);
	const hlsPreviewKeys = plan.manifests
		.filter((m) => m.kind === "HLS")
		.filter(ridesPreview)
		.map((m) => m.key);
	const dashVodKeys = plan.manifests
		.filter((m) => m.kind === "DASH")
		.filter(ridesVod)
		.map((m) => m.key);
	const dashPreviewKeys = plan.manifests
		.filter((m) => m.kind === "DASH")
		.filter(ridesPreview)
		.map((m) => m.key);

	// Kantar is a plan-ROOT singleton, so its placeholder names are minted
	// ONCE — inside the per-encoding loop the second encoding collided with
	// the first and threw (review catch: user-reachable, because the wizard
	// preview computes the template during render). And the node is gated on
	// the SAME per-encoding audio test the compiler uses, so an exported
	// template can never configure Kantar on an encoding the compiler would
	// skip.
	const kantarPlaceholders = plan.kantar
		? {
				login: phLiteral("{{KANTAR_LOGIN}}"),
				password: phLiteral("{{KANTAR_PASSWORD}}"),
			}
		: undefined;
	const encodingCarriesAudio = (encodingName: string): boolean =>
		plan.renditions.some(
			(r) =>
				AUDIO_CODECS.has(r.codec) &&
				(renditionEnc.get(r.key) ?? ENCODING_NAME) === encodingName,
		);
	return {
		metadata: { type: "VOD", name: plan.name },
		inputs: {
			...(Object.keys(inputsS3).length > 0 ? { s3: inputsS3 } : {}),
			...(Object.keys(inputsAzure).length > 0 ? { azure: inputsAzure } : {}),
			...(Object.keys(inputsHttps).length > 0 ? { https: inputsHttps } : {}),
			...(Object.keys(inputsGenericS3).length > 0
				? { genericS3: inputsGenericS3 }
				: {}),
			...(Object.keys(inputsGcs).length > 0 ? { gcs: inputsGcs } : {}),
			...(Object.keys(inputsAkamaiNetStorage).length > 0
				? { akamaiNetstorage: inputsAkamaiNetStorage }
				: {}),
			...(Object.keys(inputsGcsServiceAccount).length > 0
				? { gcsServiceAccount: inputsGcsServiceAccount }
				: {}),
		},
		outputs: {
			...(Object.keys(outputsS3).length > 0 ? { s3: outputsS3 } : {}),
			...(Object.keys(outputsAzure).length > 0 ? { azure: outputsAzure } : {}),
			...(Object.keys(outputsSftp).length > 0 ? { sftp: outputsSftp } : {}),
			...(Object.keys(outputsGenericS3).length > 0
				? { genericS3: outputsGenericS3 }
				: {}),
			...(Object.keys(outputsGcs).length > 0 ? { gcs: outputsGcs } : {}),
			...(Object.keys(outputsAkamaiMsl).length > 0
				? { akamaiMsl: outputsAkamaiMsl }
				: {}),
			...(Object.keys(outputsAkamaiNetStorage).length > 0
				? { akamaiNetstorage: outputsAkamaiNetStorage }
				: {}),
			...(Object.keys(outputsGcsServiceAccount).length > 0
				? { gcsServiceAccount: outputsGcsServiceAccount }
				: {}),
		},
		configurations: {
			...(Object.keys(h264).length > 0 ||
			Object.keys(h265).length > 0 ||
			Object.keys(vp9).length > 0 ||
			Object.keys(av1).length > 0
				? {
						video: {
							...(Object.keys(h264).length > 0 ? { h264 } : {}),
							...(Object.keys(h265).length > 0 ? { h265 } : {}),
							...(Object.keys(vp9).length > 0 ? { vp9 } : {}),
							...(Object.keys(av1).length > 0 ? { av1 } : {}),
						},
					}
				: {}),
			...(Object.keys(aac).length > 0 ||
			Object.keys(opus).length > 0 ||
			Object.keys(dolbyAtmos).length > 0 ||
			Object.keys(ddPlus).length > 0 ||
			Object.keys(dd).length > 0
				? {
						audio: {
							...(Object.keys(aac).length > 0 ? { aac } : {}),
							...(Object.keys(opus).length > 0 ? { opus } : {}),
							...(Object.keys(dolbyAtmos).length > 0 ? { dolbyAtmos } : {}),
							...(Object.keys(ddPlus).length > 0
								? { dolbyDigitalPlus: ddPlus }
								: {}),
							...(Object.keys(dd).length > 0 ? { dolbyDigital: dd } : {}),
						},
					}
				: {}),
			...(Object.keys(webvtt).length > 0 || Object.keys(imsc).length > 0
				? {
						subtitles: {
							...(Object.keys(webvtt).length > 0 ? { webvtt } : {}),
							...(Object.keys(imsc).length > 0 ? { imsc } : {}),
						},
					}
				: {}),
		},
		...(Object.keys(filterResources).length > 0
			? { filters: filterResources }
			: {}),
		encodings: Object.fromEntries(
			encNames.map((name) => {
				const enc = plan.encodings?.find((e) => e.key === name);
				const legs = muxingsByEnc.get(name) ?? {
					fmp4: {},
					cmaf: {},
					mp4: {},
					chunkedText: {},
					text: {},
					ts: {},
					webm: {},
				};
				const fileEntries = fileInputStreamsByEnc.get(name) ?? {};
				const atmosEntries = dolbyAtmosByEnc.get(name) ?? {};
				const visionEntries = dolbyVisionByEnc.get(name) ?? {};
				const sidecarEntries = dolbySidecarByEnc.get(name) ?? {};
				const inputStreamsNode = {
					...(mixResources.get(name) ?? {}),
					...(Object.keys(fileEntries).length > 0 ? { file: fileEntries } : {}),
					...(Object.keys(atmosEntries).length > 0
						? { dolbyAtmos: atmosEntries }
						: {}),
					...(Object.keys(visionEntries).length > 0
						? { dolbyVision: visionEntries }
						: {}),
					...(Object.keys(sidecarEntries).length > 0
						? { sidecar: { dolbyVisionMetadataIngest: sidecarEntries } }
						: {}),
				};
				const kfEntries = keyframesByEnc.get(name) ?? {};
				return [
					name,
					{
						properties: {
							name: enc?.name ?? plan.name,
							cloudRegion: enc?.cloudRegion ?? plan.bitmovin.cloudRegion,
							encoderVersion:
								enc?.encoderVersion ?? plan.bitmovin.encoderVersion,
							...(plan.bitmovin.labels?.length
								? { labels: plan.bitmovin.labels }
								: {}),
							...(plan.bitmovin.infrastructure
								? { infrastructure: plan.bitmovin.infrastructure }
								: {}),
						},
						...(Object.keys(inputStreamsNode).length > 0
							? { inputStreams: inputStreamsNode }
							: {}),
						// Kantar is a template-schema node under the encoding
						// (encodings.<k>.kantarWatermark.<name>.properties). The
						// login/password are vault material, so they render as
						// the same {{…}} placeholders secrets use elsewhere.
						...(plan.kantar && kantarPlaceholders && encodingCarriesAudio(name)
							? {
									kantarWatermark: {
										kantar: {
											properties: {
												login: kantarPlaceholders.login,
												password: kantarPlaceholders.password,
												licenseId: plan.kantar.licenseId,
												channelName: plan.kantar.channelName,
												contentReference: plan.kantar.contentReference,
												serverUrl: plan.kantar.serverUrl,
												reportOutputs: [
													{
														outputId: outputRef.get(
															plan.kantar.reportDestination.outputKey,
														),
														outputPath: plan.kantar.reportDestination.path,
														...(plan.kantar.reportDestination.acl
															? {
																	acl: [
																		{
																			permission:
																				plan.kantar.reportDestination.acl,
																		},
																	],
																}
															: {}),
													},
												],
											},
										},
									},
								}
							: {}),
						...(Object.keys(kfEntries).length > 0
							? { keyframes: kfEntries }
							: {}),
						streams: streamsByEnc.get(name) ?? {},
						muxings: {
							...(Object.keys(legs.fmp4).length > 0 ? { fmp4: legs.fmp4 } : {}),
							...(Object.keys(legs.cmaf).length > 0 ? { cmaf: legs.cmaf } : {}),
							...(Object.keys(legs.mp4).length > 0 ? { mp4: legs.mp4 } : {}),
							...(Object.keys(legs.text).length > 0 ? { text: legs.text } : {}),
							...(Object.keys(legs.chunkedText).length > 0
								? { chunkedText: legs.chunkedText }
								: {}),
							...(Object.keys(legs.ts).length > 0 ? { ts: legs.ts } : {}),
							...(Object.keys(legs.webm).length > 0 ? { webm: legs.webm } : {}),
						},
						start: {
							properties: {
								...(jit ? { manifestGenerator: "V2" } : {}),
								...(plan.perTitle ? { perTitle: plan.perTitle } : {}),
								// AISA is representable: features.assetDescription
								// carries a full EncodingOutput ($/ output ref).
								...(plan.aiSceneAnalysis
									? {
											aiSceneAnalysis: {
												features: {
													assetDescription: {
														filename:
															plan.aiSceneAnalysis.assetDescription.filename,
														outputs: [
															{
																outputId: outputRef.get(
																	plan.aiSceneAnalysis.assetDescription
																		.destination.outputKey,
																),
																outputPath:
																	plan.aiSceneAnalysis.assetDescription
																		.destination.path,
																...(plan.aiSceneAnalysis.assetDescription
																	.destination.acl
																	? {
																			acl: [
																				{
																					permission:
																						plan.aiSceneAnalysis
																							.assetDescription.destination.acl,
																				},
																			],
																		}
																	: {}),
															},
														],
													},
													...(plan.aiSceneAnalysis.automaticAdPlacement
														? {
																automaticAdPlacement:
																	plan.aiSceneAnalysis.automaticAdPlacement,
															}
														: {}),
													...(plan.aiSceneAnalysis.outputLanguageCodes
														? {
																outputLanguageCodes: {
																	outputLanguageCodes:
																		plan.aiSceneAnalysis.outputLanguageCodes,
																},
															}
														: {}),
												},
											},
										}
									: {}),
								...(plan.generation.encodingMode
									? { encodingMode: plan.generation.encodingMode }
									: {}),
								...(plan.generation.audioVideoSyncMode
									? {
											tweaks: {
												audioVideoSyncMode: plan.generation.audioVideoSyncMode,
											},
										}
									: {}),
								...(plan.generation.handleVariableInputFps !== undefined
									? {
											handleVariableInputFps:
												plan.generation.handleVariableInputFps,
										}
									: {}),
								...(jit && hlsVodKeys.length > 0
									? {
											vodHlsManifests: hlsVodKeys.map((key) => ({
												manifestId: `$/manifests/hls/${key}`,
											})),
										}
									: {}),
								...(jit && dashVodKeys.length > 0
									? {
											vodDashManifests: dashVodKeys.map((key) => ({
												manifestId: `$/manifests/dash/${key}`,
											})),
										}
									: {}),
								...(jit && hlsPreviewKeys.length > 0
									? {
											previewHlsManifests: hlsPreviewKeys.map((key) => ({
												manifestId: `$/manifests/hls/${key}`,
											})),
										}
									: {}),
								...(jit && dashPreviewKeys.length > 0
									? {
											previewDashManifests: dashPreviewKeys.map((key) => ({
												manifestId: `$/manifests/dash/${key}`,
											})),
										}
									: {}),
								...(jit && smoothKeys.length > 0
									? {
											vodSmoothManifests: smoothKeys.map((key) => ({
												manifestId: `$/manifests/smooth/${key}`,
											})),
										}
									: {}),
							},
						},
					},
				];
			}),
		),
		...(plan.manifests.length > 0
			? {
					manifests: {
						...(hlsKeys.length > 0 ? { hls: hlsManifests } : {}),
						...(dashKeys.length > 0 ? { dash: dashManifests } : {}),
						...(smoothKeys.length > 0 ? { smooth: smoothManifests } : {}),
					},
				}
			: {}),
	};
}

/** Comments must stay comments — strip control chars from embedded values. */
function commentSafe(text: string): string {
	return text.replaceAll(/\p{Cc}+/gu, " ");
}

/** A template must not silently omit selected DRM from an executable plan. */
export function encodingTemplateExportUnavailableReason(
	plan: EncodingPlan,
): "SPEKE" | "DASH_ON_DEMAND_MP4_DRM" | undefined {
	if (plan.drm.some((drm) => drm.kind === "SPEKE")) return "SPEKE";
	for (const manifest of plan.manifests) {
		if (
			manifest.kind !== "DASH" ||
			manifest.profile !== "ON_DEMAND" ||
			!manifest.drmKind
		)
			continue;
		for (const muxing of plan.muxings) {
			const rendition = plan.renditions.find((r) => r.key === muxing.streamKey);
			if (
				!rendition ||
				isPerTitle(rendition) ||
				(!isVideoCodec(rendition) && !isAudioCodec(rendition))
			)
				continue;
			if (
				!(isAudioCodec(rendition)
					? dashAudioLegSelected(muxing, manifest, true)
					: dashVideoLegSelected(muxing, manifest, true))
			)
				continue;
			if (
				manifest.adaptationSets?.length &&
				!manifest.adaptationSets.some(
					(set) =>
						set.key === rendition.dashSetKey &&
						set.type === (isAudioCodec(rendition) ? "AUDIO" : "VIDEO"),
				)
			)
				continue;
			if (
				plan.drm.some(
					(drm) =>
						drm.muxingKey === muxing.key && drm.kind === manifest.drmKind,
				)
			)
				return "DASH_ON_DEMAND_MP4_DRM";
		}
	}
	return undefined;
}

export function planToEncodingTemplateYaml(plan: EncodingPlan): string {
	const unavailable = encodingTemplateExportUnavailableReason(plan);
	if (unavailable === "SPEKE")
		throw new Error(
			"SPEKE uses a write-only key provider credential. Export the bitovp plan JSON to preserve its vault reference; encoding-template export is unavailable.",
		);
	if (unavailable === "DASH_ON_DEMAND_MP4_DRM")
		throw new Error(
			"OnDemand MP4 DRM is unavailable in encoding-template YAML. Export Plan JSON or run the plan in the app to preserve DRM.",
		);
	if (plan.internal?.hevcV2) {
		throw new Error(
			"Internal HEVC v2 profiles cannot be exported as public encoding templates",
		);
	}
	const header = [
		`# Bitmovin Encoding Template — generated by bitovp from plan "${commentSafe(plan.name)}"`,
		"# DRAFT SUBSET of the plan: validate before submitting —",
		"# schema: https://raw.githubusercontent.com/bitmovin/bitmovin-api-sdk-examples/main/bitmovin-encoding-template.json",
		"# Secrets are exported as {{PLACEHOLDER}} variables (vault never leaves this app).",
		"# Numeric substitutions (e.g. the SFTP port) must be unquoted numbers.",
		...(plan.filters.some((f) => f.kind === "WATERMARK")
			? [
					"# NOTE: watermark image URL placeholders require a fresh signed URL for the referenced input object.",
				]
			: []),
		...(plan.manifests.some((m) => m.kind === "HLS" && m.iframePlaylists)
			? [
					"# NOTE: I-frame playlists attach to run-time variant ids and are",
					"# not representable here — re-add them via the API.",
				]
			: []),
		...(plan.renditions.some((r) => r.nexguard)
			? [
					"# NOTE: NexGuard watermarking is NOT representable in this",
					"# template and was omitted — re-apply it via the API.",
				]
			: []),
		...(plan.renditions.some(
			(r) =>
				(r.codec === "H264" ||
					r.codec === "H265" ||
					r.codec === "VP9" ||
					r.codec === "AV1") &&
				r.mode.startsWith("PER_TITLE"),
		)
			? [
					"# NOTE: per-title manifest entries enumerate run-produced",
					"# muxings — they expand at run time and are not listed here.",
				]
			: []),
		...(plan.generation.timing === "POST_ENCODING"
			? [
					"# NOTE: this plan uses POST_ENCODING manifest generation, which a",
					"# template start cannot express — manifests are included for reference.",
				]
			: []),
	];
	return `${header.join("\n")}\n${stringify(buildTemplate(plan), {
		lineWidth: 0,
	})}`;
}
