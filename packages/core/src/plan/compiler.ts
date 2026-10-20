import { dashAudioLegSelected, dashVideoLegSelected } from "./dash-legs";
import {
	type HlsAudioMediaDefaults,
	hlsAudioLegsByRendition,
	hlsAudioMediaDefaults,
	hlsChildEntries,
	hlsIframeUris,
	hlsSubtitleGroups,
	hlsVariantUri,
} from "./hls-media-defaults";
import { filterParameters } from "./media-filters";
import { hasMuxedInAudio, muxingStreamKeys } from "./muxing-streams";
import {
	isPerTitleRendition,
	PER_TITLE_CAPTURE_STEP,
	PER_TITLE_RESULT_MODE,
	perTitleTemplates,
	planHasPerTitle,
} from "./per-title-results";
import { qcMirrorFilename, qcMirrorMuxingKind } from "./qc-mirror";
import type { EncodingPlan, PlanRendition } from "./schema";
import { AUDIO_CODECS } from "./schema";

/**
 * Compiles an EncodingPlan into the ordered Bitmovin operation list the
 * orchestrator executes (ARCHITECTURE §3). The sequence replicates the
 * encoding examples fixed-bitrate family exactly — those scripts are the
 * acceptance fixtures, and the golden tests pin this output.
 *
 * Operations are pure data: `payload` carries SDK-shaped fields (never
 * secrets — credentials stay vault references), `refs` names earlier steps
 * whose created resource ids the orchestrator substitutes at execution.
 * compilePlan assumes a schema-parsed, validatePlan-clean plan.
 *
 * Ref-key semantics for the orchestrator (PR8):
 * - encodingId / manifestId / periodId / adaptationSetId → URL path params
 * - inputId / outputId / codecConfigId / inputStreamId / streamId /
 *   muxingId → body fields (streamId wraps into MuxingStream, outputId +
 *   outputPath + acl into EncodingOutput with [AclEntry], inputStreamId
 *   into [StreamInput])
 * - vodHlsManifestIds / vodDashManifestIds → StartEncodingRequest
 *   vodHlsManifests/vodDashManifests as [ManifestResource]
 * - credentialId in payloads → resolve via the vault (S3 access/secret,
 *   SFTP host/port/username/password) at execution time only.
 */

export type OperationKind =
	| "CREATE_INPUT_S3"
	| "CREATE_INPUT_AZURE"
	| "CREATE_INPUT_HTTPS"
	| "CREATE_INPUT_GENERIC_S3"
	| "CREATE_INPUT_GCS"
	| "CREATE_INPUT_GCS_SERVICE_ACCOUNT"
	| "CREATE_INPUT_AKAMAI_NETSTORAGE"
	| "CREATE_OUTPUT_S3"
	| "CREATE_OUTPUT_AZURE"
	| "CREATE_OUTPUT_SFTP"
	| "CREATE_OUTPUT_GENERIC_S3"
	| "CREATE_OUTPUT_GCS"
	| "CREATE_OUTPUT_GCS_SERVICE_ACCOUNT"
	| "CREATE_OUTPUT_AKAMAI_NETSTORAGE"
	| "CREATE_OUTPUT_LIVE_MEDIA_INGEST"
	| "CREATE_OUTPUT_AKAMAI_MSL"
	| "CREATE_ENCODING"
	| "CREATE_INGEST_INPUT_STREAM"
	| "CREATE_FILE_INPUT_STREAM"
	| "CREATE_DOLBY_ATMOS_INPUT_STREAM"
	| "CREATE_DOLBY_VISION_INPUT_STREAM"
	| "CREATE_DOLBY_VISION_METADATA_INPUT_STREAM"
	| "CREATE_TRIMMING_TIME_BASED"
	| "CREATE_TRIMMING_TIMECODE_TRACK"
	| "CREATE_TRIMMING_H264_PICTURE_TIMING"
	| "CREATE_CONCATENATION_INPUT_STREAM"
	| "CREATE_AUDIO_MIX_INPUT_STREAM"
	| "CREATE_CODEC_H264"
	| "CREATE_CODEC_H265"
	| "CREATE_CODEC_VP9"
	| "CREATE_CODEC_AV1"
	| "CREATE_CODEC_AAC"
	| "CREATE_CODEC_OPUS"
	| "CREATE_CODEC_IMSC"
	| "CREATE_CODEC_DOLBY_ATMOS"
	| "CREATE_CODEC_DDPLUS"
	| "CREATE_CODEC_DD"
	| "CREATE_CODEC_WEBVTT"
	| "CREATE_STREAM"
	| "CREATE_STREAM_HDR_DOLBY_VISION"
	| "CREATE_FILTER_DEINTERLACE"
	| "CREATE_BURN_IN_SRT"
	| "CREATE_DASH_ADAPTATION_SET_SUBTITLE"
	| "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT"
	| "CREATE_DASH_REPRESENTATION_IMSC"
	| "CREATE_FILTER_DENOISE_HQDN3D"
	| "CREATE_FILTER_UNSHARP"
	| "CREATE_FILTER_CROP"
	| "CREATE_FILTER_ROTATE"
	| "CREATE_FILTER_WATERMARK"
	| "CREATE_FILTER_TEXT"
	| "CREATE_FILTER_AUDIO_VOLUME"
	| "CREATE_FILTER_EBU_R128_SINGLE_PASS"
	| "CREATE_STREAM_FILTERS"
	| "CREATE_KEYFRAME"
	| "CREATE_MUXING_FMP4"
	| "CREATE_MUXING_CMAF"
	| "CREATE_MUXING_MP4"
	| "CREATE_MUXING_CHUNKED_TEXT"
	| "CREATE_MUXING_TEXT"
	| "CREATE_MUXING_TS"
	| "CREATE_MUXING_WEBM"
	| "CREATE_DRM_CENC"
	| "CREATE_DRM_FAIRPLAY"
	| "CREATE_DRM_SPEKE"
	| "CREATE_KANTAR_WATERMARK"
	| "CREATE_NEXGUARD_FILE_MARKER"
	| "CREATE_THUMBNAIL"
	| "CREATE_SPRITE"
	| "CREATE_MANIFEST_HLS"
	| "CREATE_HLS_AUDIO_MEDIA"
	| "CREATE_HLS_STREAM_INFO"
	| "CREATE_HLS_SUBTITLES_MEDIA"
	| "CREATE_HLS_IFRAME_PLAYLIST"
	| "CREATE_HLS_PER_TITLE_VARIANTS"
	| "CREATE_MANIFEST_DASH"
	| "CREATE_DASH_PERIOD"
	| "CREATE_DASH_ADAPTATION_SET_VIDEO"
	| "CREATE_DASH_ADAPTATION_SET_AUDIO"
	| "CREATE_DASH_REPRESENTATION_FMP4"
	| "CREATE_DASH_REPRESENTATION_CMAF"
	| "CREATE_DASH_REPRESENTATION_WEBM"
	| "CREATE_MUXING_PROGRESSIVE_WEBM"
	| "CREATE_DASH_REPRESENTATION_MP4"
	| "CREATE_DASH_PER_TITLE_REPRESENTATIONS"
	| "CREATE_DASH_CONTENT_PROTECTION"
	| "CREATE_MANIFEST_SMOOTH"
	| "CREATE_SMOOTH_REPRESENTATION_MP4"
	| "CREATE_SMOOTH_CONTENT_PROTECTION"
	| "CREATE_SMOOTH_PER_TITLE_ENTRIES"
	| "START_ENCODING"
	| "AWAIT_ENCODING"
	// Post-encoding READ, emitted only for per-title plans: captures the
	// PER_TITLE_RESULT streams the encoder produced (they exist only after the
	// run, and Bitmovin purges them after ~90 days — C7). Read-only, so a
	// crash-resume re-run is idempotent, and a failure is recorded in the
	// response rather than failing the job.
	| "CAPTURE_PER_TITLE_RESULTS"
	| "START_MANIFEST_HLS"
	| "AWAIT_MANIFEST_HLS"
	| "START_MANIFEST_DASH"
	| "AWAIT_MANIFEST_DASH"
	| "START_MANIFEST_SMOOTH"
	| "AWAIT_MANIFEST_SMOOTH"
	// P3 live kinds (emitted by live/compiler.ts only) — the union widens so
	// CompiledOperation/StepLog stay the single cross-package op contract.
	| "CREATE_INPUT_RTMP"
	| "CREATE_INPUT_REDUNDANT_RTMP"
	| "CREATE_INPUT_SRT"
	| "CREATE_INPUT_ZIXI"
	| "CREATE_INPUT_HLS_LIVE"
	| "START_LIVE_ENCODING"
	| "AWAIT_LIVE_RUNNING"
	// Post-provisioning runtime record (NOT a provisioning step): appended by
	// the live worker per inserted SCTE-35 cue (always status DONE; the replay
	// skips it). Kept in the shared union so the step log stays one contract.
	| "SCTE35_CUE"
	// Fired slate confirmation  — advisory, replay-skipped.
	// It records that the POST landed, NOT that anything aired:
	// downgraded it to status RUNNING and gave the three terminal verdicts
	// below their own kinds, after a provider entry went ERROR while this
	// entry sat DONE and the picture never changed (2026-08-29 audit HIGH-1).
	| "SLATE_INSERTED"
	// The provider CONFIRMED the scheduled insertion .
	| "SLATE_CONFIRMED"
	// The provider's scheduled entry reached ERROR — the slate insertion did not cover.
	| "SLATE_FAILED"
	// The confirmation deadline passed with the entry still unresolved: we
	// posted it and never learned what happened. Not a success, not a failure.
	| "SLATE_UNCONFIRMED"
	// Post-provisioning runtime record: one DONE entry per out-of-band ESAM
	// media point inserted into a RUNNING channel (see steplog.ts).
	| "ESAM_MEDIA_POINT";

export type CompiledOperation = {
	/** Stable unique id — the orchestrator's idempotency key per step. */
	step: string;
	kind: OperationKind;
	payload: Record<string, unknown>;
	refs: Record<string, string | string[]>;
	/**
	 * Deferred-group marker : "post-qc"
	 * ops wait for the QC gate verdict — the orchestrator stops BEFORE the
	 * first one, parks the job AWAITING_QC, and only the verdict (or a PR4
	 * override) lets the group run. Emitted ONLY when plan.qc.gate.onFail is
	 * BLOCK_MANIFESTS; every other plan compiles without the key, which is
	 * what keeps the 73 goldens byte-identical.
	 */
	phase?: "post-qc";
};

const ENCODING_STEP = "encoding";

function kbps(bitrate: number): string {
	return `${Math.round(bitrate / 1000)}kbps`;
}

/**
 * Resolve an input-stream key to its compiled step id within the shared
 * ingest-key namespace. A rendition `ingestKey` and a trimming/concat
 * `sourceKey` both point into this namespace; the longest-lived `ingest:`
 * fallback matches the pre-existing behaviour. Membership sets are passed in
 * so the lookup stays O(1) and the compiler keeps one source of truth.
 */
function inputStreamStep(
	key: string,
	sets: {
		fileKeys: ReadonlySet<string>;
		dolbyKeys: ReadonlySet<string>;
		trimmingKeys: ReadonlySet<string>;
		concatKeys: ReadonlySet<string>;
		mixKeys: ReadonlySet<string>;
	},
): string {
	if (sets.fileKeys.has(key)) {
		return `file:${key}`;
	}
	if (sets.dolbyKeys.has(key)) {
		return `dolby:${key}`;
	}
	if (sets.trimmingKeys.has(key)) {
		return `trim:${key}`;
	}
	if (sets.concatKeys.has(key)) {
		return `concat:${key}`;
	}
	if (sets.mixKeys.has(key)) return `audioMix:${key}`;
	return `ingest:${key}`;
}

/**
 * encoding examples `_remove_output_base_path` equivalent, hardened: the base
 * is slash-terminated before comparison so `output/x` cannot strip a
 * sibling prefix like `output/x2/...` or leave a leading slash.
 */
export function relativeSegmentPath(
	muxingPath: string,
	manifestPath: string,
): string {
	const base =
		manifestPath === "" || manifestPath.endsWith("/")
			? manifestPath
			: `${manifestPath}/`;
	return muxingPath.startsWith(base)
		? muxingPath.slice(base.length)
		: muxingPath;
}

/**
 * Single-file references (SegmentBase filePath, Smooth mediaFile) join a
 * directory and a filename — the plan schema does not force trailing
 * slashes on destination paths, so naive concatenation would produce
 * `video/360pvideo.mp4`.
 */
export function joinFilePath(dir: string, filename: string): string {
	if (dir === "") {
		return filename;
	}
	return dir.endsWith("/") ? `${dir}${filename}` : `${dir}/${filename}`;
}

/** A file URL relative to a manifest directory, including sibling directories. */
export function relativeFilePath(
	fileDirectory: string,
	filename: string,
	manifestDirectory: string,
): string {
	const target = fileDirectory.split("/").filter(Boolean);
	const base = manifestDirectory.split("/").filter(Boolean);
	let shared = 0;
	while (shared < target.length && target[shared] === base[shared]) shared++;
	return [
		...base.slice(shared).map(() => ".."),
		...target.slice(shared),
		filename,
	].join("/");
}

