import type { CompiledOperation } from "../plan/compiler";
import { relativeSegmentPath } from "../plan/compiler";
import {
	checkMslEncoderVersion,
	MslEncoderVersionError,
} from "../plan/msl-encoder-version";
import { hasMuxedInAudio, muxingStreamKeys } from "../plan/muxing-streams";
import type { PlanRendition } from "../plan/schema";
import { resolveLiveEncodingOption } from "./encoding-option";
import type { LiveChannelPlan, LiveManifestPlan, LiveMuxing } from "./schema";

/**
 * Compiles a LiveChannelPlan into the ordered operation list the channel
 * worker executes. Provisioning order mirrors the live lifecycle (and the
 * VOD compiler shape): input + outputs → encoding → ingest input streams →
 * per rendition codec → stream → muxings → pre-created manifests →
 * START_LIVE_ENCODING → AWAIT_LIVE_RUNNING.
 *
 * Live-vs-VOD contracts (for the PR2 channel worker):
 * - AWAIT_LIVE_RUNNING polls until status RUNNING — the channel's STEADY
 *   state (VOD's AWAIT_ENCODING waits for FINISHED, a terminal state).
 *   Reaching RUNNING completes provisioning; the channel then stays up.
 * - STOP is NOT a compiled step: stopping/restarting a channel is an API
 *   action on the persisted channel (LiveApi.stop/restart), not part of
 *   the provisioning sequence this step log replays.
 * - START_LIVE_ENCODING refs carry liveHlsManifestIds/liveDashManifestIds
 *   (manifest create steps, in plan order); the payload carries the
 *   per-manifest start options (timeshift etc.) keyed by PLAN manifest key
 *   — the executor zips ref position i with payload entry of the key
 *   `step.slice("manifest:".length)` to build LiveHls/LiveDashManifest.
 * - CREATE_INPUT_RTMP resolves the account-default RTMP input by listing
 *   (the API has no POST /encoding/inputs/rtmp) — payload is empty.
 * - manifestGenerator V2 is pinned by the compiler (C3), never plan data.
 *
 * compileLiveChannel assumes a schema-parsed, validateLiveChannel-clean
 * plan — codecs outside the live support matrix throw.
 */

const ENCODING_STEP = "encoding";
const START_STEP = "start";
const AWAIT_STEP = "await:running";

function kbps(bitrate: number): string {
	return `${Math.round(bitrate / 1000)}kbps`;
}

function unreachable(variant: never): never {
	throw new Error(
		`Live compiler: unhandled plan variant ${JSON.stringify(variant)}`,
	);
}

function unsupportedCodec(codec: string): never {
	throw new Error(
		`Live compiler: ${codec} renditions are not live-encodable (validateLiveChannel rejects them)`,
	);
}

/** Live video codecs (the live encoder has no VP9). */
function isLiveVideoCodec(
	rendition: PlanRendition,
): rendition is Extract<PlanRendition, { codec: "H264" | "H265" }> {
	return rendition.codec === "H264" || rendition.codec === "H265";
}

/** Live audio codecs (no Atmos in live). */
function isLiveAudioCodec(
	rendition: PlanRendition,
): rendition is Extract<PlanRendition, { codec: "AAC" | "DDPLUS" | "DD" }> {
	return (
		rendition.codec === "AAC" ||
		rendition.codec === "DDPLUS" ||
		rendition.codec === "DD"
	);
}

/** Mirrors plan/compiler streamName for the live-supported codecs. */
function streamName(rendition: PlanRendition): string {
	switch (rendition.codec) {
		case "H264":
		case "H265":
			return rendition.height === null
				? `Stream ${rendition.codec}`
				: `Stream ${rendition.codec} ${rendition.height}p`;
		case "AAC":
			return `Stream AAC ${kbps(rendition.bitrate)}`;
		case "DDPLUS":
			return `Stream DDPLUS ${kbps(rendition.bitrate)}`;
		case "DD":
			return `Stream DD ${kbps(rendition.bitrate)}`;
		default:
			return unsupportedCodec(rendition.codec);
	}
}

/** Mirrors plan/compiler muxingName for the supported live kinds. */
function muxingName(
	kind: LiveMuxing["kind"],
	rendition: PlanRendition,
): string | undefined {
	if (isLiveVideoCodec(rendition)) {
		const identity = rendition.height === null ? "" : ` ${rendition.height}p`;
		return `Video ${kind} Muxing${identity}`;
	}
	if (isLiveAudioCodec(rendition)) {
		return `Audio ${kind} Muxing ${kbps(rendition.bitrate)}`;
	}
	return unsupportedCodec(rendition.codec);
}

/** The rendition subset the live encoder accepts (validator-enforced). */
type LiveRendition = Extract<
	PlanRendition,
	{ codec: "H264" | "H265" | "AAC" | "DDPLUS" | "DD" }
>;
const LIVE_RENDITION_CODECS: ReadonlySet<string> = new Set([
	"H264",
	"H265",
	"AAC",
	"DDPLUS",
	"DD",
]);
function isLiveRendition(rendition: PlanRendition): rendition is LiveRendition {
	return LIVE_RENDITION_CODECS.has(rendition.codec);
}

/**
 * The muxing legs a live manifest enumerates, in plan muxing order. Shared
 * with validateLiveChannel so the empty-manifest rail cannot drift from
 * the compiler's selection. HLS takes FMP4 and TS legs (pinnable per
 * family; CMAF is rejected by validation); DASH takes FMP4 and CMAF — TS segments cannot join an MPD.
 */
