import type { CompiledOperation } from "@bitovp/core";
import { executeConfigStep } from "./ops/exec-configs";
import { executeDrmStep } from "./ops/exec-drm";
import { executeEncodingStep } from "./ops/exec-encoding";
import { executeIoStep } from "./ops/exec-io";
import { executeLiveStep } from "./ops/exec-live";
import { executeManifestStep } from "./ops/exec-manifests";
import { executeMediaStep } from "./ops/exec-media";
import { type ExecStepContext, STARTED_STATUSES } from "./ops/exec-shared";
import type { SdkOps, TaskStatusResult } from "./sdk-ops";

export { CancelRequested } from "./ops/exec-shared";

/**
 * Executes one compiled operation against the SdkOps boundary. Pure with
 * respect to persistence — the processor owns the step log. Credential
 * material is resolved here, used for the SDK call, and never returned:
 * the snapshot exposed to callers is `op.payload` (secret-free by compiler
 * contract) plus resolved ref ids.
 */

export type ResolvedCredential = {
	provider: string;
	config: Record<string, unknown>;
	secret: Record<string, string>;
};

export type ExecutorContext = {
	sdk: SdkOps;
	/** step id → created Bitmovin resource id */
	ids: Map<string, string>;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	poll: {
		intervalMs: number;
		timeoutMs: number;
		sleep(ms: number): Promise<void>;
	};
	/**
	 * Cooperative-cancel probe . A long AWAIT_ENCODING can poll for
	 * minutes; checked once per poll interval so a cancel mid-await interrupts
	 * promptly. Re-reads `cancelRequested` from the DB (the processor injects it)
	 * — true ⇒ awaitTask throws CancelRequested, a typed signal the processor
	 * routes to the CANCELED finalize path (NOT the ERROR handler). Absent on
	 * paths that never cancel (e.g. live provisioning), where polls run as before.
	 */
	shouldCancel?: () => Promise<boolean>;
};

export type StepResult = {
	resourceId?: string;
	request: unknown;
	response: unknown;
};

export type ExecuteOptions = {
	/**
	 * True when this step was persisted RUNNING by a previous attempt —
	 * i.e. we may have crashed between the SDK call and the DONE write.
	 * START_* ops then check the resource status first: re-starting an
	 * already-started encoding 400s forever and would wedge the job.
	 * Create ops are re-executed (accepted P1 risk: benign orphans).
	 */
	wasRunning?: boolean;
};