/**
 * The output a rendition's content lands in: the first of its muxings that
 * carries a destination, else the destination of the DRM resource encrypting one
 * (a fully-DRM'd muxing has none of its own — the DRM resource owns the
 * encrypted output).
 *
 * Exported because two callers must agree exactly. The compiler uses it to place
 * the QC mirror; `detail-view.ts` uses it to tell an operator where a rendition
 * was written. When those two derived the same thing separately, the panel
 * invented directories that never existed — it walked muxings where the compiler
 * walks renditions, so a rendition with two muxings produced two qc paths where
 * the compiler writes one (review finding). One implementation, two callers.
 */
export function renditionOutputBase(
	plan: EncodingPlan,
	renditionKey: string,
):
	| { outputKey: string; path: string; acl?: "PUBLIC_READ" | "PRIVATE" }
	| undefined {
	for (const m of plan.muxings) {
		if (m.streamKey !== renditionKey) {
			continue;
		}
		if (m.destination) {
			return {
				outputKey: m.destination.outputKey,
				path: m.destination.path,
				...(m.destination.acl ? { acl: m.destination.acl } : {}),
			};
		}
		const drm = plan.drm.find((d) => d.muxingKey === m.key);
		if (drm) {
			return {
				outputKey: drm.destination.outputKey,
				path: drm.destination.path,
				...(drm.destination.acl ? { acl: drm.destination.acl } : {}),
			};
		}
	}
	return undefined;
}

/**
 * QC mirror output path: a `qc/` child of the supplied base directory.
 * Joins safely whether or not `dir` ends in a slash (destination paths are
 * not forced trailing-slashed by the schema). Empty base ⇒ bare `qc/`.
 */
export function qcOutputPath(dir: string): string {
	if (dir === "") {
		return "qc/";
	}
	return dir.endsWith("/") ? `${dir}qc/` : `${dir}/qc/`;
}

/**
 * The QC mirror's name (filename + container) lives in the leaf `./qc-mirror`
 * so per-title attribution can bind a RESULT muxing back to its template
 * without importing this module. The compiler imports `./per-title-results`,
 * so a back-import would create a cycle. Re-exported here for callers that
 * already use the compiler, keeping one definition without an import cycle.
 */
export { qcMirrorFilename, qcMirrorMuxingKind };

/** Plan unions widen per phase — fail loudly when the compiler lags. */
function unreachable(variant: never): never {
	throw new Error(
		`Compiler: unhandled plan variant ${JSON.stringify(variant)}`,
	);
}

/** True for the codecs that own a video adaptation set / HLS variant. */
function isVideoCodec(
	rendition: PlanRendition,
): rendition is Extract<
	PlanRendition,
	{ codec: "H264" | "H265" | "VP9" | "AV1" }
> {
	return (
		rendition.codec === "H264" ||
		rendition.codec === "H265" ||
		rendition.codec === "VP9" ||
		rendition.codec === "AV1"
	);
}

/** Audio codecs that join audio media/adaptation sets in manifests. */
function isAudioCodec(
	rendition: PlanRendition,
): rendition is Extract<
	PlanRendition,
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

/** Per-title templates expand server-side (PER_TITLE_RESULT streams). */
/**
 * ONE definition of "this rendition is a per-title template", shared with the
 * capture module. It was duplicated: `isVideoCodec(r) && r.mode.startsWith(
 * "PER_TITLE")` here, a prefix check over `PER_TITLE_TEMPLATE` there. The two
 * agree on today's schema (only the four video renditions carry `mode`, and both
 * its per-title values start with `PER_TITLE_TEMPLATE`) — but the capture step's
 * emission gate and `perTitleEncStep`, which resolves the encoding that step
 * binds to, must agree for ALL time: if the gate ever said yes where the
 * resolver said no, the op would silently bind to the fallback encoding.
 */
const isPerTitle = isPerTitleRendition;

/**
 * The name the CREATE_STREAM op carries: the plan's override when it sets one,
 * else the derived default.
 *
 * Extracted while the per-title capture briefly needed the same answer for its
 * payload — it does not any more (real results carry no name, so matching on one
 * was dead; see `attributeResult`). Kept as a named function because "the plan
 * may override this" deserves to be stated once rather than read out of a `??`.
 */
function compiledStreamName(rendition: PlanRendition): string {
	return rendition.streamName ?? streamName(rendition);
}

function streamName(rendition: PlanRendition): string {
	switch (rendition.codec) {
		case "H264":
		case "H265":
		case "VP9":
		case "AV1":
			return rendition.height === null
				? `Stream ${rendition.codec}`
				: `Stream ${rendition.codec} ${rendition.height}p`;
		case "AAC":
		case "OPUS":
			return `Stream ${rendition.codec} ${kbps(rendition.bitrate)}`;
		case "DOLBY_ATMOS":
			return `Stream Atmos ${rendition.bitrate}bps`;
		case "DDPLUS":
			return `Stream DDPLUS ${kbps(rendition.bitrate)}`;
		case "DD":
			return `Stream DD ${kbps(rendition.bitrate)}`;
		case "WEBVTT":
			return "Stream WebVTT";
		case "IMSC":
			return "Stream IMSC";
		default:
			return unreachable(rendition);
	}
}

const MUXING_LABEL = {
	FMP4: "FMP4",
	CMAF: "CMAF",
	MP4: "MP4",
	TS: "TS",
	WEBM: "WebM",
} as const;

/** Sample naming: "<Video|Audio> <FMP4|MP4|TS|WebM> Muxing <identity>". */
function muxingName(
	kind: keyof typeof MUXING_LABEL,
	rendition: PlanRendition,
): string | undefined {
	if (rendition.codec === "WEBVTT" || rendition.codec === "IMSC") {
		return undefined; // chunked-text muxings are unnamed in the samples
	}
	if (isVideoCodec(rendition)) {
		const identity = rendition.height === null ? "" : ` ${rendition.height}p`;
		return `Video ${MUXING_LABEL[kind]} Muxing${identity}`;
	}
	return `Audio ${MUXING_LABEL[kind]} Muxing ${kbps(rendition.bitrate)}`;
}

/**
 * mirror refs ride beside every destination's outputId — the
 * worker appends one EncodingOutput per mirror, same path and acl. Emitted
 * only when the plan declares deliveryMirrors AND the site has a destination
 * (DRM-owned-output muxings keep their no-ref shape).
 */
function mirrorOutputRefs(plan: {
	deliveryMirrors?: { outputKey: string }[] | undefined;
}): { mirrorOutputIds: string[] } | Record<string, never> {
	return plan.deliveryMirrors && plan.deliveryMirrors.length > 0
		? {
				mirrorOutputIds: plan.deliveryMirrors.map(
					(m) => `output:${m.outputKey}`,
				),
			}
		: {};
}