export function selectLiveManifestMuxings(
	plan: LiveChannelPlan,
	manifest: LiveManifestPlan,
): {
	muxing: Exclude<LiveMuxing, { kind: "MP4" }>;
	rendition: LiveRendition;
}[] {
	const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
	const selected: ReturnType<typeof selectLiveManifestMuxings> = [];
	for (const muxing of plan.muxings) {
		// Progressive archives are finalized after stop, not HLS/DASH segments.
		if (muxing.kind === "MP4") continue;
		const rendition = renditionByKey.get(muxing.streamKey);
		if (!rendition) {
			continue;
		}
		if (manifest.kind === "HLS") {
			if (muxing.kind === "CMAF") continue;
			if (isLiveAudioCodec(rendition)) {
				if (
					manifest.audioMuxingKind &&
					muxing.kind !== manifest.audioMuxingKind
				) {
					continue;
				}
				selected.push({ muxing, rendition });
			} else if (isLiveVideoCodec(rendition)) {
				if (
					manifest.videoMuxingKind &&
					muxing.kind !== manifest.videoMuxingKind
				) {
					continue;
				}
				selected.push({ muxing, rendition });
			}
		} else if (
			(muxing.kind === "FMP4" || muxing.kind === "CMAF") &&
			(isLiveVideoCodec(rendition) || isLiveAudioCodec(rendition)) &&
			(!manifest.videoMuxingKind ||
				!isLiveVideoCodec(rendition) ||
				muxing.kind === manifest.videoMuxingKind) &&
			(!manifest.audioMuxingKind ||
				!isLiveAudioCodec(rendition) ||
				muxing.kind === manifest.audioMuxingKind)
		) {
			selected.push({ muxing, rendition });
		}
	}
	return selected;
}

/**
 * Derived HLS playlist uri for a selected manifest leg — bitrate-keyed
 * like the VOD convention. Shared with validateLiveChannel's collision
 * rail (LIVE_HLS_URI_COLLISION) so the rail cannot drift from emission.
 */
export function liveHlsEntryUri(rendition: LiveRendition): string {
	return isLiveAudioCodec(rendition)
		? `audio_${rendition.bitrate}.m3u8`
		: `video_${rendition.bitrate}.m3u8`;
}

/**
 * The playlist uri of EVERY rendition in the plan, unique per rendition
 * : two renditions of a kind sharing a bitrate
 * used to derive one uri and were refused (`LIVE_HLS_URI_COLLISION`); the
 * second and later now carry `_1`, `_2`… before the extension, in plan order,
 * so the first keeps the bare name every fixture and paid run was named by.
 * One map, three readers — the compiler's emission, the validator's rail and
 * the verifier's expected children — so the suffix cannot drift.
 */
/** `name.m3u8` → `name_<n>.m3u8`; a name without the extension still changes (review-538 O2). */
export function suffixPlaylistName(base: string, n: number): string {
	const stem = base.endsWith(".m3u8") ? base.slice(0, -".m3u8".length) : base;
	const ext = base.endsWith(".m3u8") ? ".m3u8" : "";
	return `${stem}_${n}${ext}`;
}

export function liveHlsEntryUris(
	plan: Pick<LiveChannelPlan, "renditions">,
): Map<string, string> {
	const uris = new Map<string, string>();
	const taken = new Set<string>();
	for (const rendition of plan.renditions) {
		if (!isLiveRendition(rendition)) {
			continue;
		}
		const base = liveHlsEntryUri(rendition);
		let uri = base;
		for (let n = 1; taken.has(uri); n += 1) {
			uri = suffixPlaylistName(base, n);
		}
		taken.add(uri);
		uris.set(rendition.key, uri);
	}
	return uris;
}

/**
 * Live delivery mirrors (2026-08-23, the Akamai MSL4+Object-Storage case):
 * mirror refs ride beside every destination's outputId, exactly 's
 * VOD mechanism — the worker's shared destination builder appends one
 * EncodingOutput per mirror at the same path/acl. Emitted only when the plan
 * declares deliveryMirrors AND the site has a destination.
 */
function destinationMirrors(
	plan: { deliveryMirrors?: { outputKey: string }[] | undefined },
	primaryOutputKey: string,
) {
	return (plan.deliveryMirrors ?? []).filter(
		(mirror) => mirror.outputKey !== primaryOutputKey,
	);
}

function mirrorOutputRefs(
	plan: { deliveryMirrors?: { outputKey: string }[] | undefined },
	primaryOutputKey: string,
): { mirrorOutputIds: string[] } | Record<string, never> {
	const mirrors = destinationMirrors(plan, primaryOutputKey);
	return mirrors.length > 0
		? {
				mirrorOutputIds: mirrors.map((m) => `output:${m.outputKey}`),
			}
		: {};
}

/**
 * The Akamai MSL4 manifest path contract (re-audit 2026-08-29 BLOCKER-5,
 * ; developer.bitmovin.com/encoding/docs/akamai-msl4-live-outputs
 * §4): a manifest output path is EMPTY, or carries a leading AND a trailing
 * slash. The plan keeps the logical folder the segments are namespaced by
 * (`output/<name>`); an MSL leg's WIRE path is this form of it. The normal
 * wizard used to send `output/<name>` verbatim and the edge served 404 for
 * every segment the native master referenced.
 */
export function mslManifestPath(path: string): string {
	const trimmed = path.replace(/^\/+|\/+$/g, "");
	return trimmed === "" ? "" : `/${trimmed}/`;
}

/**
 * Per-output manifest paths: the primary's wire path, plus one path per
 * delivery mirror (aligned with `mirrorOutputRefs`) when destinations need
 * different wire forms. The segment paths
 * inside the manifest are stripped against the LOGICAL path, not this one.
 */
function manifestOutputPaths(
	plan: LiveChannelPlan,
	manifest: { destination: { outputKey: string; path: string } },
): { outputPath: string; mirrorOutputPaths?: string[] } {
	const kindOf = (key: string) => plan.outputs.find((o) => o.key === key)?.kind;
	const logical = manifest.destination.path;
	const wireFor = (key: string) => {
		const kind = kindOf(key);
		if (kind === "AKAMAI_MSL") return mslManifestPath(logical);
		// An empty Generic S3 Live manifest path can be omitted by the provider's
		// internal DTO and become a literal "null" directory in the ES uploader.
		return kind === "GENERIC_S3" && logical === "" ? "/" : logical;
	};
	const outputPath = wireFor(manifest.destination.outputKey);
	const mirrorPaths = destinationMirrors(
		plan,
		manifest.destination.outputKey,
	).map((m) => wireFor(m.outputKey));
	return {
		outputPath,
		...(mirrorPaths.some((p) => p !== outputPath)
			? { mirrorOutputPaths: mirrorPaths }
			: {}),
	};
}