export async function executeStep(
	op: CompiledOperation,
	ctx: ExecutorContext,
	options: ExecuteOptions = {},
): Promise<StepResult> {
	// Snapshot for the step log: payload is secret-free by compiler
	// contract; refs are stored resolved to Bitmovin ids where available.
	const resolvedRefs = Object.fromEntries(
		Object.entries(op.refs).map(([key, target]) => [
			key,
			Array.isArray(target)
				? target.map((step) => ctx.ids.get(step) ?? step)
				: (ctx.ids.get(target) ?? target),
		]),
	);
	const request = { ...op.payload, refs: resolvedRefs };

	async function startedDuringCrashWindow(
		getStatus: () => Promise<TaskStatusResult>,
	): Promise<TaskStatusResult | null> {
		if (!options.wasRunning) {
			return null;
		}
		const task = await getStatus();
		return STARTED_STATUSES.has(task.status) ? task : null;
	}

	const ec: ExecStepContext = { ctx, request, startedDuringCrashWindow };

	switch (op.kind) {
		case "CREATE_INPUT_S3":
		case "CREATE_INPUT_AZURE":
		case "CREATE_INPUT_HTTPS":
		case "CREATE_INPUT_GENERIC_S3":
		case "CREATE_INPUT_GCS":
		case "CREATE_INPUT_GCS_SERVICE_ACCOUNT":
		case "CREATE_OUTPUT_S3":
		case "CREATE_OUTPUT_AZURE":
		case "CREATE_OUTPUT_SFTP":
		case "CREATE_OUTPUT_GENERIC_S3":
		case "CREATE_OUTPUT_GCS":
		case "CREATE_OUTPUT_GCS_SERVICE_ACCOUNT":
		case "CREATE_OUTPUT_LIVE_MEDIA_INGEST":
		case "CREATE_OUTPUT_AKAMAI_MSL":
		case "CREATE_INPUT_AKAMAI_NETSTORAGE":
		case "CREATE_OUTPUT_AKAMAI_NETSTORAGE":
		case "CREATE_INPUT_RTMP":
		case "CREATE_INPUT_REDUNDANT_RTMP":
		case "CREATE_INPUT_SRT":
		case "CREATE_INPUT_ZIXI":
			return executeIoStep(op, ec);
		case "CREATE_CODEC_H264":
		case "CREATE_CODEC_H265":
		case "CREATE_CODEC_VP9":
		case "CREATE_CODEC_AV1":
		case "CREATE_CODEC_OPUS":
		case "CREATE_CODEC_IMSC":
		case "CREATE_CODEC_AAC":
		case "CREATE_CODEC_DOLBY_ATMOS":
		case "CREATE_CODEC_DDPLUS":
		case "CREATE_CODEC_DD":
		case "CREATE_CODEC_WEBVTT":
			return executeConfigStep(op, ec);
		case "CREATE_INGEST_INPUT_STREAM":
		case "CREATE_FILE_INPUT_STREAM":
		case "CREATE_DOLBY_ATMOS_INPUT_STREAM":
		case "CREATE_DOLBY_VISION_INPUT_STREAM":
		case "CREATE_DOLBY_VISION_METADATA_INPUT_STREAM":
		case "CREATE_TRIMMING_TIME_BASED":
		case "CREATE_TRIMMING_TIMECODE_TRACK":
		case "CREATE_TRIMMING_H264_PICTURE_TIMING":
		case "CREATE_CONCATENATION_INPUT_STREAM":
		case "CREATE_AUDIO_MIX_INPUT_STREAM":
		case "CREATE_STREAM":
		case "CREATE_STREAM_HDR_DOLBY_VISION":
		case "CREATE_FILTER_DEINTERLACE":
		case "CREATE_BURN_IN_SRT":
		case "CREATE_FILTER_EBU_R128_SINGLE_PASS":
		case "CREATE_FILTER_AUDIO_VOLUME":
		case "CREATE_FILTER_TEXT":
		case "CREATE_FILTER_WATERMARK":
		case "CREATE_FILTER_ROTATE":
		case "CREATE_FILTER_DENOISE_HQDN3D":
		case "CREATE_FILTER_UNSHARP":
		case "CREATE_FILTER_CROP":
		case "CREATE_STREAM_FILTERS":
		case "CREATE_KEYFRAME":
		case "CREATE_THUMBNAIL":
		case "CREATE_SPRITE":
		case "CREATE_MUXING_CMAF":
		case "CREATE_MUXING_FMP4":
		case "CREATE_MUXING_MP4":
		case "CREATE_MUXING_PROGRESSIVE_WEBM":
		case "CREATE_MUXING_TS":
		case "CREATE_MUXING_WEBM":
		case "CREATE_MUXING_TEXT":
		case "CREATE_MUXING_CHUNKED_TEXT":
			return executeMediaStep(op, ec);
		case "CREATE_DRM_CENC":
		case "CREATE_DRM_FAIRPLAY":
		case "CREATE_DRM_SPEKE":
			return executeDrmStep(op, ec);
		case "CREATE_MANIFEST_HLS":
		case "CREATE_HLS_AUDIO_MEDIA":
		case "CREATE_HLS_STREAM_INFO":
		case "CREATE_HLS_SUBTITLES_MEDIA":
		case "CREATE_HLS_IFRAME_PLAYLIST":
		case "CREATE_HLS_PER_TITLE_VARIANTS":
		case "CREATE_MANIFEST_DASH":
		case "CREATE_DASH_PERIOD":
		case "CREATE_DASH_ADAPTATION_SET_SUBTITLE":
		case "CREATE_DASH_REPRESENTATION_IMSC":
		case "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT":
		case "CREATE_DASH_ADAPTATION_SET_VIDEO":
		case "CREATE_DASH_ADAPTATION_SET_AUDIO":
		case "CREATE_DASH_REPRESENTATION_CMAF":
		case "CREATE_DASH_REPRESENTATION_FMP4":
		case "CREATE_DASH_REPRESENTATION_WEBM":
		case "CREATE_DASH_REPRESENTATION_MP4":
		case "CREATE_DASH_CONTENT_PROTECTION":
		case "CREATE_DASH_PER_TITLE_REPRESENTATIONS":
		case "CREATE_MANIFEST_SMOOTH":
		case "CREATE_SMOOTH_REPRESENTATION_MP4":
		case "CREATE_SMOOTH_CONTENT_PROTECTION":
		case "CREATE_SMOOTH_PER_TITLE_ENTRIES":
		case "START_MANIFEST_HLS":
		case "AWAIT_MANIFEST_HLS":
		case "START_MANIFEST_DASH":
		case "AWAIT_MANIFEST_DASH":
		case "START_MANIFEST_SMOOTH":
		case "AWAIT_MANIFEST_SMOOTH":
			return executeManifestStep(op, ec);
		case "CREATE_ENCODING":
		case "CREATE_KANTAR_WATERMARK":
		case "CREATE_NEXGUARD_FILE_MARKER":
		case "START_ENCODING":
		case "AWAIT_ENCODING":
		case "CAPTURE_PER_TITLE_RESULTS":
			return executeEncodingStep(op, ec);
		case "CREATE_INPUT_HLS_LIVE":
		case "START_LIVE_ENCODING":
		case "AWAIT_LIVE_RUNNING":
		case "ESAM_MEDIA_POINT":
		case "SLATE_INSERTED":
		case "SLATE_CONFIRMED":
		case "SLATE_FAILED":
		case "SLATE_UNCONFIRMED":
		case "SCTE35_CUE":
			return executeLiveStep(op, ec);
		default: {
			// No cast: a new core op kind must fail HERE at compile time.
			const exhaustive: never = op.kind;
			throw new Error(`Unknown operation kind ${String(exhaustive)}`);
		}
	}
}
