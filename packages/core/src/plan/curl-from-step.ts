import type { OperationKind } from "./compiler";
import type { StepLogEntry } from "./steplog";

/**
 * Builds a runnable, SECRET-FREE `curl` from a persisted step-log entry.
 *
 * `entry.request` does NOT carry an HTTP method/url — the executor snapshots
 * only `{ ...op.payload, refs: <resolved> }` (executor.ts: `const request =
 * { ...op.payload, refs }`). So the method + URL are reconstructed HERE from
 * an OPERATION_KIND → {method, urlTemplate} table mirroring every `audited(
 * method, path, …)` call in apps/worker/src/orchestrator/sdk-ops.ts (the
 * source of truth — keep these in lockstep). Path params (`{encodingId}`,
 * `{manifestId}`, `{muxingId}`, `{periodId}`, `{adaptationSetId}`,
 * `{streamId}`, `{streamInfoId}`, `{representationId}`) are filled from the
 * step's RESOLVED refs (the executor stores `entry.refs` resolved to Bitmovin
 * ids). DRM endpoints additionally splice a `{muxingKind}` path segment read
 * from the (redacted) payload.
 *
 * Secret-free by construction:
 *  - the body is `entry.request`, already `redactSecrets`-ed by the executor
 *    before persistence (steplog CONTRACT) — no key/license/passphrase in it;
 *  - the auth header is a shell-variable PLACEHOLDER, never a real key (no key
 *    exists in the step log anyway);
 *  - the org header, when emitted, is a placeholder too.
 *
 * Returns `null` when the kind has no single mappable write endpoint — reads
 * (AWAIT_*), the runtime SCTE35_CUE / ESAM_MEDIA_POINT records, and the resolve-by-list
 * CREATE_INPUT_RTMP (no POST endpoint exists) — so callers render a graceful
 * "cURL unavailable" rather than a wrong command. CREATE_STREAM_FILTERS maps
 * (it is a real POST) even though it returns no own resource id.
 */

export type CurlOptions = {
	/** Base, default the public Bitmovin host. */
	baseUrl?: string;
	/** Emit an `X-Tenant-Org-Id` placeholder header (sub-org calls). */
	includeOrgHeader?: boolean;
};

type EndpointDef = {
	method: "POST";
	/** `:param` segments are filled from the resolved refs (or muxingKind). */
	template: string;
};

/**
 * OPERATION_KIND → endpoint. Every entry corresponds to exactly one
 * `audited("POST", "<path>", …)` in sdk-ops.ts. `:name` placeholders resolve
 * from the resolved refs; `:muxingKind` (DRM only) resolves from the payload.
 * Kinds absent here have no single mappable write endpoint (see module doc)
 * and yield a null curl.
 */
