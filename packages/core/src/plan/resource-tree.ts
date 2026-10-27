import type { OperationKind } from "./compiler";
import type { StepLogEntry } from "./steplog";

/**
 * Parses a persisted step log into a bm-xray-style, cross-linked resource
 * tree grouped by resource type, for the VOD job detail "Resources" tab.
 * Pure data (UI-free): the React tab renders this shape.
 *
 * Cross-linking: the executor stores each step's `refs` RESOLVED to Bitmovin
 * resource ids (executor.ts: `ctx.ids.get(target) ?? target`). We index every
 * step by the resource id it created (`resourceId`), then for each step's
 * resolved refs we look up which step produced that id — yielding
 * step-id↔step-id links the UI can turn into in-page anchors. (Live/SCTE35
 * kinds are tolerated for shared-contract robustness, though this tab is
 * VOD-facing.)
 */

export type ResourceGroupId =
	| "inputs"
	| "outputs"
	| "encoding"
	| "codecs"
	| "inputStreams"
	| "streams"
	| "filters"
	| "muxings"
	| "drm"
	| "manifests"
	| "other";

const GROUP_OF_KIND: Record<OperationKind, ResourceGroupId> = {
	CREATE_INPUT_S3: "inputs",
	CREATE_INPUT_AZURE: "inputs",
	CREATE_INPUT_HTTPS: "inputs",
	CREATE_INPUT_GENERIC_S3: "inputs",
	CREATE_INPUT_GCS: "inputs",
	CREATE_INPUT_GCS_SERVICE_ACCOUNT: "inputs",
	CREATE_INPUT_RTMP: "inputs",
	CREATE_INPUT_REDUNDANT_RTMP: "inputs",
	CREATE_INPUT_SRT: "inputs",
	CREATE_INPUT_ZIXI: "inputs",
	CREATE_INPUT_HLS_LIVE: "inputs",
	CREATE_OUTPUT_S3: "outputs",
	CREATE_OUTPUT_AZURE: "outputs",
	CREATE_OUTPUT_SFTP: "outputs",
	CREATE_OUTPUT_GENERIC_S3: "outputs",
	CREATE_OUTPUT_GCS: "outputs",
	CREATE_OUTPUT_GCS_SERVICE_ACCOUNT: "outputs",
	CREATE_OUTPUT_LIVE_MEDIA_INGEST: "outputs",
	CREATE_OUTPUT_AKAMAI_MSL: "outputs",
	CREATE_OUTPUT_AKAMAI_NETSTORAGE: "outputs",
	CREATE_INPUT_AKAMAI_NETSTORAGE: "inputs",
	CREATE_ENCODING: "encoding",
	START_ENCODING: "encoding",
	AWAIT_ENCODING: "encoding",
	// Reads the encoding's streams — it belongs with the streams it captures,
	// not with the encoding lifecycle, because that is where an operator looks
	// for "what did the per-title algorithm produce".
	CAPTURE_PER_TITLE_RESULTS: "streams",
	START_LIVE_ENCODING: "encoding",
	AWAIT_LIVE_RUNNING: "encoding",
	CREATE_CODEC_H264: "codecs",
	CREATE_CODEC_H265: "codecs",
	CREATE_CODEC_VP9: "codecs",
	CREATE_CODEC_AV1: "codecs",
	CREATE_CODEC_AAC: "codecs",
	CREATE_CODEC_IMSC: "codecs",
	CREATE_CODEC_OPUS: "codecs",
	CREATE_CODEC_DOLBY_ATMOS: "codecs",
	CREATE_CODEC_AC3: "codecs",
	CREATE_CODEC_EAC3: "codecs",
	CREATE_CODEC_DDPLUS: "codecs",
	CREATE_CODEC_DD: "codecs",
	CREATE_CODEC_WEBVTT: "codecs",
	CREATE_INGEST_INPUT_STREAM: "inputStreams",
	CREATE_FILE_INPUT_STREAM: "inputStreams",
	CREATE_DOLBY_ATMOS_INPUT_STREAM: "inputStreams",
	CREATE_DOLBY_VISION_INPUT_STREAM: "inputStreams",
	CREATE_DOLBY_VISION_METADATA_INPUT_STREAM: "inputStreams",
	CREATE_TRIMMING_TIME_BASED: "inputStreams",
	CREATE_TRIMMING_TIMECODE_TRACK: "inputStreams",
	CREATE_TRIMMING_H264_PICTURE_TIMING: "inputStreams",
	CREATE_CONCATENATION_INPUT_STREAM: "inputStreams",
	CREATE_AUDIO_MIX_INPUT_STREAM: "inputStreams",
	CREATE_STREAM: "streams",
	CREATE_STREAM_HDR_DOLBY_VISION: "streams",
	CREATE_BURN_IN_SRT: "streams",
	CREATE_DASH_ADAPTATION_SET_SUBTITLE: "manifests",
	CREATE_DASH_REPRESENTATION_CHUNKED_TEXT: "manifests",
	CREATE_DASH_REPRESENTATION_IMSC: "manifests",
	CREATE_FILTER_DEINTERLACE: "filters",
	CREATE_FILTER_EBU_R128_SINGLE_PASS: "filters",
	CREATE_FILTER_AUDIO_VOLUME: "filters",
	CREATE_FILTER_TEXT: "filters",
	CREATE_FILTER_WATERMARK: "filters",
	CREATE_FILTER_ROTATE: "filters",
	CREATE_FILTER_CROP: "filters",
	CREATE_FILTER_SCALE: "filters",
	CREATE_FILTER_UNSHARP: "filters",
	CREATE_FILTER_DENOISE_HQDN3D: "filters",
	CREATE_STREAM_FILTERS: "filters",
	CREATE_KEYFRAME: "other",
	// Encoding-level singleton (not a stream attachment like NexGuard).
	CREATE_KANTAR_WATERMARK: "encoding",
	CREATE_NEXGUARD_FILE_MARKER: "streams",
	CREATE_THUMBNAIL: "streams",
	CREATE_SPRITE: "streams",
	CREATE_MUXING_FMP4: "muxings",
	CREATE_MUXING_CMAF: "muxings",
	CREATE_MUXING_MP4: "muxings",
	CREATE_MUXING_PROGRESSIVE_WEBM: "muxings",
	CREATE_MUXING_TS: "muxings",
	CREATE_MUXING_WEBM: "muxings",
	CREATE_MUXING_CHUNKED_TEXT: "muxings",
	CREATE_MUXING_TEXT: "muxings",
	CREATE_DRM_CENC: "drm",
	CREATE_DRM_FAIRPLAY: "drm",
	CREATE_DRM_SPEKE: "drm",
	CREATE_DASH_PERIOD_XML: "manifests",
	CREATE_DASH_ADAPTATION_SET_IMAGE: "manifests",
	CREATE_DASH_REPRESENTATION_PROGRESSIVE_WEBM: "manifests",
	CREATE_DASH_REPRESENTATION_VTT: "manifests",
	CREATE_DASH_REPRESENTATION_SPRITE: "manifests",
	CREATE_HLS_VIDEO_MEDIA: "manifests",
	CREATE_HLS_CLOSED_CAPTIONS_MEDIA: "manifests",
	CREATE_HLS_VTT_MEDIA: "manifests",
	CREATE_HLS_CUSTOM_TAG: "manifests",
	CREATE_MANIFEST_HLS: "manifests",
	CREATE_HLS_AUDIO_MEDIA: "manifests",
	CREATE_HLS_STREAM_INFO: "manifests",
	CREATE_HLS_SUBTITLES_MEDIA: "manifests",
	CREATE_HLS_IFRAME_PLAYLIST: "manifests",
	CREATE_HLS_PER_TITLE_VARIANTS: "manifests",
	CREATE_MANIFEST_DASH: "manifests",
	CREATE_DASH_PERIOD: "manifests",
	CREATE_DASH_ADAPTATION_SET_VIDEO: "manifests",
	CREATE_DASH_ADAPTATION_SET_AUDIO: "manifests",
	CREATE_DASH_REPRESENTATION_FMP4: "manifests",
	CREATE_DASH_REPRESENTATION_CMAF: "manifests",
	CREATE_DASH_REPRESENTATION_WEBM: "manifests",
	CREATE_DASH_REPRESENTATION_MP4: "manifests",
	CREATE_DASH_PER_TITLE_REPRESENTATIONS: "manifests",
	CREATE_DASH_CONTENT_PROTECTION: "manifests",
	CREATE_MANIFEST_SMOOTH: "manifests",
	CREATE_SMOOTH_REPRESENTATION_MP4: "manifests",
	CREATE_SMOOTH_CONTENT_PROTECTION: "manifests",
	CREATE_SMOOTH_PER_TITLE_ENTRIES: "manifests",
	START_MANIFEST_HLS: "manifests",
	AWAIT_MANIFEST_HLS: "manifests",
	START_MANIFEST_DASH: "manifests",
	AWAIT_MANIFEST_DASH: "manifests",
	START_MANIFEST_SMOOTH: "manifests",
	AWAIT_MANIFEST_SMOOTH: "manifests",
	SCTE35_CUE: "other",
	LIVE_AUTO_SHUTDOWN_UPDATE: "other",
	SLATE_INSERTED: "other",
	SLATE_CONFIRMED: "other",
	SLATE_FAILED: "other",
	SLATE_UNCONFIRMED: "other",
	ESAM_MEDIA_POINT: "other",
};