function compileLiveInput(plan: LiveChannelPlan): CompiledOperation {
	const input = plan.liveInput;
	const step = `live-input:${input.key}`;
	if (input.kind === "RTMP") {
		// Resolve-by-list contract (see header) — nothing is creatable. A
		// pinned inputId  rides the payload; the executor then
		// uses it verbatim instead of listing.
		return {
			step,
			kind: "CREATE_INPUT_RTMP",
			payload: {
				...(input.inputId ? { inputId: input.inputId } : {}),
			},
			refs: {},
		};
	}
	if (input.kind === "REDUNDANT_RTMP") {
		return {
			step,
			kind: "CREATE_INPUT_REDUNDANT_RTMP",
			payload: {
				name: input.name,
				...(input.delayThreshold !== undefined
					? { delayThreshold: input.delayThreshold }
					: {}),
				// Schema XOR guarantees exactly one list below.
				...(input.ingestPoints ? { ingestPoints: input.ingestPoints } : {}),
				...(input.staticIngestPoints
					? { staticIngestPoints: input.staticIngestPoints }
					: {}),
			},
			refs: {},
		};
	}
	if (input.kind === "SRT") {
		const connection = (srt: {
			mode: "LISTENER" | "CALLER";
			host?: string;
			port: number;
			path?: string;
			latency?: number;
			credentialId?: string;
			keyLength?: 128 | 256;
		}) => ({
			mode: srt.mode,
			...(srt.host ? { host: srt.host } : {}),
			port: srt.port,
			...(srt.path ? { path: srt.path } : {}),
			...(srt.latency !== undefined ? { latency: srt.latency } : {}),
			// Vault SRT passphrase — resolved at execution time only.
			...(srt.credentialId ? { credentialId: srt.credentialId } : {}),
			...(srt.keyLength !== undefined ? { keyLength: srt.keyLength } : {}),
		});
		return {
			step,
			kind: "CREATE_INPUT_SRT",
			payload: {
				name: input.name,
				...connection(input),
				...(input.backup
					? {
							backupSrtInputs: {
								...(input.backup.delayThreshold !== undefined
									? { delayThreshold: input.backup.delayThreshold }
									: {}),
								srtInputs: input.backup.srtInputs.map(connection),
							},
						}
					: {}),
			},
			refs: {},
		};
	}
	if (input.kind === "ZIXI") {
		return {
			step,
			kind: "CREATE_INPUT_ZIXI",
			payload: {
				name: input.name,
				host: input.host,
				port: input.port,
				stream: input.stream,
				// Vault Zixi password/decryptionKey — resolved at execution.
				credentialId: input.credentialId,
				...(input.latency !== undefined ? { latency: input.latency } : {}),
				...(input.minBitrate !== undefined
					? { minBitrate: input.minBitrate }
					: {}),
				...(input.decryptionType
					? { decryptionType: input.decryptionType }
					: {}),
			},
			refs: {},
		};
	}
	if (input.kind === "HLS") {
		return {
			step,
			kind: "CREATE_INPUT_HLS_LIVE",
			payload: {
				name: input.name,
				...(input.url ? { url: input.url } : {}),
				...(input.adMarkersSource
					? { adMarkersSource: input.adMarkersSource }
					: {}),
			},
			refs: {},
		};
	}
	return unreachable(input);
}

/**
 * Codec-config payloads. Field mapping mirrors plan/compiler.ts (same SDK
 * enum NAMES, same omission rules) for the live-supported codecs — keep
 * both in sync when the rendition schemas widen.
 */