const ENDPOINTS: Partial<Record<OperationKind, EndpointDef>> = {
	// inputs / outputs
	CREATE_INPUT_S3: { method: "POST", template: "/encoding/inputs/s3" },
	CREATE_INPUT_AZURE: { method: "POST", template: "/encoding/inputs/azure" },
	CREATE_INPUT_HTTPS: { method: "POST", template: "/encoding/inputs/https" },
	CREATE_INPUT_GENERIC_S3: {
		method: "POST",
		template: "/encoding/inputs/generic-s3",
	},
	CREATE_INPUT_GCS: { method: "POST", template: "/encoding/inputs/gcs" },
	CREATE_INPUT_GCS_SERVICE_ACCOUNT: {
		method: "POST",
		template: "/encoding/inputs/gcs-service-account",
	},
	CREATE_OUTPUT_S3: { method: "POST", template: "/encoding/outputs/s3" },
	CREATE_OUTPUT_AZURE: { method: "POST", template: "/encoding/outputs/azure" },
	CREATE_OUTPUT_SFTP: { method: "POST", template: "/encoding/outputs/sftp" },
	CREATE_OUTPUT_GENERIC_S3: {
		method: "POST",
		template: "/encoding/outputs/generic-s3",
	},
	CREATE_OUTPUT_GCS: { method: "POST", template: "/encoding/outputs/gcs" },
	CREATE_OUTPUT_GCS_SERVICE_ACCOUNT: {
		method: "POST",
		template: "/encoding/outputs/gcs-service-account",
	},
	CREATE_OUTPUT_LIVE_MEDIA_INGEST: {
		method: "POST",
		template: "/encoding/outputs/live-media-ingest",
	},
	CREATE_OUTPUT_AKAMAI_MSL: {
		method: "POST",
		template: "/encoding/outputs/akamai-msl",
	},
	// . The SDK's namespace is `akamaiNetstorage` — lowercase `s` —
	// while the model class is `AkamaiNetStorageOutput`. The REST path follows
	// the namespace, and the casing difference is the kind of detail that
	// produces a 404 nobody can explain.
	CREATE_OUTPUT_AKAMAI_NETSTORAGE: {
		method: "POST",
		template: "/encoding/outputs/akamai-netstorage",
	},
	CREATE_INPUT_AKAMAI_NETSTORAGE: {
		method: "POST",
		template: "/encoding/inputs/akamai-netstorage",
	},
	// encoding
	CREATE_ENCODING: { method: "POST", template: "/encoding/encodings" },
	// input streams
	CREATE_INGEST_INPUT_STREAM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/input-streams/ingest",
	},
	CREATE_FILE_INPUT_STREAM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/input-streams/file",
	},
	CREATE_DOLBY_ATMOS_INPUT_STREAM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/input-streams/dolby-atmos",
	},
	CREATE_DOLBY_VISION_INPUT_STREAM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/input-streams/dolby-vision",
	},
	CREATE_DOLBY_VISION_METADATA_INPUT_STREAM: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/input-streams/sidecar/dolby-vision-metadata-ingest",
	},
	CREATE_TRIMMING_TIME_BASED: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/input-streams/trimming/time-based",
	},
	CREATE_TRIMMING_TIMECODE_TRACK: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/input-streams/trimming/timecode-track",
	},
	CREATE_TRIMMING_H264_PICTURE_TIMING: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/input-streams/trimming/h264-picture-timing",
	},
	CREATE_CONCATENATION_INPUT_STREAM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/input-streams/concatenation",
	},
	CREATE_AUDIO_MIX_INPUT_STREAM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/input-streams/audio-mix",
	},
	// codec configs
	CREATE_CODEC_H264: {
		method: "POST",
		template: "/encoding/configurations/video/h264",
	},
	CREATE_CODEC_H265: {
		method: "POST",
		template: "/encoding/configurations/video/h265",
	},
	CREATE_CODEC_VP9: {
		method: "POST",
		template: "/encoding/configurations/video/vp9",
	},
	CREATE_CODEC_AV1: {
		method: "POST",
		template: "/encoding/configurations/video/av1",
	},
	CREATE_CODEC_OPUS: {
		method: "POST",
		template: "/encoding/configurations/audio/opus",
	},
	CREATE_CODEC_IMSC: {
		method: "POST",
		template: "/encoding/configurations/subtitles/imsc",
	},
	CREATE_MUXING_TEXT: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/text",
	},
	CREATE_DASH_REPRESENTATION_IMSC: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/:adaptationSetId/representations/imsc",
	},
	CREATE_FILTER_DENOISE_HQDN3D: {
		method: "POST",
		template: "/encoding/filters/denoise-hqdn3d",
	},
	CREATE_FILTER_UNSHARP: {
		method: "POST",
		template: "/encoding/filters/unsharp",
	},
	CREATE_CODEC_AAC: {
		method: "POST",
		template: "/encoding/configurations/audio/aac",
	},
	CREATE_CODEC_DOLBY_ATMOS: {
		method: "POST",
		template: "/encoding/configurations/audio/dolby-atmos",
	},
	CREATE_CODEC_DDPLUS: {
		method: "POST",
		template: "/encoding/configurations/audio/dolby-digital-plus",
	},
	CREATE_CODEC_DD: {
		method: "POST",
		template: "/encoding/configurations/audio/dolby-digital",
	},
	CREATE_CODEC_WEBVTT: {
		method: "POST",
		template: "/encoding/configurations/subtitles/webvtt",
	},
	// streams / filters / keyframes / thumbnails / watermarks
	CREATE_STREAM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/streams",
	},
	CREATE_STREAM_HDR_DOLBY_VISION: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/streams/:streamId/hdr/dolby-vision",
	},
	CREATE_BURN_IN_SRT: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/streams/:streamId/burn-in-subtitles/srt",
	},
	CREATE_DASH_ADAPTATION_SET_SUBTITLE: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/subtitle",
	},
	CREATE_DASH_REPRESENTATION_CHUNKED_TEXT: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/:adaptationSetId/representations/chunked-text",
	},
	CREATE_FILTER_CROP: { method: "POST", template: "/encoding/filters/crop" },
	CREATE_FILTER_ROTATE: {
		method: "POST",
		template: "/encoding/filters/rotate",
	},
	CREATE_FILTER_WATERMARK: {
		method: "POST",
		template: "/encoding/filters/watermark",
	},
	CREATE_FILTER_TEXT: { method: "POST", template: "/encoding/filters/text" },
	CREATE_FILTER_AUDIO_VOLUME: {
		method: "POST",
		template: "/encoding/filters/audio-volume",
	},
	CREATE_FILTER_EBU_R128_SINGLE_PASS: {
		method: "POST",
		template: "/encoding/filters/ebu-r128-single-pass",
	},
	CREATE_FILTER_DEINTERLACE: {
		method: "POST",
		template: "/encoding/filters/deinterlace",
	},
	CREATE_STREAM_FILTERS: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/streams/:streamId/filters",
	},
	CREATE_KEYFRAME: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/keyframes",
	},
	CREATE_KANTAR_WATERMARK: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/kantar-watermark",
	},
	CREATE_NEXGUARD_FILE_MARKER: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/streams/:streamId/watermarking/nexguard-file-marker",
	},
	CREATE_THUMBNAIL: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/streams/:streamId/thumbnails",
	},
	CREATE_SPRITE: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/streams/:streamId/sprites",
	},
	// muxings
	CREATE_MUXING_CMAF: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/cmaf",
	},
	CREATE_MUXING_FMP4: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/fmp4",
	},
	CREATE_MUXING_MP4: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/mp4",
	},
	CREATE_MUXING_PROGRESSIVE_WEBM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/progressive-webm",
	},
	CREATE_MUXING_TS: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/ts",
	},
	CREATE_MUXING_WEBM: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/webm",
	},
	CREATE_MUXING_CHUNKED_TEXT: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/muxings/chunked-text",
	},
	// drm — :muxingKind resolves to the lowercase muxing path (fmp4/mp4/ts/webm)
	CREATE_DRM_CENC: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/muxings/:muxingKind/:muxingId/drm/cenc",
	},
	CREATE_DRM_SPEKE: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/muxings/fmp4/:muxingId/drm/speke",
	},
	CREATE_DRM_FAIRPLAY: {
		method: "POST",
		template:
			"/encoding/encodings/:encodingId/muxings/:muxingKind/:muxingId/drm/fairplay",
	},
	// HLS manifest tree
	CREATE_MANIFEST_HLS: { method: "POST", template: "/encoding/manifests/hls" },
	CREATE_HLS_AUDIO_MEDIA: {
		method: "POST",
		template: "/encoding/manifests/hls/:manifestId/media/audio",
	},
	CREATE_HLS_STREAM_INFO: {
		method: "POST",
		template: "/encoding/manifests/hls/:manifestId/streams",
	},
	CREATE_HLS_SUBTITLES_MEDIA: {
		method: "POST",
		template: "/encoding/manifests/hls/:manifestId/media/subtitles",
	},
	CREATE_HLS_IFRAME_PLAYLIST: {
		method: "POST",
		template:
			"/encoding/manifests/hls/:manifestId/streams/:streamInfoId/iframe",
	},
	// DASH manifest tree
	CREATE_MANIFEST_DASH: {
		method: "POST",
		template: "/encoding/manifests/dash",
	},
	CREATE_DASH_PERIOD: {
		method: "POST",
		template: "/encoding/manifests/dash/:manifestId/periods",
	},
	CREATE_DASH_ADAPTATION_SET_VIDEO: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/video",
	},
	CREATE_DASH_ADAPTATION_SET_AUDIO: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/audio",
	},
	CREATE_DASH_REPRESENTATION_CMAF: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/:adaptationSetId/representations/cmaf",
	},
	CREATE_DASH_REPRESENTATION_FMP4: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/:adaptationSetId/representations/fmp4",
	},
	CREATE_DASH_REPRESENTATION_WEBM: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/:adaptationSetId/representations/webm",
	},
	CREATE_DASH_REPRESENTATION_MP4: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/:adaptationSetId/representations/mp4",
	},
	CREATE_DASH_CONTENT_PROTECTION: {
		method: "POST",
		template:
			"/encoding/manifests/dash/:manifestId/periods/:periodId/adaptationsets/:adaptationSetId/representations/fmp4/:representationId/contentprotection",
	},
	// SMOOTH manifest tree
	CREATE_MANIFEST_SMOOTH: {
		method: "POST",
		template: "/encoding/manifests/smooth",
	},
	CREATE_SMOOTH_REPRESENTATION_MP4: {
		method: "POST",
		template: "/encoding/manifests/smooth/:manifestId/representations/mp4",
	},
	CREATE_SMOOTH_CONTENT_PROTECTION: {
		method: "POST",
		template: "/encoding/manifests/smooth/:manifestId/contentprotection",
	},
	// starts (AWAIT_* are reads → no curl)
	START_ENCODING: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/start",
	},
	START_MANIFEST_HLS: {
		method: "POST",
		template: "/encoding/manifests/hls/:manifestId/start",
	},
	START_MANIFEST_DASH: {
		method: "POST",
		template: "/encoding/manifests/dash/:manifestId/start",
	},
	START_MANIFEST_SMOOTH: {
		method: "POST",
		template: "/encoding/manifests/smooth/:manifestId/start",
	},
	// live (P3)
	CREATE_INPUT_REDUNDANT_RTMP: {
		method: "POST",
		template: "/encoding/inputs/redundant-rtmp",
	},
	CREATE_INPUT_SRT: { method: "POST", template: "/encoding/inputs/srt" },
	CREATE_INPUT_ZIXI: { method: "POST", template: "/encoding/inputs/zixi" },
	CREATE_INPUT_HLS_LIVE: { method: "POST", template: "/encoding/inputs/hls" },
	START_LIVE_ENCODING: {
		method: "POST",
		template: "/encoding/encodings/:encodingId/live/start",
	},
	// NOTE absent (null curl): AWAIT_ENCODING / AWAIT_MANIFEST_* /
	// AWAIT_LIVE_RUNNING (status reads), SCTE35_CUE, ESAM_MEDIA_POINT,
	// SLATE_INSERTED and its three #238 verdicts SLATE_CONFIRMED /
	// SLATE_FAILED / SLATE_UNCONFIRMED (runtime records — the step log
	// records that they happened, and the reproducible request lives in the
	// C7 audit row; the verdicts additionally describe a READ, not a call),
	// CREATE_INPUT_RTMP (resolve-by-list; no POST endpoint),
	// CREATE_DASH_PER_TITLE_REPRESENTATIONS / CREATE_HLS_PER_TITLE_VARIANTS /
	// CREATE_SMOOTH_PER_TITLE_ENTRIES (expansion ops — many calls, not one).
};