export const RESOURCE_GROUP_ORDER: ResourceGroupId[] = [
	"inputs",
	"outputs",
	"encoding",
	"codecs",
	"inputStreams",
	"streams",
	"filters",
	"muxings",
	"drm",
	"manifests",
	"other",
];

export const RESOURCE_GROUP_LABEL: Record<ResourceGroupId, string> = {
	inputs: "Inputs",
	outputs: "Outputs",
	encoding: "Encoding",
	codecs: "Codec configs",
	inputStreams: "Input streams",
	streams: "Streams",
	filters: "Filters",
	muxings: "Muxings",
	drm: "DRM",
	manifests: "Manifests",
	other: "Other",
};

/** A cross-link from a step to the resource one of its refs points at. */
export type ResourceLink = {
	/** The ref key on the source step (e.g. "codecConfigId", "streamId"). */
	key: string;
	/** The resolved Bitmovin id the ref pointed at. */
	resourceId: string;
	/** The step that created `resourceId` (resolved), if known in this log. */
	step?: string;
	/** That step's kind, for a human label, if resolved. */
	kind?: OperationKind;
};

export type ResourceNode = {
	step: string;
	kind: OperationKind;
	status: StepLogEntry["status"];
	/** Bitmovin id created by this step, if any (create ops). */
	resourceId?: string;
	/** Key fields summarized from the (redacted) response. */
	responseSummary?: Record<string, unknown>;
	/** A step that ran but persisted no response (crashed mid-step). */
	responseUnavailable: boolean;
	/** Resolved cross-links to the resources this step references. */
	links: ResourceLink[];
	error?: string;
};