function codecPayload(rendition: PlanRendition): Record<string, unknown> {
	if (rendition.codec === "H264") {
		return {
			name: rendition.name,
			height: rendition.height,
			...(rendition.width !== undefined ? { width: rendition.width } : {}),
			...(rendition.bitrate !== null ? { bitrate: rendition.bitrate } : {}),
			level: rendition.level,
			...(rendition.presetConfiguration !== null
				? { presetConfiguration: rendition.presetConfiguration }
				: {}),
			...(rendition.profile ? { profile: rendition.profile } : {}),
			...(rendition.rate !== undefined ? { rate: rendition.rate } : {}),
			...(rendition.minKeyframeInterval !== undefined
				? { minKeyframeInterval: rendition.minKeyframeInterval }
				: {}),
			...(rendition.maxKeyframeInterval !== undefined
				? { maxKeyframeInterval: rendition.maxKeyframeInterval }
				: {}),
			...(rendition.slices !== undefined ? { slices: rendition.slices } : {}),
			...(rendition.trellis ? { trellis: rendition.trellis } : {}),
			...(rendition.mvSearchRangeMax !== undefined
				? { mvSearchRangeMax: rendition.mvSearchRangeMax }
				: {}),
			...(rendition.rcLookahead !== undefined
				? { rcLookahead: rendition.rcLookahead }
				: {}),
			...(rendition.subMe ? { subMe: rendition.subMe } : {}),
			...(rendition.motionEstimationMethod
				? { motionEstimationMethod: rendition.motionEstimationMethod }
				: {}),
			...(rendition.sceneCutThreshold !== undefined
				? { sceneCutThreshold: rendition.sceneCutThreshold }
				: {}),
			...(rendition.adaptiveQuantizationMode
				? { adaptiveQuantizationMode: rendition.adaptiveQuantizationMode }
				: {}),
			...(rendition.adaptiveQuantizationStrength !== undefined
				? {
						adaptiveQuantizationStrength:
							rendition.adaptiveQuantizationStrength,
					}
				: {}),
			...(rendition.mvPredictionMode
				? { mvPredictionMode: rendition.mvPredictionMode }
				: {}),
			...(rendition.psyRateDistortionOptimization !== undefined
				? {
						psyRateDistortionOptimization:
							rendition.psyRateDistortionOptimization,
					}
				: {}),
			...(rendition.psyTrellis !== undefined
				? { psyTrellis: rendition.psyTrellis }
				: {}),
			...(rendition.refFrames !== undefined
				? { refFrames: rendition.refFrames }
				: {}),
			...(rendition.bframes !== undefined
				? { bframes: rendition.bframes }
				: {}),
			...(rendition.cabac !== undefined ? { cabac: rendition.cabac } : {}),
			...(rendition.adaptiveSpatialTransform !== undefined
				? { adaptiveSpatialTransform: rendition.adaptiveSpatialTransform }
				: {}),
			...(rendition.weightedPredictionPFrames
				? { weightedPredictionPFrames: rendition.weightedPredictionPFrames }
				: {}),
			...(rendition.colorConfig ? { colorConfig: rendition.colorConfig } : {}),
		};
	}
	if (rendition.codec === "H265") {
		return {
			...(rendition.name ? { name: rendition.name } : {}),
			...(rendition.profile ? { profile: rendition.profile } : {}),
			height: rendition.height,
			bitrate: rendition.bitrate,
			level: rendition.level,
			...(rendition.pixelFormat ? { pixelFormat: rendition.pixelFormat } : {}),
			...(rendition.rate !== undefined ? { rate: rendition.rate } : {}),
			...(rendition.minKeyframeInterval !== undefined
				? { minKeyframeInterval: rendition.minKeyframeInterval }
				: {}),
			...(rendition.maxKeyframeInterval !== undefined
				? { maxKeyframeInterval: rendition.maxKeyframeInterval }
				: {}),
			...(rendition.rcLookahead !== undefined
				? { rcLookahead: rendition.rcLookahead }
				: {}),
			...(rendition.subMe !== undefined ? { subMe: rendition.subMe } : {}),
			// REST/SDK field really is capital-CTU (H265VideoConfiguration).
			...(rendition.maxCtuSize ? { maxCTUSize: rendition.maxCtuSize } : {}),
			...(rendition.motionSearch
				? { motionSearch: rendition.motionSearch }
				: {}),
			...(rendition.tuIntraDepth
				? { tuIntraDepth: rendition.tuIntraDepth }
				: {}),
			...(rendition.tuInterDepth
				? { tuInterDepth: rendition.tuInterDepth }
				: {}),
			...(rendition.weightPredictionOnPSlice !== undefined
				? { weightPredictionOnPSlice: rendition.weightPredictionOnPSlice }
				: {}),
			...(rendition.weightPredictionOnBSlice !== undefined
				? { weightPredictionOnBSlice: rendition.weightPredictionOnBSlice }
				: {}),
			...(rendition.sceneCutThreshold !== undefined
				? { sceneCutThreshold: rendition.sceneCutThreshold }
				: {}),
			...(rendition.motionSearchRange !== undefined
				? { motionSearchRange: rendition.motionSearchRange }
				: {}),
			...(rendition.adaptiveQuantizationMode
				? { adaptiveQuantizationMode: rendition.adaptiveQuantizationMode }
				: {}),
			...(rendition.adaptiveQuantizationStrength !== undefined
				? {
						adaptiveQuantizationStrength:
							rendition.adaptiveQuantizationStrength,
					}
				: {}),
			...(rendition.psyRateDistortionOptimization !== undefined
				? {
						psyRateDistortionOptimization:
							rendition.psyRateDistortionOptimization,
					}
				: {}),
			...(rendition.psyRateDistortionOptimizedQuantization !== undefined
				? {
						psyRateDistortionOptimizedQuantization:
							rendition.psyRateDistortionOptimizedQuantization,
					}
				: {}),
			...(rendition.qpMin !== undefined ? { qpMin: rendition.qpMin } : {}),
			...(rendition.sao !== undefined ? { sao: rendition.sao } : {}),
			...(rendition.hdr !== undefined ? { hdr: rendition.hdr } : {}),
			...(rendition.masterDisplay
				? { masterDisplay: rendition.masterDisplay }
				: {}),
			...(rendition.maxContentLightLevel !== undefined
				? { maxContentLightLevel: rendition.maxContentLightLevel }
				: {}),
			...(rendition.maxPictureAverageLightLevel !== undefined
				? {
						maxPictureAverageLightLevel: rendition.maxPictureAverageLightLevel,
					}
				: {}),
			...(rendition.colorConfig ? { colorConfig: rendition.colorConfig } : {}),
			...(rendition.presetConfiguration
				? { presetConfiguration: rendition.presetConfiguration }
				: {}),
			...(rendition.maxBitrate !== undefined
				? { maxBitrate: rendition.maxBitrate }
				: {}),
			...(rendition.bufsize !== undefined
				? { bufsize: rendition.bufsize }
				: {}),
			...(rendition.dynamicRangeFormat
				? { dynamicRangeFormat: rendition.dynamicRangeFormat }
				: {}),
			...(rendition.levelHighTier !== undefined
				? { levelHighTier: rendition.levelHighTier }
				: {}),
		};
	}
	if (
		rendition.codec === "AAC" ||
		rendition.codec === "DDPLUS" ||
		rendition.codec === "DD"
	) {
		return {
			...(rendition.name ? { name: rendition.name } : {}),
			bitrate: rendition.bitrate,
			rate: rendition.rate,
			channelLayout: rendition.channelLayout,
		};
	}
	return unsupportedCodec(rendition.codec);
}

function codecKind(
	rendition: PlanRendition,
):
	| "CREATE_CODEC_H264"
	| "CREATE_CODEC_H265"
	| "CREATE_CODEC_AAC"
	| "CREATE_CODEC_DDPLUS"
	| "CREATE_CODEC_DD" {
	switch (rendition.codec) {
		case "H264":
			return "CREATE_CODEC_H264";
		case "H265":
			return "CREATE_CODEC_H265";
		case "AAC":
			return "CREATE_CODEC_AAC";
		case "DDPLUS":
			return "CREATE_CODEC_DDPLUS";
		case "DD":
			return "CREATE_CODEC_DD";
		default:
			return unsupportedCodec(rendition.codec);
	}
}