/** A single resolved-ref value (string id). Arrays are not path params. */
function refScalar(entry: StepLogEntry, key: string): string | undefined {
	const value = entry.refs[key];
	return typeof value === "string" ? value : undefined;
}

/** DRM muxing path segment (fmp4/mp4/ts/webm) from the redacted payload. */
function muxingKindSegment(entry: StepLogEntry): string | undefined {
	const kind = (entry.payload as { muxingKind?: unknown }).muxingKind;
	return typeof kind === "string" ? kind.toLowerCase() : undefined;
}

/**
 * Fills `:param` segments. Returns null if any required segment is missing —
 * a half-substituted URL would be a wrong command (we render "unavailable"
 * instead).
 */
function fillTemplate(template: string, entry: StepLogEntry): string | null {
	const segments = template.split("/").map((segment) => {
		if (!segment.startsWith(":")) {
			return segment;
		}
		const name = segment.slice(1);
		const value =
			name === "muxingKind" ? muxingKindSegment(entry) : refScalar(entry, name);
		return value;
	});
	if (segments.some((segment) => segment === undefined)) {
		return null;
	}
	return segments.join("/");
}

/** Whether this op kind carries a request body worth sending with `--data`. */
function hasBody(
	method: string,
	body: unknown,
): body is Record<string, unknown> {
	if (method !== "POST" || body === null || typeof body !== "object") {
		return false;
	}
	// `entry.request` always carries at least `{ refs }`; the curl body should
	// be the persisted snapshot MINUS the refs bookkeeping (refs are URL/body
	// material the SDK assembles, not literal request JSON the operator pastes).
	const keys = Object.keys(body as Record<string, unknown>).filter(
		(k) => k !== "refs",
	);
	return keys.length > 0;
}