export type ResourceGroup = {
	id: ResourceGroupId;
	label: string;
	nodes: ResourceNode[];
};

/**
 * Pulls a small, display-worthy subset out of a step's (redacted) response.
 * The full snapshot already shows in the step timeline's expander — here we
 * surface only the high-signal fields so the tree stays scannable. Never the
 * whole response (avoids dumping large per-title id arrays inline).
 */
function summarizeResponse(
	response: unknown,
): Record<string, unknown> | undefined {
	if (response === null || typeof response !== "object") {
		return undefined;
	}
	const r = response as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	// Status-bearing reads (AWAIT_*): show terminal status + progress.
	if (typeof r.status === "string") {
		out.status = r.status;
	}
	if (typeof r.progress === "number") {
		out.progress = r.progress;
	}
	// Start ops: whether it started / was resumed across a crash.
	if (r.started === true) {
		out.started = true;
	}
	if (r.resumed === true) {
		out.resumed = true;
	}
	// Expansion ops (per-title): how many child resources were created.
	if (typeof r.created === "number") {
		out.created = r.created;
	}
	if (typeof r.attached === "number") {
		out.attached = r.attached;
	}
	// Resolve-by-list inputs (RTMP): how the id was resolved.
	if (typeof r.resolved === "string") {
		out.resolved = r.resolved;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A step "ran but recorded no response" only when it actually started (its
 * status is RUNNING/DONE/FAILED) AND no response snapshot exists. A PENDING
 * step never ran — that is "not started", not "response unavailable".
 */
function isResponseUnavailable(entry: StepLogEntry): boolean {
	if (entry.response !== undefined) {
		return false;
	}
	return entry.status !== "PENDING";
}

/**
 * Builds the grouped, cross-linked resource tree. Steps appear in their
 * persisted order within each group. Returns only non-empty groups in the
 * canonical order.
 */
export function buildResourceTree(entries: StepLogEntry[]): ResourceGroup[] {
	// Index: which step created a given Bitmovin resource id (for cross-links).
	const producerOf = new Map<string, { step: string; kind: OperationKind }>();
	for (const entry of entries) {
		if (entry.resourceId) {
			// First writer wins (resource ids are unique; defensive on dupes).
			if (!producerOf.has(entry.resourceId)) {
				producerOf.set(entry.resourceId, {
					step: entry.step,
					kind: entry.kind,
				});
			}
		}
	}

	const byGroup = new Map<ResourceGroupId, ResourceNode[]>();
	for (const entry of entries) {
		const group = GROUP_OF_KIND[entry.kind] ?? "other";
		const links: ResourceLink[] = [];
		for (const [key, value] of Object.entries(entry.refs)) {
			// refs may be a single id or an id array (e.g. vodHlsManifestIds).
			const ids = Array.isArray(value) ? value : [value];
			for (const resourceId of ids) {
				if (typeof resourceId !== "string") {
					continue;
				}
				const producer = producerOf.get(resourceId);
				links.push({
					key,
					resourceId,
					step: producer?.step,
					kind: producer?.kind,
				});
			}
		}
		const node: ResourceNode = {
			step: entry.step,
			kind: entry.kind,
			status: entry.status,
			resourceId: entry.resourceId,
			responseSummary: summarizeResponse(entry.response),
			responseUnavailable: isResponseUnavailable(entry),
			links,
			error: entry.error,
		};
		const list = byGroup.get(group);
		if (list) {
			list.push(node);
		} else {
			byGroup.set(group, [node]);
		}
	}

	return RESOURCE_GROUP_ORDER.flatMap((id) => {
		const nodes = byGroup.get(id);
		return nodes && nodes.length > 0
			? [{ id, label: RESOURCE_GROUP_LABEL[id], nodes }]
			: [];
	});
}