export function compileLiveChannel(plan: LiveChannelPlan): CompiledOperation[] {
	const versionError = checkMslEncoderVersion(
		plan.outputs,
		plan.bitmovin.encoderVersion,
	).find((issue) => issue.level === "error");
	if (versionError) throw new MslEncoderVersionError(versionError);
	const encodingOption = resolveLiveEncodingOption(plan);
	if (
		plan.start.encodingOption === "HD" &&
		encodingOption.encodingOption !== "HD"
	)
		throw new Error(
			`Live HD is incompatible: ${encodingOption.reasons.map((reason) => reason.code).join(", ")}`,
		);
	const ops: CompiledOperation[] = [];
	const inputStep = `live-input:${plan.liveInput.key}`;
	// C14: a single opt-in toggle drives every SCTE-35 carrier (fMP4 emsg +
	// per-manifest start adMarkerSettings). Absent/false ⇒ no new payload keys.
	const scte35 = plan.adMarkers?.scte35 === true;

	// 1. The live input and the outputs (account-level resources).
	ops.push(compileLiveInput(plan));
	for (const output of plan.outputs) {
		if (output.kind === "S3") {
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_S3",
				payload: {
					name: output.name,
					credentialId: output.credentialId,
					bucketName: output.bucket,
				},
				refs: {},
			});
		} else if (output.kind === "AZURE") {
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_AZURE",
				payload: {
					name: output.name,
					credentialId: output.credentialId,
					container: output.container,
				},
				refs: {},
			});
		} else if (output.kind === "SFTP") {
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_SFTP",
				payload: { name: output.name, credentialId: output.credentialId },
				refs: {},
			});
		} else if (output.kind === "GENERIC_S3") {
			// S3-compatible (Akamai/OCI/GenericS3) — secret-free payload, host/keys
			// resolve from the credential at execution (C10).
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_GENERIC_S3",
				payload: {
					name: output.name,
					credentialId: output.credentialId,
					bucketName: output.bucket,
				},
				refs: {},
			});
		} else if (output.kind === "GCS") {
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_GCS",
				payload: {
					name: output.name,
					credentialId: output.credentialId,
					bucketName: output.bucket,
					...(output.region !== undefined
						? { cloudRegion: output.region }
						: {}),
				},
				refs: {},
			});
		} else if (output.kind === "LIVE_MEDIA_INGEST") {
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_LIVE_MEDIA_INGEST",
				payload: {
					name: output.name,
					credentialId: output.credentialId,
					scte35Passthrough: output.scte35Passthrough,
				},
				refs: {},
			});
		} else if (output.kind === "AKAMAI_MSL") {
			//  — the reason this row exists. A live channel had no
			// way to reach Akamai's ingest at all; the only Akamai path was
			// "write to object storage and serve from there", which is not the
			// live topology. No credentialId: the provisioned stream id and
			// event name are the identity.
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_AKAMAI_MSL",
				payload: {
					name: output.name,
					// The stream id and event name are resolved from the vault
					// at execution time, exactly as every other output's
					// address is . The plan carries the reference.
					credentialId: output.credentialId,
					streamFormat: output.streamFormat,
					mslVersion: output.mslVersion,
				},
				refs: {},
			});
		} else if (output.kind === "GCS_SERVICE_ACCOUNT") {
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_GCS_SERVICE_ACCOUNT",
				payload: {
					name: output.name,
					credentialId: output.credentialId,
					bucketName: output.bucket,
					...(output.region !== undefined
						? { cloudRegion: output.region }
						: {}),
				},
				refs: {},
			});
		} else if (output.kind === "AKAMAI_NETSTORAGE") {
			//  — same shape as VOD: credential id only, no bucket.
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_AKAMAI_NETSTORAGE",
				payload: { name: output.name, credentialId: output.credentialId },
				refs: {},
			});
		} else {
			unreachable(output);
		}
	}

	// 2. The encoding (LIVE is decided by the start call, not at create).
	ops.push({
		step: ENCODING_STEP,
		kind: "CREATE_ENCODING",
		payload: {
			name: plan.name,
			cloudRegion: plan.bitmovin.cloudRegion,
			encoderVersion: plan.bitmovin.encoderVersion,
			...(plan.bitmovin.staticIpId
				? { staticIpId: plan.bitmovin.staticIpId }
				: {}),
			...(plan.bitmovin.labels?.length ? { labels: plan.bitmovin.labels } : {}),
			...(plan.bitmovin.infrastructure
				? { infrastructure: plan.bitmovin.infrastructure }
				: {}),
		},
		refs: {},
	});

	// 3. Per rendition: codec config → stream → its muxings (VOD order).
	//    Live streams reference the live input DIRECTLY on their StreamInput
	//    (inputId + inputPath + position) — NOT a standalone IngestInputStream.
	//    live/start cannot resolve an IngestInputStream built on the account
	//    RTMP input (it 2025s on the ingest-stream id); the working Akamai
	//    sample and bitmovin-live templates inline the selection per stream:
	//    video position 0, audio position 1 (C13). plan.ingest survives only as
	//    the per-ingestKey selection spec, looked up here and inlined.
	const ingestByKey = new Map(plan.ingest.map((entry) => [entry.key, entry]));
	const liveRenditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
	/**
	 * WHERE each muxing op may be emitted — the VOD compiler's rule, applied to
	 * the live tree for the same reason: refs resolve against ids created by
	 * EARLIER steps, so a container multiplexing two renditions must wait for
	 * the last of them. Single-stream containers keep their old position, which
	 * is what leaves the 12 live goldens untouched.
	 *
	 * Indexed by POSITION for the same reason as VOD: a key-keyed Map discards
	 * duplicates, and the live preview also compiles unvalidated state.
	 */
	const muxingEmitsOn = plan.muxings.map((m) => {
		let latest = m.streamKey;
		let latestAt = -1;
		for (const key of muxingStreamKeys(m)) {
			const at = plan.renditions.findIndex((r) => r.key === key);
			if (at > latestAt) {
				latestAt = at;
				latest = key;
			}
		}
		return latest;
	});
	for (const rendition of plan.renditions) {
		ops.push({
			step: `codec:${rendition.key}`,
			kind: codecKind(rendition),
			payload: codecPayload(rendition),
			refs: {},
		});
		const selection = ingestByKey.get(rendition.ingestKey);
		ops.push({
			step: `stream:${rendition.key}`,
			kind: "CREATE_STREAM",
			payload: {
				name: rendition.streamName ?? streamName(rendition),
				// validateLiveChannel pins STANDARD (per-title is VOD-only).
				mode: isLiveVideoCodec(rendition) ? rendition.mode : "STANDARD",
				...(rendition.conditions ? { conditions: rendition.conditions } : {}),
				// Inline StreamInput selection (no IngestInputStream resource).
				inputPath: selection?.inputPath ?? "live",
				position: selection?.position ?? 0,
			},
			refs: {
				encodingId: ENCODING_STEP,
				codecConfigId: `codec:${rendition.key}`,
				inputId: inputStep,
			},
		});
		for (const [muxingAt, muxing] of plan.muxings.entries()) {
			if (muxingEmitsOn[muxingAt] !== rendition.key) {
				continue;
			}
			// Names follow the container's OWN rendition, which differs from
			// `rendition` only when this muxing is emitted on a muxed-in stream.
			const primary = liveRenditionByKey.get(muxing.streamKey) ?? rendition;
			// Live muxings always carry their destination (no DRM in PR1 to
			// own the output) — validateLiveChannel errors otherwise.
			const destinationFields = muxing.destination
				? {
						outputPath: muxing.destination.path,
						...(muxing.destination.acl ? { acl: muxing.destination.acl } : {}),
					}
				: {};
			const extraStreamKeys = muxingStreamKeys(muxing).slice(1);
			const muxingRefs = {
				encodingId: ENCODING_STEP,
				streamId: `stream:${muxing.streamKey}`,
				...(extraStreamKeys.length > 0
					? {
							additionalStreamIds: extraStreamKeys.map(
								(key) => `stream:${key}`,
							),
						}
					: {}),
				...(muxing.destination
					? {
							outputId: `output:${muxing.destination.outputKey}`,
							...mirrorOutputRefs(plan, muxing.destination.outputKey),
						}
					: {}),
			};
			if (muxing.kind === "FMP4" || muxing.kind === "CMAF") {
				ops.push({
					step: `muxing:${muxing.key}`,
					kind:
						muxing.kind === "CMAF"
							? "CREATE_MUXING_CMAF"
							: "CREATE_MUXING_FMP4",
					payload: {
						segmentLength: muxing.segmentLength,
						/*
						 * Mutually exclusive at the wire (SDK: "if
						 * segmentNamingTemplate is set, segmentNaming must not
						 * be set"). Bitmovin expands the template and copies
						 * the result into segmentNaming itself.
						 */
						...(muxing.segmentNamingTemplate
							? { segmentNamingTemplate: muxing.segmentNamingTemplate }
							: { segmentNaming: muxing.segmentNaming }),
						...(muxing.kind === "CMAF" && muxing.initSegmentNameTemplate
							? { initSegmentNameTemplate: muxing.initSegmentNameTemplate }
							: { initSegmentName: muxing.initSegmentName }),
						...(muxing.kind === "CMAF" &&
						muxing.framesPerCmafChunk !== undefined
							? { framesPerCmafChunk: muxing.framesPerCmafChunk }
							: {}),
						...destinationFields,
						// C14: emsg boxes are the segment-level SCTE-35 carrier (and the
						// only one for HLS-fMP4) — emitted only when ad markers are on,
						// so default plans stay byte-identical.
						...(scte35 && muxing.kind === "FMP4"
							? { signalScte35AsEmsg: true }
							: {}),
						name: muxing.name ?? muxingName(muxing.kind, primary),
					},
					refs: muxingRefs,
				});
			} else if (muxing.kind === "TS") {
				ops.push({
					step: `muxing:${muxing.key}`,
					kind: "CREATE_MUXING_TS",
					payload: {
						segmentLength: muxing.segmentLength,
						/*
						 * Mutually exclusive at the wire (SDK: "if
						 * segmentNamingTemplate is set, segmentNaming must not
						 * be set"). Bitmovin expands the template and copies
						 * the result into segmentNaming itself.
						 */
						...(muxing.segmentNamingTemplate
							? { segmentNamingTemplate: muxing.segmentNamingTemplate }
							: { segmentNaming: muxing.segmentNaming }),
						...destinationFields,
						name: muxing.name ?? muxingName("TS", primary),
					},
					refs: muxingRefs,
				});
			} else if (muxing.kind === "MP4") {
				ops.push({
					step: `muxing:${muxing.key}`,
					kind: "CREATE_MUXING_MP4",
					payload: {
						filename: muxing.filename,
						...destinationFields,
						name: muxing.name ?? muxingName("MP4", primary),
					},
					refs: muxingRefs,
				});
			} else {
				unreachable(muxing);
			}
		}
	}

	// 4. Pre-created manifests (referenced by manifestId in the start
	//    request — never started: the live encoder generates them).
	for (const manifest of plan.liveManifests) {
		ops.push(
			...(manifest.kind === "HLS"
				? compileLiveHlsManifest(plan, manifest)
				: compileLiveDashManifest(plan, manifest)),
		);
	}

	// 5. Start (field order mirrors StartLiveEncodingRequest) + await.
	const hlsManifests = plan.liveManifests.filter((m) => m.kind === "HLS");
	const dashManifests = plan.liveManifests.filter((m) => m.kind === "DASH");
	const start = plan.start;
	ops.push({
		step: START_STEP,
		kind: "START_LIVE_ENCODING",
		payload: {
			streamKey: start.streamKey,
			...(start.encodingOption !== undefined
				? { encodingOption: encodingOption.encodingOption }
				: {}),
			...(hlsManifests.length > 0
				? {
						// Per-manifest start options keyed by PLAN manifest key —
						// entries exist for every referenced manifest (empty = all
						// API defaults) so the executor's lookup is total.
						hlsManifests: Object.fromEntries(
							hlsManifests.map((m) => [
								m.key,
								{
									...(m.timeshift !== undefined
										? { timeshift: m.timeshift }
										: {}),
									...(m.liveEdgeOffset !== undefined
										? { liveEdgeOffset: m.liveEdgeOffset }
										: {}),
									...(m.insertProgramDateTime !== undefined
										? { insertProgramDateTime: m.insertProgramDateTime }
										: {}),
									...(m.programDateTimeSettings
										? { programDateTimeSettings: m.programDateTimeSettings }
										: {}),
									// C14: #EXT-X-DATERANGE is the broadly-compatible HLS ad
									// marker default (carries the raw SCTE-35 trigger; works
									// with EXT-X-PROGRAM-DATE-TIME); plan.adMarkers can widen
									// the type set / add disablePreannouncing (P5 PR-3) —
									// absent knobs keep the exact C14 payload.
									...(scte35
										? {
												adMarkerSettings: {
													enabledMarkerTypes: plan.adMarkers
														?.hlsMarkerTypes ?? ["EXT_X_DATERANGE"],
													...(plan.adMarkers?.hlsDisablePreannouncing !==
													undefined
														? {
																disablePreannouncing:
																	plan.adMarkers.hlsDisablePreannouncing,
															}
														: {}),
												},
											}
										: {}),
								},
							]),
						),
					}
				: {}),
			...(dashManifests.length > 0
				? {
						dashManifests: Object.fromEntries(
							dashManifests.map((m) => [
								m.key,
								{
									...(m.timeshift !== undefined
										? { timeshift: m.timeshift }
										: {}),
									...(m.liveEdgeOffset !== undefined
										? { liveEdgeOffset: m.liveEdgeOffset }
										: {}),
									...(m.suggestedPresentationDelay !== undefined
										? {
												suggestedPresentationDelay:
													m.suggestedPresentationDelay,
											}
										: {}),
									...(m.minimumUpdatePeriod !== undefined
										? { minimumUpdatePeriod: m.minimumUpdatePeriod }
										: {}),
									...(m.availabilityStartTimeMode
										? {
												availabilityStartTimeMode: m.availabilityStartTimeMode,
											}
										: {}),
									// C14: SINGLE_PERIOD keeps one continuous period and signals
									// cues via a DASH EventStream (XML_BIN = the binary SCTE-35
									// splice info as a Signal.Binary element); plan.adMarkers
									// can override both knobs (P5 PR-3).
									...(scte35
										? {
												adMarkerSettings: {
													periodOption:
														plan.adMarkers?.dashPeriodOption ?? "SINGLE_PERIOD",
													eventStreamSignalling:
														plan.adMarkers?.dashEventStreamSignalling ??
														"XML_BIN",
												},
											}
										: {}),
								},
							]),
						),
					}
				: {}),
			...(start.liveEncodingMode
				? { liveEncodingMode: start.liveEncodingMode }
				: {}),
			...(start.reupload ? { reuploadSettings: start.reupload } : {}),
			// C3: always V2 — immutable after start, so never left to the
			// org-level default.
			manifestGenerator: "V2",
			...(start.autoRestart
				? { autoRestartConfiguration: start.autoRestart }
				: {}),
			...(start.autoShutdown
				? { autoShutdownConfiguration: start.autoShutdown }
				: {}),
			// P5 PR-3 start surfaces — absent ⇒ zero payload keys (goldens
			// byte-identical). esamSettings carries the vault REF only; the
			// executor resolves the POIS username/password at start (S1–S5).
			...(start.esam ? { esamSettings: start.esam } : {}),
			...(start.cacheControl
				? { cacheControlSettings: start.cacheControl }
				: {}),
			...(start.adInsertion ? { adInsertionSettings: start.adInsertion } : {}),
		},
		refs: {
			encodingId: ENCODING_STEP,
			...(hlsManifests.length > 0
				? { liveHlsManifestIds: hlsManifests.map((m) => `manifest:${m.key}`) }
				: {}),
			...(dashManifests.length > 0
				? {
						liveDashManifestIds: dashManifests.map((m) => `manifest:${m.key}`),
					}
				: {}),
		},
	});
	ops.push({
		step: AWAIT_STEP,
		kind: "AWAIT_LIVE_RUNNING",
		payload: {},
		refs: { encodingId: ENCODING_STEP },
	});

	return ops;
}