export function compilePlan(plan: EncodingPlan): CompiledOperation[] {
	const ops: CompiledOperation[] = [];
	const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
	/**
	 * WHERE a muxing op may be emitted, keyed by muxing.
	 *
	 * Ops execute in array order and refs resolve out of ids created by
	 * EARLIER steps, so a container that multiplexes two renditions cannot be
	 * created while iterating the first of them — the second rendition's
	 * stream does not exist yet, and `refId` would throw at execution on a
	 * plan that compiled clean. Each muxing is therefore emitted on the LAST
	 * of its constituent renditions in `plan.renditions` order.
	 *
	 * For a single-stream container that last one IS `streamKey`, so this list
	 * reproduces the previous gate exactly and the goldens do not move.
	 *
	 * Indexed by POSITION, not by muxing key. A `Map` keyed by `m.key` was the
	 * first cut and it silently collapsed duplicates — two muxings sharing a key
	 * would both be gated on whichever registered last, dropping one or emitting
	 * it at the wrong rendition. `PLAN_DUPLICATE_KEY` refuses such a plan, but
	 * `compilePlan` runs on schema-parsed input that has NOT been validated: the
	 * wizard's live preview compiles every keystroke, and two containers briefly
	 * sharing a key is an ordinary state to pass through while renaming one.
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
	const filterByKey = new Map(plan.filters.map((f) => [f.key, f]));

	// Multi-encoding partition (Dolby ladders). Absent plan.encodings ⇒ the
	// implicit single encoding with the legacy step ids — every pre-PR5
	// golden stays byte-identical.
	// fallbackCloudRegions below is an internal builder field (account-level, so
	// shared across encodings) — consumed only via the `?.length` guard at the
	// CREATE_ENCODING payload, never serialized directly.
	const planEncodings = plan.encodings?.length
		? plan.encodings.map((e) => ({
				key: e.key as string | undefined,
				name: e.name,
				cloudRegion: e.cloudRegion ?? plan.bitmovin.cloudRegion,
				encoderVersion: e.encoderVersion ?? plan.bitmovin.encoderVersion,
				fallbackCloudRegions: plan.bitmovin.fallbackCloudRegions,
				step: `encoding:${e.key}`,
				startStep: `start:${e.key}`,
				awaitStep: `await:${e.key}`,
			}))
		: [
				{
					key: undefined as string | undefined,
					name: plan.name,
					cloudRegion: plan.bitmovin.cloudRegion,
					encoderVersion: plan.bitmovin.encoderVersion,
					fallbackCloudRegions: plan.bitmovin.fallbackCloudRegions,
					step: ENCODING_STEP,
					startStep: "start",
					awaitStep: "await:encoding",
				},
			];
	const firstEncoding = planEncodings[0] as (typeof planEncodings)[number];
	const encOf = (encodingKey: string | undefined) =>
		planEncodings.find((e) => e.key === encodingKey) ?? firstEncoding;
	const encStepFor = (renditionKey: string): string =>
		encOf(renditionByKey.get(renditionKey)?.encodingKey).step;

	// 1. Inputs & outputs
	for (const input of plan.inputs) {
		if (input.kind === "S3") {
			ops.push({
				step: `input:${input.key}`,
				kind: "CREATE_INPUT_S3",
				payload: {
					name: input.name,
					credentialId: input.credentialId,
					bucketName: input.bucket,
				},
				refs: {},
			});
		} else if (input.kind === "HTTPS") {
			ops.push({
				step: `input:${input.key}`,
				kind: "CREATE_INPUT_HTTPS",
				payload: { name: input.name, host: input.host },
				refs: {},
			});
		} else if (input.kind === "AZURE") {
			ops.push({
				step: `input:${input.key}`,
				kind: "CREATE_INPUT_AZURE",
				payload: {
					name: input.name,
					credentialId: input.credentialId,
					container: input.container,
				},
				refs: {},
			});
		} else if (input.kind === "GENERIC_S3") {
			// S3-compatible (Akamai/OCI/GenericS3). Host/port/ssl/keys resolve from
			// the credential at execution — the payload stays secret-free (C10).
			ops.push({
				step: `input:${input.key}`,
				kind: "CREATE_INPUT_GENERIC_S3",
				payload: {
					name: input.name,
					credentialId: input.credentialId,
					bucketName: input.bucket,
				},
				refs: {},
			});
		} else if (input.kind === "GCS") {
			ops.push({
				step: `input:${input.key}`,
				kind: "CREATE_INPUT_GCS",
				payload: {
					name: input.name,
					credentialId: input.credentialId,
					bucketName: input.bucket,
					...(input.region !== undefined ? { cloudRegion: input.region } : {}),
				},
				refs: {},
			});
		} else if (input.kind === "AKAMAI_NETSTORAGE") {
			// . Host/username/password come from the vault at
			// execution time, exactly as SFTP does — the plan carries only the
			// credential id, and there is no bucket to carry.
			ops.push({
				step: `input:${input.key}`,
				kind: "CREATE_INPUT_AKAMAI_NETSTORAGE",
				payload: { name: input.name, credentialId: input.credentialId },
				refs: {},
			});
		} else if (input.kind === "GCS_SERVICE_ACCOUNT") {
			ops.push({
				step: `input:${input.key}`,
				kind: "CREATE_INPUT_GCS_SERVICE_ACCOUNT",
				payload: {
					name: input.name,
					credentialId: input.credentialId,
					bucketName: input.bucket,
					...(input.region !== undefined ? { cloudRegion: input.region } : {}),
				},
				refs: {},
			});
		} else {
			unreachable(input);
		}
	}
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
			// S3-compatible (Akamai/OCI/GenericS3). Secret-free payload — host and
			// keys resolve from the credential at execution (C10).
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
			// . The VENDOR resource (`AkamaiMslOutput`) has no
			// credential field — Bitmovin authenticates it with the account API
			// key — but our plan's MSL output does, and the payload carries it
			// so the executor can resolve the provisioned stream id and event
			// name from the vault. (This comment said "No credentialId in the
			// payload because MSL has none" while emitting one two lines below,
			// until 2026-08-25.)
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
		} else if (output.kind === "AKAMAI_NETSTORAGE") {
			ops.push({
				step: `output:${output.key}`,
				kind: "CREATE_OUTPUT_AKAMAI_NETSTORAGE",
				payload: { name: output.name, credentialId: output.credentialId },
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
		} else {
			unreachable(output);
		}
	}

	// 2..4: per encoding — create it, then its input streams, then the
	// rendition pipeline that belongs to it (sample order per encoding).
	for (const enc of planEncodings) {
		ops.push({
			step: enc.step,
			kind: "CREATE_ENCODING",
			payload: {
				name: enc.name,
				cloudRegion: enc.cloudRegion,
				encoderVersion: enc.encoderVersion,
				...(plan.internal?.hevcV2
					? { bcfVersion: plan.internal.hevcV2.bcfVersion }
					: {}),
				...(enc.fallbackCloudRegions?.length
					? { fallbackCloudRegions: enc.fallbackCloudRegions }
					: {}),
				// Plan-level: every sibling encoding of a multi-encoding ladder
				// carries the same statistics labels / Cloud Connect pinning.
				...(plan.bitmovin.labels?.length
					? { labels: plan.bitmovin.labels }
					: {}),
				...(plan.bitmovin.infrastructure
					? { infrastructure: plan.bitmovin.infrastructure }
					: {}),
			},
			refs: {},
		});

		// Kantar audio watermarking: an ENCODING-level singleton
		// (encodings/{id}/kantar-watermark), so it is emitted once per
		// encoding right after the encoding exists and long before START.
		// The service login stays in the vault — only credentialId rides
		// the payload, and the report destination resolves like any other.
		//
		// PER-ENCODING AUDIO GATE (review catch): renditions are partitioned
		// by encodingKey, so "the plan has audio" (the validator's plan-wide
		// rail) does NOT mean "THIS encoding has audio". Every Dolby
		// multi-encoding golden carries audio in the DV ladder only — a blind
		// fan-out configured Kantar on the video-only hdr10/sdr siblings, i.e.
		// exactly the state PLAN_KANTAR_NEEDS_AUDIO exists to forbid (licence
		// consumed, nothing watermarked). Emit only where it can act; the
		// plan-wide rail still rejects a plan with no audio at all.
		const encodingHasAudio = plan.renditions.some(
			(r) =>
				AUDIO_CODECS.has(r.codec) && encOf(r.encodingKey).step === enc.step,
		);
		if (plan.kantar && encodingHasAudio) {
			ops.push({
				step: `kantar:${enc.step}`,
				kind: "CREATE_KANTAR_WATERMARK",
				payload: {
					credentialId: plan.kantar.credentialId,
					licenseId: plan.kantar.licenseId,
					channelName: plan.kantar.channelName,
					contentReference: plan.kantar.contentReference,
					serverUrl: plan.kantar.serverUrl,
					reportPath: plan.kantar.reportDestination.path,
					...(plan.kantar.reportDestination.acl
						? { reportAcl: plan.kantar.reportDestination.acl }
						: {}),
				},
				refs: {
					encodingId: enc.step,
					reportOutputId: `output:${plan.kantar.reportDestination.outputKey}`,
				},
			});
		}

		// 3. Ingest input streams, then whole-file sidecar streams (sample order)
		for (const ingest of plan.ingest) {
			if (encOf(ingest.encodingKey).step !== enc.step) {
				continue;
			}
			ops.push({
				step: `ingest:${ingest.key}`,
				kind: "CREATE_INGEST_INPUT_STREAM",
				payload: {
					inputPath: ingest.inputPath,
					selectionMode: ingest.selectionMode,
					position: ingest.position,
				},
				refs: {
					encodingId: enc.step,
					inputId: `input:${ingest.inputKey}`,
				},
			});
		}
		const fileKeys = new Set(plan.fileStreams.map((f) => f.key));
		for (const file of plan.fileStreams) {
			if (encOf(file.encodingKey).step !== enc.step) {
				continue;
			}
			ops.push({
				step: `file:${file.key}`,
				kind: "CREATE_FILE_INPUT_STREAM",
				payload: { inputPath: file.inputPath, fileType: file.fileType },
				refs: {
					encodingId: enc.step,
					inputId: `input:${file.inputKey}`,
				},
			});
		}

		const dolbyKeys = new Set(plan.dolbyStreams.map((d) => d.key));
		for (const dolby of plan.dolbyStreams) {
			if (encOf(dolby.encodingKey).step !== enc.step) {
				continue;
			}
			if (dolby.kind === "ATMOS") {
				ops.push({
					step: `dolby:${dolby.key}`,
					kind: "CREATE_DOLBY_ATMOS_INPUT_STREAM",
					payload: {
						inputPath: dolby.inputPath,
						inputFormat: dolby.inputFormat,
					},
					refs: { encodingId: enc.step, inputId: `input:${dolby.inputKey}` },
				});
			} else if (dolby.kind === "VISION") {
				ops.push({
					step: `dolby:${dolby.key}`,
					kind: "CREATE_DOLBY_VISION_INPUT_STREAM",
					payload: {
						videoInputPath: dolby.videoInputPath,
						...(dolby.metadataInputPath
							? { metadataInputPath: dolby.metadataInputPath }
							: {}),
					},
					refs: { encodingId: enc.step, inputId: `input:${dolby.inputKey}` },
				});
			} else if (dolby.kind === "VISION_METADATA") {
				ops.push({
					step: `dolby:${dolby.key}`,
					kind: "CREATE_DOLBY_VISION_METADATA_INPUT_STREAM",
					payload: { inputPath: dolby.inputPath },
					refs: { encodingId: enc.step, inputId: `input:${dolby.inputKey}` },
				});
			} else {
				unreachable(dolby);
			}
		}

		// Trimming + concatenation input streams (the modern path). They wrap
		// ingest/file/dolby (or each other) by sourceKey, so they MUST be emitted
		// after those streams and before CREATE_STREAM (backward-refs invariant).
		// The shared resolver maps a sourceKey to its step in the same namespace.
		const trimmingKeys = new Set(plan.trimmingStreams.map((t) => t.key));
		const concatKeys = new Set(plan.concatenationStreams.map((c) => c.key));
		const mixKeys = new Set(plan.audioMixStreams.map((s) => s.key));
		const streamSets = {
			fileKeys,
			dolbyKeys,
			trimmingKeys,
			concatKeys,
			mixKeys,
		};
		for (const trim of plan.trimmingStreams) {
			if (encOf(trim.encodingKey).step !== enc.step) {
				continue;
			}
			const sourceStep = inputStreamStep(trim.sourceKey, streamSets);
			if (trim.kind === "TIME_BASED") {
				ops.push({
					step: `trim:${trim.key}`,
					kind: "CREATE_TRIMMING_TIME_BASED",
					payload: {
						...(trim.offset !== undefined ? { offset: trim.offset } : {}),
						...(trim.duration !== undefined ? { duration: trim.duration } : {}),
					},
					refs: { encodingId: enc.step, inputStreamId: sourceStep },
				});
			} else if (trim.kind === "TIMECODE_TRACK") {
				ops.push({
					step: `trim:${trim.key}`,
					kind: "CREATE_TRIMMING_TIMECODE_TRACK",
					payload: {
						...(trim.startTimeCode !== undefined
							? { startTimeCode: trim.startTimeCode }
							: {}),
						...(trim.endTimeCode !== undefined
							? { endTimeCode: trim.endTimeCode }
							: {}),
					},
					refs: { encodingId: enc.step, inputStreamId: sourceStep },
				});
			} else if (trim.kind === "H264_PICTURE_TIMING") {
				ops.push({
					step: `trim:${trim.key}`,
					kind: "CREATE_TRIMMING_H264_PICTURE_TIMING",
					payload: {
						...(trim.startPicTiming !== undefined
							? { startPicTiming: trim.startPicTiming }
							: {}),
						...(trim.endPicTiming !== undefined
							? { endPicTiming: trim.endPicTiming }
							: {}),
					},
					refs: { encodingId: enc.step, inputStreamId: sourceStep },
				});
			} else {
				unreachable(trim);
			}
		}
		for (const concat of plan.concatenationStreams) {
			if (encOf(concat.encodingKey).step !== enc.step) {
				continue;
			}
			// One ref per source so the executor resolves each part's stream id;
			// the payload carries the ordering/padding/aspect (secret-free).
			// `sourceRef` names the refs key the executor zips back to a stream id.
			const sourceRefs: Record<string, string> = {};
			const sources = concat.sources.map((source, i) => {
				sourceRefs[`source${i}`] = inputStreamStep(
					source.sourceKey,
					streamSets,
				);
				return {
					sourceRef: `source${i}`,
					...(source.isMain !== undefined ? { isMain: source.isMain } : {}),
					...(source.position !== undefined
						? { position: source.position }
						: {}),
					...(source.paddingBefore
						? { paddingBefore: source.paddingBefore }
						: {}),
					...(source.paddingAfter ? { paddingAfter: source.paddingAfter } : {}),
					...(source.aspectMode ? { aspectMode: source.aspectMode } : {}),
				};
			});
			ops.push({
				step: `concat:${concat.key}`,
				kind: "CREATE_CONCATENATION_INPUT_STREAM",
				payload: { sources },
				refs: { encodingId: enc.step, ...sourceRefs },
			});
		}

		for (const mix of plan.audioMixStreams) {
			if (encOf(mix.encodingKey).step !== enc.step) continue;
			const refs: Record<string, string> = { encodingId: enc.step };
			const audioMixChannels = mix.audioMixChannels.map(
				({ sourceKey, ...channel }, i) => {
					refs[`source${i}`] = inputStreamStep(sourceKey, streamSets);
					return { ...channel, sourceRef: `source${i}` };
				},
			);
			ops.push({
				step: `audioMix:${mix.key}`,
				kind: "CREATE_AUDIO_MIX_INPUT_STREAM",
				payload: {
					...(mix.channelLayout === undefined
						? {}
						: { channelLayout: mix.channelLayout }),
					audioMixChannels,
				},
				refs,
			});
		}

		// 4. Per rendition: codec config → stream → its muxings → thumbnails
		//    (sample order: the python scripts interleave inside profile loops).
		for (const rendition of plan.renditions) {
			if (encOf(rendition.encodingKey).step !== enc.step) {
				continue;
			}
			// VMAF-only encode (qc.only): emit ONLY video renditions (codec config
			// + stream + qc mirror). Audio produces nothing a qc.only run consumes,
			// so skip it entirely — no codec config, no stream.
			if (plan.qc?.only && !isVideoCodec(rendition)) {
				continue;
			}
			if (rendition.codec === "H264") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_H264",
					payload: {
						...(rendition.encodingMode
							? { encodingMode: rendition.encodingMode }
							: {}),
						name: rendition.name,
						height: rendition.height,
						...(rendition.width !== undefined
							? { width: rendition.width }
							: {}),
						// Per-title H264 samples omit bitrate/preset entirely
						// (unlike H265, which passes None) — null means "absent".
						...(rendition.bitrate !== null
							? { bitrate: rendition.bitrate }
							: {}),
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
						...(rendition.slices !== undefined
							? { slices: rendition.slices }
							: {}),
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
						...(rendition.cabac !== undefined
							? { cabac: rendition.cabac }
							: {}),
						...(rendition.adaptiveSpatialTransform !== undefined
							? {
									adaptiveSpatialTransform: rendition.adaptiveSpatialTransform,
								}
							: {}),
						...(rendition.weightedPredictionPFrames
							? {
									weightedPredictionPFrames:
										rendition.weightedPredictionPFrames,
								}
							: {}),
						...(rendition.colorConfig
							? { colorConfig: rendition.colorConfig }
							: {}),
					},
					refs: {},
				});
			} else if (rendition.codec === "H265") {
				if (plan.internal?.hevcV2) {
					ops.push({
						step: `codec:${rendition.key}`,
						kind: "CREATE_CODEC_H265",
						payload: {
							internalHevcV2: true,
							bcfVersion: plan.internal.hevcV2.bcfVersion,
							...(rendition.name ? { name: rendition.name } : {}),
							height: rendition.height,
							bitrate: rendition.bitrate,
							...(rendition.rate !== undefined ? { rate: rendition.rate } : {}),
							...(rendition.pixelFormat
								? { pixelFormat: rendition.pixelFormat }
								: {}),
							...(rendition.colorConfig
								? { colorConfig: rendition.colorConfig }
								: {}),
							...(rendition.levelHighTier !== undefined
								? { levelHighTier: rendition.levelHighTier }
								: {}),
							...(rendition.dynamicRangeFormat
								? { dynamicRangeFormat: rendition.dynamicRangeFormat }
								: {}),
							encodingMode: "SMART_PASS",
							presetConfiguration: "VOD_HIGH_QUALITY",
							...(rendition.motionCompensatedTemporalFiltering !== undefined
								? {
										motionCompensatedTemporalFiltering:
											rendition.motionCompensatedTemporalFiltering,
									}
								: {}),
							...(rendition.rateControlModeConfig !== undefined
								? { rateControlModeConfig: rendition.rateControlModeConfig }
								: {}),
						},
						refs: {},
					});
				} else
					ops.push({
						step: `codec:${rendition.key}`,
						kind: "CREATE_CODEC_H265",
						// Field order mirrors the python sample constructors.
						payload: {
							...(rendition.encodingMode
								? { encodingMode: rendition.encodingMode }
								: {}),
							...(rendition.name ? { name: rendition.name } : {}),
							...(rendition.profile ? { profile: rendition.profile } : {}),
							height: rendition.height,
							bitrate: rendition.bitrate,
							level: rendition.level,
							...(rendition.pixelFormat
								? { pixelFormat: rendition.pixelFormat }
								: {}),
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
							...(rendition.subMe !== undefined
								? { subMe: rendition.subMe }
								: {}),
							// REST/SDK field really is capital-CTU (H265VideoConfiguration).
							...(rendition.maxCtuSize
								? { maxCTUSize: rendition.maxCtuSize }
								: {}),
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
								? {
										weightPredictionOnPSlice:
											rendition.weightPredictionOnPSlice,
									}
								: {}),
							...(rendition.weightPredictionOnBSlice !== undefined
								? {
										weightPredictionOnBSlice:
											rendition.weightPredictionOnBSlice,
									}
								: {}),
							...(rendition.sceneCutThreshold !== undefined
								? { sceneCutThreshold: rendition.sceneCutThreshold }
								: {}),
							...(rendition.motionSearchRange !== undefined
								? { motionSearchRange: rendition.motionSearchRange }
								: {}),
							...(rendition.adaptiveQuantizationMode
								? {
										adaptiveQuantizationMode:
											rendition.adaptiveQuantizationMode,
									}
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
							...(rendition.qpMin !== undefined
								? { qpMin: rendition.qpMin }
								: {}),
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
										maxPictureAverageLightLevel:
											rendition.maxPictureAverageLightLevel,
									}
								: {}),
							...(rendition.colorConfig
								? { colorConfig: rendition.colorConfig }
								: {}),
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
						},
						refs: {},
					});
			} else if (rendition.codec === "VP9") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_VP9",
					payload: {
						...(rendition.encodingMode
							? { encodingMode: rendition.encodingMode }
							: {}),
						...(rendition.name ? { name: rendition.name } : {}),
						height: rendition.height,
						bitrate: rendition.bitrate,
						...(rendition.rate !== undefined ? { rate: rendition.rate } : {}),
						...(rendition.cpuUsed !== undefined
							? { cpuUsed: rendition.cpuUsed }
							: {}),
						...(rendition.tileColumns !== undefined
							? { tileColumns: rendition.tileColumns }
							: {}),
						...(rendition.qpMin !== undefined
							? { qpMin: rendition.qpMin }
							: {}),
						...(rendition.qpMax !== undefined
							? { qpMax: rendition.qpMax }
							: {}),
						...(rendition.rateUndershootPct !== undefined
							? { rateUndershootPct: rendition.rateUndershootPct }
							: {}),
						...(rendition.rateOvershootPct !== undefined
							? { rateOvershootPct: rendition.rateOvershootPct }
							: {}),
						...(rendition.quality ? { quality: rendition.quality } : {}),
						...(rendition.lossless !== undefined
							? { lossless: rendition.lossless }
							: {}),
						...(rendition.aqMode ? { aqMode: rendition.aqMode } : {}),
						...(rendition.arnrType ? { arnrType: rendition.arnrType } : {}),
						...(rendition.arnrMaxFrames !== undefined
							? { arnrMaxFrames: rendition.arnrMaxFrames }
							: {}),
						...(rendition.arnrStrength !== undefined
							? { arnrStrength: rendition.arnrStrength }
							: {}),
						...(rendition.colorConfig
							? { colorConfig: rendition.colorConfig }
							: {}),
					},
					refs: {},
				});
			} else if (rendition.codec === "AV1") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_AV1",
					payload: {
						...(rendition.encodingMode
							? { encodingMode: rendition.encodingMode }
							: {}),
						...(rendition.name ? { name: rendition.name } : {}),
						height: rendition.height,
						bitrate: rendition.bitrate,
						...(rendition.rate !== undefined ? { rate: rendition.rate } : {}),
						...(rendition.presetConfiguration
							? { presetConfiguration: rendition.presetConfiguration }
							: {}),
						...(rendition.autoLevelSetup
							? { autoLevelSetup: rendition.autoLevelSetup }
							: {}),
						...(rendition.dynamicRangeFormat
							? { dynamicRangeFormat: rendition.dynamicRangeFormat }
							: {}),
						...(rendition.colorConfig
							? { colorConfig: rendition.colorConfig }
							: {}),
					},
					refs: {},
				});
			} else if (rendition.codec === "IMSC") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_IMSC",
					payload: {
						...(rendition.styling ? { styling: rendition.styling } : {}),
					},
					refs: {},
				});
			} else if (rendition.codec === "AAC" || rendition.codec === "OPUS") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind:
						rendition.codec === "OPUS"
							? "CREATE_CODEC_OPUS"
							: "CREATE_CODEC_AAC",
					payload: {
						...(rendition.name ? { name: rendition.name } : {}),
						bitrate: rendition.bitrate,
						rate: rendition.rate,
						channelLayout: rendition.channelLayout,
					},
					refs: {},
				});
			} else if (rendition.codec === "DOLBY_ATMOS") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_DOLBY_ATMOS",
					payload: {
						...(rendition.name ? { name: rendition.name } : {}),
						bitrate: rendition.bitrate,
						rate: rendition.rate,
						loudnessControl: rendition.loudnessControl,
					},
					refs: {},
				});
			} else if (rendition.codec === "DDPLUS") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_DDPLUS",
					payload: {
						...(rendition.name ? { name: rendition.name } : {}),
						bitrate: rendition.bitrate,
						rate: rendition.rate,
						channelLayout: rendition.channelLayout,
					},
					refs: {},
				});
			} else if (rendition.codec === "DD") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_DD",
					payload: {
						...(rendition.name ? { name: rendition.name } : {}),
						bitrate: rendition.bitrate,
						rate: rendition.rate,
						channelLayout: rendition.channelLayout,
					},
					refs: {},
				});
			} else if (rendition.codec === "WEBVTT") {
				ops.push({
					step: `codec:${rendition.key}`,
					kind: "CREATE_CODEC_WEBVTT",
					payload: {},
					refs: {},
				});
			} else {
				unreachable(rendition);
			}

			ops.push({
				step: `stream:${rendition.key}`,
				kind: "CREATE_STREAM",
				payload: {
					name: compiledStreamName(rendition),
					mode: isVideoCodec(rendition) ? rendition.mode : "STANDARD",
					...(rendition.conditions ? { conditions: rendition.conditions } : {}),
					...(isVideoCodec(rendition) && rendition.perTitleSettings
						? {
								// SDK shape: StreamPerTitleSettings wraps the
								// fixed-resolution-and-bitrate block.
								perTitleSettings: {
									fixedResolutionAndBitrateSettings: rendition.perTitleSettings,
								},
							}
						: {}),
				},
				refs: {
					encodingId: enc.step,
					codecConfigId: `codec:${rendition.key}`,
					// A rendition consumes an ingest/file/dolby track OR a
					// trimming/concatenation intermediate stream over one.
					inputStreamId: inputStreamStep(rendition.ingestKey, streamSets),
				},
			});

			// Separated-metadata DolbyVision: attach the HDR metadata config to
			// the stream (streams.hdr.dolby_vision) right after its creation.
			// Only the H265 rendition schema carries the field today (the
			// AVC3_09 profile would require adding it to H264 first).
			if (
				rendition.codec === "H265" &&
				"dolbyVisionMetadata" in rendition &&
				rendition.dolbyVisionMetadata
			) {
				const meta = rendition.dolbyVisionMetadata;
				ops.push({
					step: `stream-hdr:${rendition.key}`,
					kind: "CREATE_STREAM_HDR_DOLBY_VISION",
					payload: {
						profile: meta.profile,
						metadataSource: meta.metadataSource,
					},
					refs: {
						encodingId: enc.step,
						streamId: `stream:${rendition.key}`,
						...(meta.metadataStreamKey
							? { metadataInputStreamId: `dolby:${meta.metadataStreamKey}` }
							: {}),
					},
				});
			}

			if (rendition.burnInSrt) {
				const { inputKey, ...payload } = rendition.burnInSrt;
				ops.push({
					step: `burn-in-srt:${rendition.key}`,
					kind: "CREATE_BURN_IN_SRT",
					payload,
					refs: {
						encodingId: enc.step,
						streamId: `stream:${rendition.key}`,
						inputId: `input:${inputKey}`,
					},
				});
			}

			// NexGuard forensic watermarking attaches to the stream right after
			// its creation (sample order); the license resolves from the vault.
			if (rendition.nexguard) {
				ops.push({
					step: `nexguard:${rendition.key}`,
					kind: "CREATE_NEXGUARD_FILE_MARKER",
					payload: {
						credentialId: rendition.nexguard.credentialId,
						watermarkType: rendition.nexguard.watermarkType,
						preset: rendition.nexguard.preset,
						strength: rendition.nexguard.strength,
						...(rendition.nexguard.payload !== undefined
							? { payload: rendition.nexguard.payload }
							: {}),
					},
					refs: {
						encodingId: enc.step,
						streamId: `stream:${rendition.key}`,
					},
				});
			}

			// Filters: one instance per attachment (the deinterlace sample
			// creates the filter inside the stream loop), then a single
			// attach call carrying the ordered chain. positions[i] MUST pair
			// with filterIds[i] — both derive from the same resolved list so
			// the alignment cannot drift even on a non-validated plan.
			const resolvedAttachments = (rendition.filters ?? []).flatMap(
				(attachment) => {
					const filter = filterByKey.get(attachment.filterKey);
					return filter ? [{ attachment, filter }] : [];
				},
			);
			if (resolvedAttachments.length > 0) {
				for (const { attachment, filter } of resolvedAttachments) {
					ops.push({
						step: `filter:${rendition.key}:${attachment.filterKey}`,
						kind: `CREATE_FILTER_${filter.kind}`,
						payload:
							filter.kind === "WATERMARK"
								? {
										...filterParameters(filter),
										imageInput: plan.inputs.find(
											(i) => i.key === filter.inputKey,
										),
									}
								: filterParameters(filter),
						refs: {},
					});
				}
				ops.push({
					step: `stream-filters:${rendition.key}`,
					kind: "CREATE_STREAM_FILTERS",
					payload: {
						positions: resolvedAttachments.map(
							({ attachment }) => attachment.position,
						),
					},
					refs: {
						encodingId: enc.step,
						streamId: `stream:${rendition.key}`,
						filterIds: resolvedAttachments.map(
							({ attachment }) =>
								`filter:${rendition.key}:${attachment.filterKey}`,
						),
					},
				});
			}

			for (const [muxingAt, muxing] of plan.muxings.entries()) {
				if (muxingEmitsOn[muxingAt] !== rendition.key) {
					continue;
				}
				// The container's OWN rendition, which is `rendition` for every
				// single-stream muxing but is an earlier one when this muxing is
				// emitted on a muxed-in stream. Names must follow the primary.
				const primary = renditionByKey.get(muxing.streamKey) ?? rendition;
				// VMAF-only encode (qc.only): emit NO delivery muxings (and no DRM
				// on them). The qc-mirror block below still reads plan.muxings for
				// each rendition's destination — that is why the muxings stay in the
				// plan — but nothing delivery-side is created.
				if (plan.qc?.only) {
					continue;
				}
				// DRM'd muxings carry no destination — the DRM resource below
				// owns the (encrypted) output.
				const destinationFields = muxing.destination
					? {
							outputPath: muxing.destination.path,
							...(muxing.destination.acl
								? { acl: muxing.destination.acl }
								: {}),
						}
					: {};
				const extraStreamKeys = muxingStreamKeys(muxing).slice(1);
				const muxingRefs = {
					encodingId: enc.step,
					streamId: `stream:${muxing.streamKey}`,
					// Spread only when the container is actually multiplexed, so
					// every plan written before this field existed compiles to the
					// same bytes it always did.
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
								...mirrorOutputRefs(plan),
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
							// EXCLUSIVE with segmentNamingTemplate (the SDK's own
							// rule); the schema accepted the template while this
							// compiler silently dropped it — VOD parity restored
							// by the 2026-08-22 census . The live
							// compiler has carried the same exclusivity since
							// #137; C31 still refuses templates on MSL paths.
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
							name: muxing.name ?? muxingName(muxing.kind, primary),
						},
						refs: muxingRefs,
					});
				} else if (muxing.kind === "MP4") {
					ops.push({
						step: `muxing:${muxing.key}`,
						kind: "CREATE_MUXING_MP4",
						payload: {
							filename: muxing.filename,
							// Progressive MP4 omits both fragment fields entirely.
							// SDK field really is capital-MP4 (Mp4Muxing.d.ts:38).
							...(muxing.manifestType !== undefined
								? { fragmentedMP4MuxingManifestType: muxing.manifestType }
								: {}),
							...(muxing.fragmentDuration !== undefined
								? { fragmentDuration: muxing.fragmentDuration }
								: {}),
							...(muxing.dolbyVisionConfiguration
								? {
										dolbyVisionConfiguration: muxing.dolbyVisionConfiguration,
									}
								: {}),
							...destinationFields,
							name: muxing.name ?? muxingName("MP4", primary),
						},
						refs: muxingRefs,
					});
				} else if (muxing.kind === "TEXT") {
					ops.push({
						step: `muxing:${muxing.key}`,
						kind: "CREATE_MUXING_TEXT",
						payload: {
							filename: muxing.filename,
							...destinationFields,
							...(muxing.name ? { name: muxing.name } : {}),
						},
						refs: muxingRefs,
					});
				} else if (muxing.kind === "CHUNKED_TEXT") {
					ops.push({
						step: `muxing:${muxing.key}`,
						kind: "CREATE_MUXING_CHUNKED_TEXT",
						payload: {
							segmentLength: muxing.segmentLength,
							segmentNaming: muxing.segmentNaming,
							...destinationFields,
							...(muxing.name ? { name: muxing.name } : {}),
						},
						refs: muxingRefs,
					});
				} else if (muxing.kind === "TS") {
					ops.push({
						step: `muxing:${muxing.key}`,
						kind: "CREATE_MUXING_TS",
						payload: {
							segmentLength: muxing.segmentLength,
							// Same exclusivity as FMP4 above .
							...(muxing.segmentNamingTemplate
								? { segmentNamingTemplate: muxing.segmentNamingTemplate }
								: { segmentNaming: muxing.segmentNaming }),
							...destinationFields,
							name: muxing.name ?? muxingName("TS", primary),
						},
						refs: muxingRefs,
					});
				} else if (muxing.kind === "WEBM") {
					ops.push({
						step: `muxing:${muxing.key}`,
						kind: "CREATE_MUXING_WEBM",
						payload: {
							segmentLength: muxing.segmentLength,
							segmentNaming: muxing.segmentNaming,
							initSegmentName: muxing.initSegmentName,
							...destinationFields,
							name: muxing.name ?? muxingName("WEBM", primary),
						},
						refs: muxingRefs,
					});
				} else {
					unreachable(muxing);
				}

				// DRM resources directly follow their muxing (sample order);
				// each carries the encrypted-output destination. The content
				// key resolves from the vault at execution (credentialId).
				for (const drm of plan.drm) {
					if (drm.muxingKey !== muxing.key) {
						continue;
					}
					const drmRefs = {
						encodingId: enc.step,
						muxingId: `muxing:${muxing.key}`,
						outputId: `output:${drm.destination.outputKey}`,
						...mirrorOutputRefs(plan),
					};
					if (drm.kind === "CENC") {
						ops.push({
							step: `drm:${drm.key}`,
							kind: "CREATE_DRM_CENC",
							payload: {
								muxingKind: muxing.kind,
								credentialId: drm.credentialId,
								kid: drm.kid,
								...(drm.encryptionMode
									? { encryptionMode: drm.encryptionMode }
									: {}),
								...(drm.ivSize ? { ivSize: drm.ivSize } : {}),
								...(drm.widevine ? { widevine: drm.widevine } : {}),
								...(drm.playReady ? { playReady: drm.playReady } : {}),
								...(drm.fairPlay ? { fairPlay: drm.fairPlay } : {}),
								outputPath: drm.destination.path,
								...(drm.destination.acl ? { acl: drm.destination.acl } : {}),
								...(drm.name ? { name: drm.name } : {}),
							},
							refs: drmRefs,
						});
					} else if (drm.kind === "SPEKE") {
						ops.push({
							step: `drm:${drm.key}`,
							kind: "CREATE_DRM_SPEKE",
							payload: {
								muxingKind: muxing.kind,
								credentialId: drm.credentialId,
								systemIds: drm.systemIds,
								...(drm.contentId ? { contentId: drm.contentId } : {}),
								...(drm.kid ? { kid: drm.kid } : {}),
								...(drm.iv ? { iv: drm.iv } : {}),
								outputPath: drm.destination.path,
								...(drm.destination.acl ? { acl: drm.destination.acl } : {}),
								...(drm.name ? { name: drm.name } : {}),
							},
							refs: drmRefs,
						});
					} else if (drm.kind === "FAIRPLAY") {
						ops.push({
							step: `drm:${drm.key}`,
							kind: "CREATE_DRM_FAIRPLAY",
							payload: {
								muxingKind: muxing.kind,
								credentialId: drm.credentialId,
								iv: drm.iv,
								uri: drm.uri,
								outputPath: drm.destination.path,
								...(drm.destination.acl ? { acl: drm.destination.acl } : {}),
								...(drm.name ? { name: drm.name } : {}),
							},
							refs: drmRefs,
						});
					} else {
						unreachable(drm);
					}
				}
			}

			for (const thumbnail of plan.thumbnails) {
				if (thumbnail.streamKey !== rendition.key) {
					continue;
				}
				// VMAF-only encode (qc.only) produces no thumbnails (validate also
				// rejects them — this is the defensive compiler-side gate).
				if (plan.qc?.only) {
					continue;
				}
				ops.push({
					step: `thumbnail:${thumbnail.key}`,
					kind: "CREATE_THUMBNAIL",
					payload: {
						height: thumbnail.height,
						pattern: thumbnail.pattern,
						unit: thumbnail.unit,
						positions: thumbnail.positions,
						outputPath: thumbnail.destination.path,
						...(thumbnail.destination.acl
							? { acl: thumbnail.destination.acl }
							: {}),
					},
					refs: {
						encodingId: enc.step,
						streamId: `stream:${thumbnail.streamKey}`,
						outputId: `output:${thumbnail.destination.outputKey}`,
						...mirrorOutputRefs(plan),
					},
				});
			}

			// Trick-play sprites follow thumbnails (both are streams.* children
			// writing to their own output). Optional grid/dimension fields emit
			// only when set, mirroring the codec payloads.
			for (const sprite of plan.sprites) {
				if (sprite.streamKey !== rendition.key) {
					continue;
				}
				// VMAF-only encode (qc.only) produces no sprites (validate also
				// rejects them — this is the defensive compiler-side gate).
				if (plan.qc?.only) {
					continue;
				}
				ops.push({
					step: `sprite:${sprite.key}`,
					kind: "CREATE_SPRITE",
					payload: {
						...(sprite.width !== undefined ? { width: sprite.width } : {}),
						...(sprite.height !== undefined ? { height: sprite.height } : {}),
						distance: sprite.distance,
						unit: sprite.unit,
						...(sprite.hTiles !== undefined ? { hTiles: sprite.hTiles } : {}),
						...(sprite.vTiles !== undefined ? { vTiles: sprite.vTiles } : {}),
						...(sprite.imagesPerFile !== undefined
							? { imagesPerFile: sprite.imagesPerFile }
							: {}),
						...(sprite.spriteName !== undefined
							? { spriteName: sprite.spriteName }
							: {}),
						filename: sprite.filename,
						...(sprite.vttName !== undefined
							? { vttName: sprite.vttName }
							: {}),
						...(sprite.creationMode !== undefined
							? { creationMode: sprite.creationMode }
							: {}),
						outputPath: sprite.destination.path,
						...(sprite.destination.acl ? { acl: sprite.destination.acl } : {}),
						...(sprite.name !== undefined ? { name: sprite.name } : {}),
					},
					refs: {
						encodingId: enc.step,
						streamId: `stream:${sprite.streamKey}`,
						outputId: `output:${sprite.destination.outputKey}`,
						...mirrorOutputRefs(plan),
					},
				});
			}

			// QC mirror (plan.qc.vmaf OR plan.qc.psnr): one progressive single-
			// file MP4 per VIDEO rendition, written to a `qc/` child of that
			// rendition's output dir, NOT referenced by any manifest. These
			// plaintext files exist solely for the VMAF/PSNR runner (worker, PR3)
			// to download and score against the source — Bitmovin has no VMAF API,
			// and PSNR rides the same libvmaf pass so it needs the distorted file
			// too (which is why `psnr` gates the mirror as well). Progressive MP4
			// (CREATE_MUXING_MP4, both fragment fields omitted) for every codec
			// but VP9, which rides a progressive WebM — `qcMirrorMuxingKind` /
			// `qcMirrorFilename` are the one definition . Absent qc
			// ⇒ this block never runs, so every non-QC plan compiles
			// byte-identically (the 56 goldens are safe).
			if ((plan.qc?.vmaf || plan.qc?.psnr) && isVideoCodec(rendition)) {
				// Resolve the rendition's output base: prefer a muxing that
				// carries its own destination; for fully-DRM'd renditions the
				// muxing has none, so fall back to the encrypting DRM's output.
				const base = renditionOutputBase(plan, rendition.key);
				if (base) {
					// VP9 cannot ride a progressive MP4 — the provider refuses the
					// muxing ("Codec type not supported",
					// case 9, before START). Its single-file container is a
					// progressive WebM; every other video codec keeps the MP4 mirror
					// byte-for-byte. `qcMirrorFilename` is the ONE definition of the
					// mirror's name, shared with the runner's target enumeration.
					const kind = qcMirrorMuxingKind(rendition.codec);
					ops.push({
						step: `qc-muxing:${rendition.key}`,
						kind:
							kind === "WEBM"
								? "CREATE_MUXING_PROGRESSIVE_WEBM"
								: "CREATE_MUXING_MP4",
						payload: {
							filename: qcMirrorFilename(rendition.key, rendition.codec),
							outputPath: qcOutputPath(base.path),
							...(base.acl ? { acl: base.acl } : {}),
							name: `QC VMAF Mirror ${streamName(rendition)}`,
						},
						refs: {
							encodingId: enc.step,
							streamId: `stream:${rendition.key}`,
							outputId: `output:${base.outputKey}`,
							...mirrorOutputRefs(plan),
						},
					});
				}
			}
		}
	}

	// 4b. Encoding-level keyframes (ad-break cues) — the samples create
	//     them after all muxings, before start. A VMAF-only encode (qc.only)
	//     emits none (validate also rejects them).
	if (!plan.qc?.only) {
		for (const keyframe of plan.keyframes) {
			ops.push({
				step: `keyframe:${keyframe.key}`,
				kind: "CREATE_KEYFRAME",
				payload: { time: keyframe.time },
				refs: { encodingId: encOf(keyframe.encodingKey).step },
			});
		}
	}

	// 5. Manifest resource trees (JIT: before start; POST: after encoding).
	// A VMAF-only encode (qc.only) produces NO manifests — collapsing the
	// effective list to [] empties manifestOps, the per-kind manifest-step
	// arrays below, and (via their `length > 0` guards) the START refs, so the
	// start op carries no manifest references. validate also rejects manifests
	// on a qc.only plan; this keeps the compiler correct even without it.
	const effectiveManifests = plan.qc?.only ? [] : plan.manifests;
	const manifestOps = effectiveManifests.flatMap((manifest) =>
		manifest.kind === "HLS"
			? compileHlsManifest(plan, manifest, renditionByKey, encStepFor)
			: manifest.kind === "DASH"
				? compileDashManifest(plan, manifest, renditionByKey, encStepFor)
				: compileSmoothManifest(plan, manifest, renditionByKey, encStepFor),
	);
	const jit = plan.generation.timing === "JUST_IN_TIME";
	if (jit) {
		ops.push(...manifestOps);
	}

	// 6. Start + await (C3: JIT pins manifestGenerator V2). Multi-encoding
	// plans (Dolby ladders) start ALL encodings sequentially, then await
	// them — the implicit single encoding keeps start/await adjacent.
	// jitPlacement routes a JIT manifest into the start request's vod* list
	// (absent/VOD — today's behavior), the preview* watch-while-encoding list
	// (PREVIEW), or both. SMOOTH has no preview list in the API.
	const ridesVod = (m: { kind: string; jitPlacement?: string }) =>
		m.jitPlacement === undefined ||
		m.jitPlacement === "VOD" ||
		m.jitPlacement === "VOD_AND_PREVIEW";
	const ridesPreview = (m: { kind: string; jitPlacement?: string }) =>
		m.jitPlacement === "PREVIEW" || m.jitPlacement === "VOD_AND_PREVIEW";
	const hlsManifestPlans = effectiveManifests.filter((m) => m.kind === "HLS");
	const dashManifestPlans = effectiveManifests.filter((m) => m.kind === "DASH");
	const hlsManifestSteps = hlsManifestPlans
		.filter(ridesVod)
		.map((m) => `manifest:${m.key}`);
	const previewHlsManifestSteps = hlsManifestPlans
		.filter(ridesPreview)
		.map((m) => `manifest:${m.key}`);
	const dashManifestSteps = dashManifestPlans
		.filter(ridesVod)
		.map((m) => `manifest:${m.key}`);
	const previewDashManifestSteps = dashManifestPlans
		.filter(ridesPreview)
		.map((m) => `manifest:${m.key}`);
	const smoothManifestSteps = effectiveManifests
		.filter((m) => m.kind === "SMOOTH")
		.map((m) => `manifest:${m.key}`);
	// AISA is a start-request feature; the asset-description output is a
	// destination like any other — outputPath/acl in the payload, the
	// outputId resolved through refs (executor wires it into
	// features.assetDescription.outputs[0]).
	const aiSceneAnalysisPayload = plan.aiSceneAnalysis
		? {
				aiSceneAnalysis: {
					features: {
						assetDescription: {
							filename: plan.aiSceneAnalysis.assetDescription.filename,
							outputPath:
								plan.aiSceneAnalysis.assetDescription.destination.path,
							...(plan.aiSceneAnalysis.assetDescription.destination.acl
								? { acl: plan.aiSceneAnalysis.assetDescription.destination.acl }
								: {}),
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
		: {};
	for (const enc of planEncodings) {
		ops.push({
			step: enc.startStep,
			kind: "START_ENCODING",
			payload: {
				...(jit ? { manifestGenerator: "V2" } : {}),
				...(plan.perTitle ? { perTitle: plan.perTitle } : {}),
				...aiSceneAnalysisPayload,
				...(!plan.internal?.hevcV2 &&
				plan.generation.encodingMode &&
				!plan.renditions.some(
					(r) =>
						(r.encodingKey ?? undefined) === enc.key &&
						(("encodingMode" in r && !!r.encodingMode) ||
							("presetConfiguration" in r && !!r.presetConfiguration)),
				)
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
							handleVariableInputFps: plan.generation.handleVariableInputFps,
						}
					: {}),
				...(plan.bitmovin.schedulingPriority !== undefined ||
				plan.bitmovin.prewarmedEncoderPoolIds?.length
					? {
							scheduling: {
								...(plan.bitmovin.schedulingPriority !== undefined
									? { priority: plan.bitmovin.schedulingPriority }
									: {}),
								...(plan.bitmovin.prewarmedEncoderPoolIds?.length
									? {
											prewarmedEncoderPoolIds:
												plan.bitmovin.prewarmedEncoderPoolIds,
										}
									: {}),
							},
						}
					: {}),
			},
			refs: {
				encodingId: enc.step,
				...(plan.aiSceneAnalysis
					? {
							aiAssetDescriptionOutputId: `output:${plan.aiSceneAnalysis.assetDescription.destination.outputKey}`,
						}
					: {}),
				...(jit && hlsManifestSteps.length > 0
					? { vodHlsManifestIds: hlsManifestSteps }
					: {}),
				...(jit && dashManifestSteps.length > 0
					? { vodDashManifestIds: dashManifestSteps }
					: {}),
				...(jit && smoothManifestSteps.length > 0
					? { vodSmoothManifestIds: smoothManifestSteps }
					: {}),
				...(jit && previewHlsManifestSteps.length > 0
					? { previewHlsManifestIds: previewHlsManifestSteps }
					: {}),
				...(jit && previewDashManifestSteps.length > 0
					? { previewDashManifestIds: previewDashManifestSteps }
					: {}),
			},
		});
	}
	// ORCHESTRATOR CONTRACT (multi-encoding failure semantics): the await
	// steps run sequentially, so when one AWAIT_ENCODING fails the sibling
	// encodings are still RUNNING (and billing). The executor must stop all
	// sibling encodings of the same plan before failing the job — mirroring
	// the ladder scripts' _stop_encodings — and the step log must record the
	// stops. Implementation lands with the P2 worker batch (COVERAGE §15).
	for (const enc of planEncodings) {
		ops.push({
			step: enc.awaitStep,
			kind: "AWAIT_ENCODING",
			payload: {},
			refs: { encodingId: enc.step },
		});
	}

	// 6a. Per-title RESULT capture (design §4a): the PER_TITLE_RESULT streams
	// exist only once the encoding is FINISHED, so this sits immediately after
	// the awaits and before manifest generation. Emitted ONLY for per-title
	// plans — a fixed-ladder plan has no results to capture and compiles
	// byte-identical to before (asserted by the corpus golden test).
	//
	// It rides the step log for free: single writer, redaction, crash-resume
	// (the capture is read-only, so a re-run re-lists idempotently) and
	// Resources-tab visibility. `refs.encodingId` binds it to the per-title
	// encoding — the same binding the per-title manifest expansions use, via the
	// same resolver, so the two can never disagree about which encoding that is.
	if (planHasPerTitle(plan)) {
		ops.push({
			// The CONSTANT, not a second copy of the literal. Renaming the constant
			// used to fail nothing — the goldens pin the literal, the executor
			// dispatches on `kind`, and the only casualty was the step→view join, so
			// every captured job would have silently rendered as "no results" (review
			// finding).
			step: PER_TITLE_CAPTURE_STEP,
			kind: "CAPTURE_PER_TITLE_RESULTS",
			// The templates travel WITH the op: attribution is plan knowledge
			// (which rendition asked for which codec), the executor is plan-free by
			// design, and the persisted payload then documents what the capture was
			// matching against — readable months later in the Resources tab, when
			// the plan itself may have moved on.
			payload: {
				streamModeFilter: PER_TITLE_RESULT_MODE,
				templates: perTitleTemplates(plan),
			},
			refs: { encodingId: perTitleEncStep(plan, encStepFor) },
		});
	}

	// 7. Post-encoding generation: create trees, then start+await each.
	//
	// BLOCK_MANIFESTS : the WHOLE post-encoding manifest group
	// — creates, starts and awaits — is stamped phase:"post-qc" so the
	// orchestrator parks before it until the QC verdict clears. C29 already
	// forces every manifest to POST_ENCODING for BLOCK_MANIFESTS plans (JIT
	// manifests exist before VMAF can run), so the JIT push above can never
	// carry the stamp — the validator, not this file, holds that line.
	// CAPTURE_PER_TITLE_RESULTS stays PRE-gate deliberately: it is a read-only
	// listing the detail view wants while the job waits, and it delivers
	// nothing.
	if (!jit) {
		const deferred: Pick<CompiledOperation, "phase"> =
			plan.qc?.gate?.onFail === "BLOCK_MANIFESTS" ? { phase: "post-qc" } : {};
		ops.push(...manifestOps.map((op) => ({ ...op, ...deferred })));
		for (const manifest of effectiveManifests) {
			const manifestStep = `manifest:${manifest.key}`;
			ops.push({
				step: `manifest-start:${manifest.key}`,
				kind:
					manifest.kind === "HLS"
						? "START_MANIFEST_HLS"
						: manifest.kind === "DASH"
							? "START_MANIFEST_DASH"
							: "START_MANIFEST_SMOOTH",
				// Deliberate divergence from the python scripts (which call
				// start without a body): C3 pins the V2 generator explicitly
				// instead of relying on the org-level default.
				payload: { manifestGenerator: "V2" },
				refs: { manifestId: manifestStep },
				...deferred,
			});
			ops.push({
				step: `manifest-await:${manifest.key}`,
				kind:
					manifest.kind === "HLS"
						? "AWAIT_MANIFEST_HLS"
						: manifest.kind === "DASH"
							? "AWAIT_MANIFEST_DASH"
							: "AWAIT_MANIFEST_SMOOTH",
				payload: {},
				refs: { manifestId: manifestStep },
				...deferred,
			});
		}
	}

	return ops;
}

type RenditionMap = Map<string, PlanRendition>;

/** Per-title expansion ops bind to the (single) per-title encoding. */
function perTitleEncStep(
	plan: EncodingPlan,
	encStepFor: (renditionKey: string) => string,
): string {
	const perTitle = plan.renditions.find(isPerTitle);
	return perTitle ? encStepFor(perTitle.key) : ENCODING_STEP;
}

function compileHlsManifest(
	plan: EncodingPlan,
	manifest: Extract<EncodingPlan["manifests"][number], { kind: "HLS" }>,
	renditions: RenditionMap,
	encStepFor: (renditionKey: string) => string,
): CompiledOperation[] {
	// One derivation for every audio rendition this manifest enumerates —
	// the validator checks the SAME map (hls-media-defaults.ts).
	const hlsMediaDefaults = hlsAudioMediaDefaults(plan, manifest);
	// …and the SAME leg selection, so "one EXT-X-MEDIA entry per audio
	// rendition" is a property of the derivation rather than of this loop.
	const hlsAudioLegs = hlsAudioLegsByRendition(plan, manifest);
	const subtitleGroup = hlsSubtitleGroups(plan)[0];
	const subtitleReference = subtitleGroup ? { subtitles: subtitleGroup } : {};
	// : the child uri of every VIDEO leg comes from the same
	// enumeration the validator and the verifier read, so a shared bitrate's
	// `_1`, `_2`… suffix is emitted here exactly as it is expected there.
	const childUris = new Map(
		hlsChildEntries(plan, manifest)
			.filter((entry) => entry.kind === "video")
			.map((entry) => [
				`${entry.muxingKey}\u0000${entry.group ?? ""}`,
				entry.uri,
			]),
	);
	const variantUri = (muxingKey: string, group?: string) =>
		childUris.get(`${muxingKey}\u0000${group ?? ""}`);
	const iframeUris = hlsIframeUris(plan, manifest);
	const hlsMediaDefaultFor = (key: string): HlsAudioMediaDefaults => {
		const d = hlsMediaDefaults.get(key);
		if (!d) {
			throw new Error(
				`hls manifest "${manifest.key}": no audio media derivation for rendition "${key}"`,
			);
		}
		return d;
	};
	const manifestStep = `manifest:${manifest.key}`;
	const ops: CompiledOperation[] = [
		{
			step: manifestStep,
			kind: "CREATE_MANIFEST_HLS",
			payload: {
				manifestName: manifest.manifestName,
				name: manifest.name,
				...(manifest.masterVersion
					? { hlsMasterPlaylistVersion: manifest.masterVersion }
					: {}),
				...(manifest.mediaVersion
					? { hlsMediaPlaylistVersion: manifest.mediaVersion }
					: {}),
				outputPath: manifest.destination.path,
				...(manifest.destination.acl ? { acl: manifest.destination.acl } : {}),
			},
			refs: {
				outputId: `output:${manifest.destination.outputKey}`,
				...mirrorOutputRefs(plan),
			},
		},
	];

	// Sample order: audio media + video variants first (muxing list order),
	// subtitle entries afterwards (the scripts list chunked-text last).
	// Per-title template renditions have no static entries — the scripts
	// enumerate run-produced muxings, modeled by the expansion op below.
	for (const muxing of plan.muxings) {
		const rendition = renditions.get(muxing.streamKey);
		if (
			!rendition ||
			muxing.kind === "CHUNKED_TEXT" ||
			muxing.kind === "TEXT" ||
			isPerTitle(rendition)
		) {
			continue;
		}
		// DRM'd entries point at the DRM resource's (encrypted) output and
		// carry its id; the muxing itself may have no destination.
		const drm = manifest.drmKind
			? plan.drm.find(
					(d) => d.muxingKey === muxing.key && d.kind === manifest.drmKind,
				)
			: undefined;
		const segmentPath = relativeSegmentPath(
			drm?.destination.path ?? muxing.destination?.path ?? "",
			manifest.destination.path,
		);
		const refs = {
			manifestId: manifestStep,
			encodingId: encStepFor(rendition.key),
			streamId: `stream:${rendition.key}`,
			muxingId: `muxing:${muxing.key}`,
			...(drm ? { drmId: `drm:${drm.key}` } : {}),
		};
		if (isAudioCodec(rendition)) {
			// ONE entry per audio rendition, on the first leg this manifest
			// selects — not one per muxing (2026-08-29 paid re-audit HIGH-5).
			// A rendition packaged twice into one manifest used to emit two
			// EXT-X-MEDIA rows sharing a NAME and a URI, which is the RFC 8216
			// §4.3.4.1.1 violation of  arriving by the other axis:
			// the derivation is keyed by RENDITION, so both rows carried the
			// same values and the second playlist overwrote the first.
			// Choosing WHICH leg is the author's job (`audioMuxingKind`) —
			// `PLAN_HLS_RENDITION_MULTI_LEG` refuses the ambiguity rather than
			// letting this line resolve it silently.
			if (hlsAudioLegs.get(rendition.key)?.[0] !== muxing.key) {
				continue; // another manifest's leg, or a duplicate of this one
			}
			ops.push({
				step: `hls-media:${manifest.key}:${muxing.key}`,
				kind: "CREATE_HLS_AUDIO_MEDIA",
				payload: rendition.hlsMedia
					? {
							name: rendition.hlsMedia.name,
							groupId: rendition.hlsMedia.groupId,
							language: manifest.audioLanguage,
							...(rendition.hlsMedia.isDefault !== undefined
								? { isDefault: rendition.hlsMedia.isDefault }
								: {}),
							...(rendition.hlsMedia.autoselect !== undefined
								? { autoselect: rendition.hlsMedia.autoselect }
								: {}),
							segmentPath,
							uri: rendition.hlsMedia.uri,
						}
					: {
							// Derived, not literal : the vendor's
							// one-audio literal applied to every rendition made two
							// EXT-X-MEDIA entries share a NAME in one group.
							name: hlsMediaDefaultFor(rendition.key).name,
							groupId: manifest.audioGroupId,
							language: manifest.audioLanguage,
							segmentPath,
							uri: hlsMediaDefaultFor(rendition.key).uri,
						},
				refs,
			});
			if (manifest.audioVariantStreams) {
				ops.push({
					step: `hls-variant:${manifest.key}:${muxing.key}`,
					kind: "CREATE_HLS_STREAM_INFO",
					payload: {
						audio: rendition.hlsMedia?.groupId ?? manifest.audioGroupId,
						closedCaptions: manifest.closedCaptions,
						segmentPath,
						// The same derivation as the media entry above — the variant
						// and the media MUST name one playlist.
						uri: hlsMediaDefaultFor(rendition.key).uri,
					},
					refs,
				});
			}
		} else if (isVideoCodec(rendition)) {
			if (
				manifest.videoMuxingKind &&
				muxing.kind !== manifest.videoMuxingKind
			) {
				continue;
			}
			if (manifest.variantsPerAudioGroup) {
				// Dolby ladders: one variant per (video muxing × audio group),
				// group order as the scripts iterate ('aac', 'atmos' — sorted),
				// plus an I-frame playlist attached to the FIRST variant.
				const groups = [
					...new Set(
						plan.renditions.flatMap((r) =>
							r.hlsMedia ? [r.hlsMedia.groupId] : [],
						),
					),
				].sort();
				let firstVariantStep: string | undefined;
				for (const group of groups) {
					const step = `hls-variant:${manifest.key}:${muxing.key}:${group}`;
					firstVariantStep = firstVariantStep ?? step;
					ops.push({
						step,
						kind: "CREATE_HLS_STREAM_INFO",
						payload: {
							audio: group,
							...subtitleReference,
							closedCaptions: manifest.closedCaptions,
							segmentPath,
							uri:
								variantUri(muxing.key, group) ??
								hlsVariantUri(rendition, group),
						},
						refs,
					});
				}
				if (manifest.iframePlaylists && firstVariantStep) {
					const filename = iframeUris.get(muxing.key);
					if (!filename) {
						throw new Error(
							`hls manifest "${manifest.key}": no I-frame URI for muxing "${muxing.key}"`,
						);
					}
					ops.push({
						step: `hls-iframe:${manifest.key}:${muxing.key}`,
						kind: "CREATE_HLS_IFRAME_PLAYLIST",
						payload: {
							filename,
						},
						refs: {
							manifestId: manifestStep,
							streamInfoId: firstVariantStep,
						},
					});
				}
			} else {
				// C33 — a variant whose segments already CARRY the audio has no
				// EXT-X-MEDIA group to point at, because the muxed-in audio
				// rendition owns no muxing and so emits no audio media entry.
				// Writing the group id anyway names a GROUP-ID that appears
				// nowhere else in the playlist: the player resolves it, finds
				// nothing, and the variant plays silent. Omitting is what the
				// classic muxed layout does.
				const muxedIn = hasMuxedInAudio(muxing, renditions);
				ops.push({
					step: `hls-variant:${manifest.key}:${muxing.key}`,
					kind: "CREATE_HLS_STREAM_INFO",
					payload: {
						...(muxedIn ? {} : { audio: manifest.audioGroupId }),
						...subtitleReference,
						closedCaptions: manifest.closedCaptions,
						segmentPath,
						uri: variantUri(muxing.key) ?? hlsVariantUri(rendition),
					},
					refs,
				});
			}
		}
	}

	// Run-time expansion: the orchestrator lists the manifest's video
	// muxing kind after the encode and creates one StreamInfo per result
	// muxing. streamModeFilter is the contract: expand ONLY muxings whose
	// stream mode matches (PER_TITLE_RESULT) — STANDARD muxings are
	// statically compiled above; expanding them too would duplicate audio.
	const perTitleMuxingKinds = [
		...new Set(
			plan.muxings.flatMap((muxing) => {
				const rendition = renditions.get(muxing.streamKey);
				return rendition &&
					isPerTitle(rendition) &&
					["FMP4", "TS", "MP4"].includes(muxing.kind) &&
					(!manifest.videoMuxingKind ||
						muxing.kind === manifest.videoMuxingKind)
					? [muxing.kind]
					: [];
			}),
		),
	];
	for (const [index, perTitleMuxingKind] of perTitleMuxingKinds.entries()) {
		// ONE value, read by the payload AND by the C33 scan below. They were
		// two expressions of the same intent and drifted immediately: the scan
		// asked whether the PLAN contains a muxed per-title container anywhere,
		// while the op expands only containers of this kind. A ladder with a
		// muxed TS leg and a demuxed CMAF leg — the ordinary multi-leg shape
		// `videoMuxingKind` exists to serve — then had its CMAF variants omit
		// `audio` while that same manifest emitted a perfectly good EXT-X-MEDIA
		// group: every CMAF variant plays video-only with the audio sitting
		// unreferenced beside it.
		ops.push({
			// Preserve the existing single-leg step ID for persisted logs.
			step: `hls-pertitle:${manifest.key}${index === 0 ? "" : `:${perTitleMuxingKind}`}`,
			kind: "CREATE_HLS_PER_TITLE_VARIANTS",
			payload: {
				muxingKind: perTitleMuxingKind,
				...subtitleReference,
				streamModeFilter: "PER_TITLE_RESULT",
				// C33 applies to the EXPANDED variants too. The run-time
				// expansion inherits the template muxing's streams, so if the
				// template carries the audio there is no EXT-X-MEDIA group for
				// these variants to name either — and naming one is the silent
				// failure (player resolves the group, finds nothing, plays no
				// sound), which is worse on this path because nobody sees the
				// variants until after the encode. Whether Bitmovin actually
				// copies the muxed-in stream into each expansion is what
				// PLAN_PER_TITLE_MUXED_AUDIO warns is unmeasured; this only
				// makes the manifest consistent with what THIS manifest expands.
				//
				// The decision was never the risk — the predicate was. Omitting
				// when it should name is exactly as silent as naming when it
				// should omit; it just fails on a different manifest. Hence the
				// kind filter above, and hence one hoisted value rather than two
				// expressions that have to agree.
				...(plan.muxings.some((m) => {
					if (m.kind !== perTitleMuxingKind) {
						return false; // a leg THIS manifest never expands
					}
					const template = renditions.get(m.streamKey);
					return (
						template !== undefined &&
						isPerTitle(template) &&
						hasMuxedInAudio(m, renditions)
					);
				})
					? {}
					: { audio: manifest.audioGroupId }),
				closedCaptions: manifest.closedCaptions,
				uriTemplate:
					manifest.perTitleVariantUri === "CODEC_BITRATE"
						? "video_{codecBitrate}.m3u8"
						: "video_{avgBitrate}.m3u8",
				stripBase: manifest.destination.path,
				...(manifest.drmKind ? { drm: { kind: manifest.drmKind } } : {}),
			},
			refs: {
				manifestId: manifestStep,
				encodingId: perTitleEncStep(plan, encStepFor),
			},
		});
	}
	for (const muxing of plan.muxings) {
		const rendition = renditions.get(muxing.streamKey);
		if (
			!rendition ||
			muxing.kind !== "CHUNKED_TEXT" ||
			rendition.codec !== "WEBVTT"
		) {
			continue;
		}
		ops.push({
			step: `hls-subtitles:${manifest.key}:${muxing.key}`,
			kind: "CREATE_HLS_SUBTITLES_MEDIA",
			payload: {
				name: rendition.label,
				groupId: rendition.groupId,
				language: rendition.language,
				segmentPath: relativeSegmentPath(
					muxing.destination?.path ?? "",
					manifest.destination.path,
				),
				uri: rendition.uri,
			},
			refs: {
				manifestId: manifestStep,
				encodingId: encStepFor(rendition.key),
				streamId: `stream:${rendition.key}`,
				muxingId: `muxing:${muxing.key}`,
			},
		});
	}
	return ops;
}

function compileDashManifest(
	plan: EncodingPlan,
	manifest: Extract<EncodingPlan["manifests"][number], { kind: "DASH" }>,
	renditions: RenditionMap,
	encStepFor: (renditionKey: string) => string,
): CompiledOperation[] {
	const manifestStep = `manifest:${manifest.key}`;
	const periodStep = `${manifestStep}:period`;
	const videoSetStep = `${manifestStep}:aset-video`;
	const audioSetStep = `${manifestStep}:aset-audio`;

	// Static representations: fMP4 muxings of STANDARD AV renditions
	// (kind-filtered when the manifest pins a leg). ON_DEMAND profile flips
	// the selection to single-file MP4 muxings (SegmentBase byte ranges).
	// Per-title video reps come from the run-time expansion op; adaptation
	// sets exist only when they will hold something (audio-only sample has
	// no video set).
	const onDemand = manifest.profile === "ON_DEMAND";
	const hasPerTitleVideo = plan.renditions.some(isPerTitle);
	const dashMuxings: {
		muxing: EncodingPlan["muxings"][number];
		rendition: PlanRendition;
	}[] = [];
	for (const muxing of plan.muxings) {
		const rendition = renditions.get(muxing.streamKey);
		if (!rendition || isPerTitle(rendition)) {
			continue;
		}
		if (onDemand) {
			// Only DASH_ON_DEMAND-typed MP4s — a plan may also carry
			// byte-range/Smooth/progressive MP4 legs for other manifests.
			if (
				muxing.kind === "MP4" &&
				muxing.manifestType === "DASH_ON_DEMAND" &&
				(isVideoCodec(rendition) || isAudioCodec(rendition))
			) {
				dashMuxings.push({ muxing, rendition });
			}
			continue;
		}
		// The leg predicates live in dash-legs.ts — the validator's
		// PLAN_DASH_{VIDEO,AUDIO}_UNSELECTED use these same functions, so they
		// cannot disagree about which muxing an MPD lists (review-323 S2).
		if (
			isAudioCodec(rendition) &&
			dashAudioLegSelected(muxing, manifest, false)
		) {
			dashMuxings.push({ muxing, rendition });
		} else if (
			isVideoCodec(rendition) &&
			dashVideoLegSelected(muxing, manifest, false)
		) {
			dashMuxings.push({ muxing, rendition });
		}
	}
	const hasVideo =
		hasPerTitleVideo || dashMuxings.some((m) => isVideoCodec(m.rendition));
	const hasAudio = dashMuxings.some((m) => isAudioCodec(m.rendition));

	const ops: CompiledOperation[] = [
		{
			step: manifestStep,
			kind: "CREATE_MANIFEST_DASH",
			payload: {
				manifestName: manifest.manifestName,
				...(manifest.profile ? { profile: manifest.profile } : {}),
				name: manifest.name,
				outputPath: manifest.destination.path,
				...(manifest.destination.acl ? { acl: manifest.destination.acl } : {}),
			},
			refs: {
				outputId: `output:${manifest.destination.outputKey}`,
				...mirrorOutputRefs(plan),
			},
		},
		{
			step: periodStep,
			kind: "CREATE_DASH_PERIOD",
			payload: {},
			refs: { manifestId: manifestStep },
		},
	];

	for (const muxing of plan.muxings) {
		const rendition = renditions.get(muxing.streamKey);
		if (muxing.kind !== "TEXT" || rendition?.codec !== "IMSC") continue;
		const setStep = `${manifestStep}:subtitle-set:${muxing.key}`;
		ops.push(
			{
				step: setStep,
				kind: "CREATE_DASH_ADAPTATION_SET_SUBTITLE",
				payload: {
					lang: rendition.language,
					labels: [{ value: rendition.label }],
				},
				refs: { manifestId: manifestStep, periodId: periodStep },
			},
			{
				step: `${manifestStep}:rep:${muxing.key}`,
				kind: "CREATE_DASH_REPRESENTATION_IMSC",
				payload: {
					imscUrl: relativeFilePath(
						muxing.destination.path,
						muxing.filename,
						manifest.destination.path,
					),
				},
				refs: {
					manifestId: manifestStep,
					periodId: periodStep,
					adaptationSetId: setStep,
				},
			},
		);
	}
	// Segmented WebVTT belongs to a subtitle adaptation set, independently of
	// AV adaptation-set membership and Per-Title video expansion.
	for (const muxing of plan.muxings) {
		const rendition = renditions.get(muxing.streamKey);
		if (muxing.kind !== "CHUNKED_TEXT" || rendition?.codec !== "WEBVTT")
			continue;
		const setStep = `${manifestStep}:subtitle-set:${muxing.key}`;
		ops.push(
			{
				step: setStep,
				kind: "CREATE_DASH_ADAPTATION_SET_SUBTITLE",
				payload: {
					lang: rendition.language,
					labels: [{ value: rendition.label }],
				},
				refs: { manifestId: manifestStep, periodId: periodStep },
			},
			{
				step: `${manifestStep}:rep:${muxing.key}`,
				kind: "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT",
				payload: {
					type: manifest.representationType,
					segmentPath: relativeSegmentPath(
						muxing.destination?.path ?? "",
						manifest.destination.path,
					),
				},
				refs: {
					manifestId: manifestStep,
					periodId: periodStep,
					adaptationSetId: setStep,
					encodingId: encStepFor(rendition.key),
					muxingId: `muxing:${muxing.key}`,
				},
			},
		);
	}

	// Explicit adaptation sets (Dolby ladders): renditions join via
	// dashSetKey; representations route per rendition below.
	if (manifest.adaptationSets?.length) {
		for (const set of manifest.adaptationSets) {
			ops.push({
				step: `${manifestStep}:aset-${set.key}`,
				kind:
					set.type === "VIDEO"
						? "CREATE_DASH_ADAPTATION_SET_VIDEO"
						: "CREATE_DASH_ADAPTATION_SET_AUDIO",
				payload: {
					...(set.lang ? { lang: set.lang } : {}),
					...(set.label ? { labels: [{ value: set.label }] } : {}),
				},
				refs: { manifestId: manifestStep, periodId: periodStep },
			});
		}
		for (const { muxing, rendition } of dashMuxings) {
			const setKey = rendition.dashSetKey;
			if (!setKey) {
				continue; // validator requires membership in multi-set mode
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
			const setRefs = {
				manifestId: manifestStep,
				periodId: periodStep,
				adaptationSetId: `${manifestStep}:aset-${setKey}`,
				encodingId: encStepFor(rendition.key),
				muxingId: `muxing:${muxing.key}`,
			};
			const repStep = `${manifestStep}:rep:${muxing.key}`;
			ops.push(
				onDemand && muxing.kind === "MP4"
					? {
							step: repStep,
							kind: "CREATE_DASH_REPRESENTATION_MP4",
							payload: {
								type: "SEGMENT_BASE",
								filePath: joinFilePath(base, muxing.filename),
							},
							refs: setRefs,
						}
					: muxing.kind === "WEBM"
						? {
								step: repStep,
								// The vendor's own VP9 sample: DashWebmRepresentation, TEMPLATE
								// type, segment path — no `mode` field on this model.
								kind: "CREATE_DASH_REPRESENTATION_WEBM",
								payload: {
									type: manifest.representationType,
									segmentPath: base,
								},
								refs: setRefs,
							}
						: {
								step: repStep,
								kind:
									muxing.kind === "CMAF"
										? "CREATE_DASH_REPRESENTATION_CMAF"
										: "CREATE_DASH_REPRESENTATION_FMP4",
								payload: {
									type: manifest.representationType,
									mode: "TEMPLATE_REPRESENTATION",
									segmentPath: base,
								},
								refs: setRefs,
							},
			);
			if (drm) {
				ops.push({
					step: `${repStep}:cp`,
					kind: "CREATE_DASH_CONTENT_PROTECTION",
					payload: muxing.kind === "WEBM" ? { representationKind: "WEBM" } : {},
					refs: {
						...setRefs,
						representationId: repStep,
						drmId: `drm:${drm.key}`,
					},
				});
			}
		}
		return ops;
	}

	/*
	 * One VIDEO adaptation set PER CODEC.
	 * The implicit branch put every video representation into one set;
	 * Bitmovin refuses a mixed set — VOD case 15 and Live case F both died on
	 * the first H265 representation added beside H264 (400, code 1001), and
	 * case 17's explicit codec-separated sets succeeded. A single-codec plan
	 * keeps the historical `aset-video` step id, so every existing golden is
	 * byte-identical; only a plan that mixes codecs gains `aset-video-<codec>`
	 * sets.
	 */
	const staticVideoCodecs = [
		...new Set(
			dashMuxings
				.filter((m) => isVideoCodec(m.rendition))
				.map((m) => m.rendition.codec),
		),
	];
	/*
	 * Per-title video codecs count too. The
	 * per-title expansion below creates representations at RUN time, so its
	 * codec never appears in `dashMuxings` — deriving the set population from
	 * the static muxings alone would put per-title H265 results into an
	 * `aset-video` shared with static H264, which is the very mixed set the
	 * provider refuses. Ordered static-first so a single-codec plan's
	 * `videoCodecs[0]` is unchanged.
	 */
	const perTitleVideoCodecs = [
		...new Set(
			plan.renditions
				.filter(isPerTitle)
				.filter(isVideoCodec)
				.map((r) => r.codec),
		),
	];
	const videoCodecs = [
		...new Set([...staticVideoCodecs, ...perTitleVideoCodecs]),
	];
	const mixedCodecs = videoCodecs.length > 1;
	const videoSetStepFor = (codec: string): string =>
		mixedCodecs ? `${videoSetStep}-${codec.toLowerCase()}` : videoSetStep;
	if (hasVideo) {
		for (const codec of mixedCodecs ? videoCodecs : [videoCodecs[0] ?? ""]) {
			ops.push({
				step: videoSetStepFor(codec),
				kind: "CREATE_DASH_ADAPTATION_SET_VIDEO",
				payload: {},
				refs: { manifestId: manifestStep, periodId: periodStep },
			});
		}
	}
	if (hasAudio) {
		ops.push({
			step: audioSetStep,
			kind: "CREATE_DASH_ADAPTATION_SET_AUDIO",
			payload: { lang: manifest.audioLanguage },
			refs: { manifestId: manifestStep, periodId: periodStep },
		});
	}

	for (const { muxing, rendition } of dashMuxings) {
		// DRM'd reps point at the DRM resource's output and gain a
		// ContentProtection child (the scripts add it per representation).
		const drm = manifest.drmKind
			? plan.drm.find(
					(d) => d.muxingKey === muxing.key && d.kind === manifest.drmKind,
				)
			: undefined;
		const repStep = `${manifestStep}:rep:${muxing.key}`;
		const repBase = relativeSegmentPath(
			drm?.destination.path ?? muxing.destination?.path ?? "",
			manifest.destination.path,
		);
		const repRefs = {
			manifestId: manifestStep,
			periodId: periodStep,
			adaptationSetId: isVideoCodec(rendition)
				? videoSetStepFor(rendition.codec)
				: audioSetStep,
			encodingId: encStepFor(rendition.key),
			muxingId: `muxing:${muxing.key}`,
		};
		ops.push(
			onDemand && muxing.kind === "MP4"
				? {
						step: repStep,
						kind: "CREATE_DASH_REPRESENTATION_MP4",
						payload: {
							type: "SEGMENT_BASE",
							filePath: joinFilePath(repBase, muxing.filename),
						},
						refs: repRefs,
					}
				: muxing.kind === "WEBM"
					? {
							step: repStep,
							kind: "CREATE_DASH_REPRESENTATION_WEBM",
							payload: {
								type: manifest.representationType,
								segmentPath: repBase,
							},
							refs: repRefs,
						}
					: {
							step: repStep,
							kind:
								muxing.kind === "CMAF"
									? "CREATE_DASH_REPRESENTATION_CMAF"
									: "CREATE_DASH_REPRESENTATION_FMP4",
							payload: {
								type: manifest.representationType,
								mode: "TEMPLATE_REPRESENTATION",
								segmentPath: repBase,
							},
							refs: repRefs,
						},
		);
		if (drm) {
			ops.push({
				step: `${repStep}:cp`,
				kind: "CREATE_DASH_CONTENT_PROTECTION",
				// Which representation endpoint owns the child — the URL differs
				// between fmp4 and webm. Absent means FMP4 (every existing golden).
				payload: muxing.kind === "WEBM" ? { representationKind: "WEBM" } : {},
				refs: {
					manifestId: manifestStep,
					periodId: periodStep,
					// The SAME set the representation above joined. This said
					// `videoSetStep` until the mixed-codec regression was fixed. It
					// stopped creating that base set for a mixed-codec plan, so a
					// mixed-codec plan WITH DRM emitted a ContentProtection child
					// under an adaptation set that no step creates.
					adaptationSetId: isVideoCodec(rendition)
						? videoSetStepFor(rendition.codec)
						: audioSetStep,
					representationId: repStep,
					encodingId: encStepFor(rendition.key),
					muxingId: `muxing:${muxing.key}`,
					drmId: `drm:${drm.key}`,
				},
			});
		}
	}

	// Run-time expansion (per-title): list the pinned video muxing kind
	// after the encode and create one representation per result muxing in
	// the video adaptation set. streamModeFilter is the contract: expand
	// ONLY PER_TITLE_RESULT-mode muxings — STANDARD ones are statically
	// compiled above (expanding them too would duplicate entries). WebM
	// representations carry no mode (DashWebmRepresentation has none).
	if (hasPerTitleVideo) {
		const muxingKind = manifest.videoMuxingKind ?? "FMP4";
		ops.push({
			step: `${manifestStep}:pertitle-reps`,
			kind: "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
			payload: {
				muxingKind,
				streamModeFilter: "PER_TITLE_RESULT",
				type: manifest.representationType,
				...(["FMP4", "CMAF"].includes(muxingKind)
					? { mode: "TEMPLATE_REPRESENTATION" }
					: {}),
				stripBase: manifest.destination.path,
				...(manifest.drmKind ? { drm: { kind: manifest.drmKind } } : {}),
			},
			refs: {
				manifestId: manifestStep,
				periodId: periodStep,
				// The per-title codec's own set, not the base one — same defect
				// as the ContentProtection ref above.
				// ONE op carries ONE adaptation set and creates every
				// PER_TITLE_RESULT representation inside it, so this is
				// expressible only while the plan's per-title video is a single
				// codec; `PLAN_DASH_PER_TITLE_MIXED_CODECS` refuses the rest
				// rather than letting this line pick one arbitrarily. The `?? ""`
				// is unreachable — `hasPerTitleVideo` gates this block and every
				// per-title rendition is a video rendition — and in the
				// single-codec case `videoSetStepFor` ignores its argument.
				adaptationSetId: videoSetStepFor(perTitleVideoCodecs[0] ?? ""),
				encodingId: perTitleEncStep(plan, encStepFor),
			},
		});
	}
	return ops;
}

/**
 * SmoothStreaming (.ism/.ismc): MP4 SMOOTH muxings become mp4
 * representations (media_file = strip(base) + filename); CENC PlayReady
 * wires through manifest-level ContentProtection entries per muxing.
 */
function compileSmoothManifest(
	plan: EncodingPlan,
	manifest: Extract<EncodingPlan["manifests"][number], { kind: "SMOOTH" }>,
	renditions: RenditionMap,
	encStepFor: (renditionKey: string) => string,
): CompiledOperation[] {
	const manifestStep = `manifest:${manifest.key}`;
	const ops: CompiledOperation[] = [
		{
			step: manifestStep,
			kind: "CREATE_MANIFEST_SMOOTH",
			payload: {
				serverManifestName: manifest.serverManifestName,
				clientManifestName: manifest.clientManifestName,
				name: manifest.name,
				outputPath: manifest.destination.path,
				...(manifest.destination.acl ? { acl: manifest.destination.acl } : {}),
			},
			refs: {
				outputId: `output:${manifest.destination.outputKey}`,
				...mirrorOutputRefs(plan),
			},
		},
	];

	for (const muxing of plan.muxings) {
		const rendition = renditions.get(muxing.streamKey);
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
		ops.push({
			step: `${manifestStep}:rep:${muxing.key}`,
			kind: "CREATE_SMOOTH_REPRESENTATION_MP4",
			payload: {
				mediaFile: joinFilePath(base, muxing.filename),
				language: manifest.language,
				trackName: isVideoCodec(rendition) ? "video" : "audio",
			},
			refs: {
				manifestId: manifestStep,
				encodingId: encStepFor(rendition.key),
				muxingId: `muxing:${muxing.key}`,
			},
		});
		if (drm) {
			ops.push({
				step: `${manifestStep}:cp:${muxing.key}`,
				kind: "CREATE_SMOOTH_CONTENT_PROTECTION",
				payload: {},
				refs: {
					manifestId: manifestStep,
					encodingId: encStepFor(rendition.key),
					muxingId: `muxing:${muxing.key}`,
					drmId: `drm:${drm.key}`,
				},
			});
		}
	}

	// Run-time expansion: per-title MP4 result muxings become mp4
	// representations (+ ContentProtection when drm is pinned).
	if (plan.renditions.some(isPerTitle)) {
		ops.push({
			step: `${manifestStep}:pertitle`,
			kind: "CREATE_SMOOTH_PER_TITLE_ENTRIES",
			payload: {
				muxingKind: "MP4",
				streamModeFilter: "PER_TITLE_RESULT",
				stripBase: manifest.destination.path,
				language: manifest.language,
				trackName: "video",
				...(manifest.drmKind ? { drm: { kind: manifest.drmKind } } : {}),
			},
			refs: {
				manifestId: manifestStep,
				encodingId: perTitleEncStep(plan, encStepFor),
			},
		});
	}
	return ops;
}