/** Single-quote a value for safe inclusion in a `'…'` shell argument. */
function shellSingleQuote(value: string): string {
	// Close quote, escaped literal quote, reopen — POSIX-portable.
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Strips the `refs` bookkeeping key from the snapshot so the `--data` body is
 * the actual (redacted) request JSON. Returns undefined when nothing remains.
 */
function curlBody(
	request: unknown,
	liveStart = false,
	watermark = false,
): string | undefined {
	if (request === null || typeof request !== "object") {
		return undefined;
	}
	const {
		refs: _refs,
		internalHevcV2: _internalHevcV2,
		bcfVersion: _bcfVersion,
		...rest
	} = request as Record<string, unknown>;
	if (liveStart) delete rest.encodingOption;
	if (watermark) {
		delete rest.inputKey;
		delete rest.imagePath;
		delete rest.imageInput;
		rest.image = "{{WATERMARK_IMAGE_URL}}";
	}
	if (Object.keys(rest).length === 0) {
		return undefined;
	}
	return JSON.stringify(rest, null, 2);
}

/**
 * Why no curl could be built. A CODE plus the step kind, not a sentence: this package
 * is UI-free (ARCHITECTURE §2), so it cannot hold a translator, and the reason is
 * rendered as a tooltip in a Japanese UI. The caller maps the code to copy — the same
 * split `ingest-coordinates.ts` and `dvrGaugeModel` use.
 */
export type CurlUnavailable =
	/** No single Bitmovin endpoint maps to this step kind (reads, list-resolves, fan-outs). */
	| { code: "NO_ENDPOINT"; kind: string }
	/** The endpoint exists but the step lacks a ref the URL template needs. */
	| { code: "UNRESOLVED_PATH_PARAMS"; kind: string };

export type CurlResult =
	| { ok: true; command: string }
	| ({ ok: false } & CurlUnavailable);

/**
 * Returns the curl command for a step, or a `CurlUnavailable` code saying why not.
 * The placeholder auth header is a shell variable — NEVER a real key.
 */
export function curlForStep(
	entry: StepLogEntry,
	options: CurlOptions = {},
): CurlResult {
	let endpoint = ENDPOINTS[entry.kind];
	if (
		entry.kind === "CREATE_CODEC_H265" &&
		entry.payload.internalHevcV2 === true
	)
		endpoint = {
			method: "POST",
			template: "/encoding/configurations/video/h265v2",
		};
	if (entry.kind === "START_LIVE_ENCODING") {
		const option = entry.payload.encodingOption;
		if (option !== undefined && option !== "HD" && option !== "CUSTOM")
			return { ok: false, code: "NO_ENDPOINT", kind: entry.kind };
		if (option === "HD")
			endpoint = {
				method: "POST",
				template: "/encoding/encodings/:encodingId/live/hd/start",
			};
	}
	if (!endpoint) {
		return { ok: false, code: "NO_ENDPOINT", kind: entry.kind };
	}
	const path = fillTemplate(endpoint.template, entry);
	if (path === null) {
		return { ok: false, code: "UNRESOLVED_PATH_PARAMS", kind: entry.kind };
	}
	const base = (options.baseUrl ?? "https://api.bitmovin.com/v1").replace(
		/\/$/,
		"",
	);
	const url = `${base}${path}`;

	const lines = [`curl -X ${endpoint.method} ${shellSingleQuote(url)}`];
	// Placeholder auth — secret-free by construction (no real key in the log).
	lines.push(`  -H 'X-Api-Key: $BITMOVIN_API_KEY'`);
	if (options.includeOrgHeader) {
		lines.push(`  -H 'X-Tenant-Org-Id: $BITMOVIN_TENANT_ORG_ID'`);
	}
	if (typeof entry.payload.bcfVersion === "string")
		lines.push(
			`  -H ${shellSingleQuote(`X-BITMOVIN-BCF-VERSION: ${entry.payload.bcfVersion}`)}`,
		);
	const body = hasBody(endpoint.method, entry.request)
		? curlBody(
				entry.request,
				entry.kind === "START_LIVE_ENCODING",
				entry.kind === "CREATE_FILTER_WATERMARK",
			)
		: undefined;
	if (body !== undefined) {
		lines.push(`  -H 'Content-Type: application/json'`);
		lines.push(`  --data ${shellSingleQuote(body)}`);
	}
	return { ok: true, command: lines.join(" \\\n") };
}

/** True when a step has a mappable, fully-resolvable curl. */
export function canCurlStep(entry: StepLogEntry): boolean {
	return curlForStep(entry).ok;
}