function compileLiveHlsManifest(
	plan: LiveChannelPlan,
	manifest: Extract<LiveManifestPlan, { kind: "HLS" }>,
): CompiledOperation[] {
	const manifestStep = `manifest:${manifest.key}`;
	const ops: CompiledOperation[] = [
		{
			step: manifestStep,
			kind: "CREATE_MANIFEST_HLS",
			payload: {
				manifestName: manifest.manifestName,
				name: manifest.name,
				...manifestOutputPaths(plan, manifest),
				...(manifest.destination.acl ? { acl: manifest.destination.acl } : {}),
			},
			refs: {
				outputId: `output:${manifest.destination.outputKey}`,
				...mirrorOutputRefs(plan, manifest.destination.outputKey),
			},
		},
	];
	const selected = selectLiveManifestMuxings(plan, manifest);
	// Counted over THIS manifest's selection, not the channel's renditions
	// (review-323 I1's live twin): a manifest that pins `audioMuxingKind`
	// lists one leg, and the other leg's audio is not in its group.
	const audioEntries = selected.filter(({ rendition }) =>
		isLiveAudioCodec(rendition),
	).length;
	const entryUris = liveHlsEntryUris(plan);
	for (const { muxing, rendition } of selected) {
		const segmentPath = relativeSegmentPath(
			muxing.destination?.path ?? "",
			manifest.destination.path,
		);
		const refs = {
			manifestId: manifestStep,
			encodingId: ENCODING_STEP,
			streamId: `stream:${rendition.key}`,
			muxingId: `muxing:${muxing.key}`,
		};
		if (isLiveAudioCodec(rendition)) {
			ops.push({
				step: `hls-media:${manifest.key}:${muxing.key}`,
				kind: "CREATE_HLS_AUDIO_MEDIA",
				payload: {
					// Unique within the group when the channel carries more than
					// one audio rendition (AWS Live A/B/E
					// and MSL4 M2 all published two entries named identically).
					// One audio keeps the vendor literal, so every live golden is
					// byte-identical.
					name:
						audioEntries > 1
							? `HLS Audio Media (${rendition.key})`
							: "HLS Audio Media",
					groupId: manifest.audioGroupId,
					language: manifest.audioLanguage,
					segmentPath,
					uri: entryUris.get(rendition.key) ?? liveHlsEntryUri(rendition),
				},
				refs,
			});
		} else {
			// C33, same rule as VOD: a variant carrying its own audio has no
			// EXT-X-MEDIA group to name, because the muxed-in audio rendition
			// owns no muxing and so produces no audio media entry above.
			const muxedIn = hasMuxedInAudio(
				muxing,
				new Map(plan.renditions.map((r) => [r.key, r])),
			);
			ops.push({
				step: `hls-variant:${manifest.key}:${muxing.key}`,
				kind: "CREATE_HLS_STREAM_INFO",
				payload: {
					...(muxedIn ? {} : { audio: manifest.audioGroupId }),
					closedCaptions: manifest.closedCaptions,
					segmentPath,
					// LIVE_RENDITION_BITRATE_REQUIRED guarantees non-null here.
					uri: entryUris.get(rendition.key) ?? liveHlsEntryUri(rendition),
				},
				refs,
			});
		}
	}
	return ops;
}

function compileLiveDashManifest(
	plan: LiveChannelPlan,
	manifest: Extract<LiveManifestPlan, { kind: "DASH" }>,
): CompiledOperation[] {
	const manifestStep = `manifest:${manifest.key}`;
	const periodStep = `${manifestStep}:period`;
	const videoSetStep = `${manifestStep}:aset-video`;
	const audioSetStep = `${manifestStep}:aset-audio`;
	const selected = selectLiveManifestMuxings(plan, manifest);
	/*
	 * One VIDEO adaptation set PER CODEC — the same rule the VOD compiler
	 * follows, landing here because live was
	 * left behind by it. This branch put every
	 * video representation into ONE `aset-video` regardless of codec, and the
	 * provider refuses a mixed set: paid case F (H264+H265 on one live channel)
	 * encoded and then died on the FIRST H265 representation added beside the
	 * H264 ones, so that topology was undeliverable over DASH.
	 *
	 * Derived from `selected`, so the codec order — and therefore the step ids
	 * and their emission order — is a function of the plan's muxing order and
	 * nothing else. A single-codec channel keeps the historical `aset-video`
	 * step id, which is why all fourteen pre-existing live goldens are
	 * byte-identical; only a channel that actually mixes codecs gains
	 * `aset-video-<codec>` sets.
	 */
	const videoCodecs = [
		...new Set(
			selected
				.filter(({ rendition }) => isLiveVideoCodec(rendition))
				.map(({ rendition }) => rendition.codec),
		),
	];
	const mixedCodecs = videoCodecs.length > 1;
	const videoSetStepFor = (codec: string): string =>
		mixedCodecs ? `${videoSetStep}-${codec.toLowerCase()}` : videoSetStep;
	const hasAudio = selected.some(({ rendition }) =>
		isLiveAudioCodec(rendition),
	);
	const ops: CompiledOperation[] = [
		{
			step: manifestStep,
			kind: "CREATE_MANIFEST_DASH",
			// No profile field: the API default (LIVE) is the live profile —
			// ON_DEMAND is the VOD single-MP4 family.
			payload: {
				manifestName: manifest.manifestName,
				name: manifest.name,
				...manifestOutputPaths(plan, manifest),
				...(manifest.destination.acl ? { acl: manifest.destination.acl } : {}),
			},
			refs: {
				outputId: `output:${manifest.destination.outputKey}`,
				...mirrorOutputRefs(plan, manifest.destination.outputKey),
			},
		},
		{
			step: periodStep,
			kind: "CREATE_DASH_PERIOD",
			// New Live manifests have one initial Period; saved/VOD steps keep their payload.
			payload: { start: 0 },
			refs: { manifestId: manifestStep },
		},
	];
	// Empty when this manifest lists no video muxing, which is exactly the old
	// `hasVideo` gate — one set per codec otherwise.
	for (const codec of videoCodecs) {
		ops.push({
			step: videoSetStepFor(codec),
			kind: "CREATE_DASH_ADAPTATION_SET_VIDEO",
			payload: {},
			refs: { manifestId: manifestStep, periodId: periodStep },
		});
	}
	if (hasAudio) {
		ops.push({
			step: audioSetStep,
			kind: "CREATE_DASH_ADAPTATION_SET_AUDIO",
			payload: { lang: manifest.audioLanguage },
			refs: { manifestId: manifestStep, periodId: periodStep },
		});
	}
	for (const { muxing, rendition } of selected) {
		ops.push({
			step: `${manifestStep}:rep:${muxing.key}`,
			kind:
				muxing.kind === "CMAF"
					? "CREATE_DASH_REPRESENTATION_CMAF"
					: "CREATE_DASH_REPRESENTATION_FMP4",
			payload: {
				type: manifest.representationType,
				mode: "TEMPLATE_REPRESENTATION",
				segmentPath: relativeSegmentPath(
					muxing.destination?.path ?? "",
					manifest.destination.path,
				),
			},
			refs: {
				manifestId: manifestStep,
				periodId: periodStep,
				adaptationSetId: isLiveVideoCodec(rendition)
					? videoSetStepFor(rendition.codec)
					: audioSetStep,
				encodingId: ENCODING_STEP,
				muxingId: `muxing:${muxing.key}`,
			},
		});
	}
	return ops;
}
