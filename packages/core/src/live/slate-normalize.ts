import {
	canonicalPixelFormat,
	FRAME_RATE_EPSILON,
	MEDIA_ATTRIBUTE,
	type MediaAttributes,
	type ProbeResult,
	pushableVideoStreams,
	sourceMediaAttributes,
} from "./media-attributes";
import {
	classifySlateMedia,
	compareSlateCompatibility,
	SLATE_POSITION_ATTRIBUTE,
	slateContainer,
} from "./slate-compat";

/**
 * Slate NORMALIZATION — the contract that turns "does the clip match the
 * ingest?" into "make the clip match the ingest" .
 *
 * Measured 2026-09-12/13 across seven paid runs on AWS and Akamai
 * (research note `research-2026-09-13-slate-compatibility-matrix`):
 *
 *  - The provider plays a movie slate AS IS. Resolution (±2 px), sample
 *    rate, channel count, audio stream count (exactly one), H.264, AAC and
 *    yuv420p must equal the ingest or the reservation goes ERROR at air time.
 *  - Three mismatches pass every preflight and still fail: mono and yuv422p
 *    (the heartbeat reference cannot see them) go ERROR; MKV is accepted,
 *    reaches READY, and then silently never airs.
 *  - Two mismatches are accepted and BREAK the picture instead: a frame-rate
 *    mismatch is consumed at the ingest's rate (25 fps → 1.20× speed, 16.7 s
 *    of content in a 20 s window, then black); an open GOP is cut to 8 s.
 *  - MP4 and MOV slates air with their audio at HALF speed on every output
 *    rendition; only MPEG-TS plays audio at the right rate. This holds even
 *    for a clip that matches the ingest on every attribute.
 *  - Bitrate, GOP length, B-frames, profile, level and interlacing are free;
 *    a still image is admitted at any size (fitted on black).
 *
 * So the policy this module implements: a STILL IMAGE registers as it is; an
 * MPEG-TS movie that already matches the ingest registers as it is; every
 * other movie is transcoded to an MPEG-TS that matches the ingest — scaled
 * and padded to its geometry, resampled to its frame rate, yuv420p, closed
 * GOP, AAC at its sample rate and channel count, silence synthesised when
 * the clip has no audio. Nothing is refused for an attribute any more; only
 * a clip that cannot be read, or that carries no video, is refused.
 *
 * The target comes from the ingest reference, so a movie registered before
 * the encoder has connected WAITS for the input rather than guessing: the
 * worker re-runs the decision when a heartbeat with stream attributes
 * arrives (`WAIT_FOR_INPUT`). One attribute the heartbeat never carries is
 * the channel count (`numberOfAudioChannels` is null on a real RTMP ingest,
 * measured 2026-09-13); it is ASSUMED stereo then, and the assumption is
 * named on the row (`channelsAssumed`).
 *
 * Pure: argv and decisions only. Download, ffmpeg, upload and registration
 * live in the worker (`apps/worker/src/slate/`).
 */

/** The ingest attributes a normalized slate is made to match. */
export type SlateNormalizationTarget = {
	width: number;
	height: number;
	/** Frames per second (29.97002997… for NTSC), formatted by `formatFrameRate`. */
	frameRate: number;
	sampleRate: number;
	channels: number;
	/** True when the reference carried no channel count and stereo was assumed. */
	channelsAssumed: boolean;
};

/**
 * The channel count assumed when the ingest reference has none. RTMP/FLV
 * ingests are capped at stereo by the container, so this is the only value
 * a real-world reference can hold there; SRT could in principle carry more,
 * and the assumption is written onto the row so a mismatch is attributable.
 */
export const SLATE_ASSUMED_CHANNELS = 2;

/** Normalized outputs are named `<basename>.normalized-<w>x<h>-<fps>-<rate>-<ch>ch.ts`. */
export const SLATE_NORMALIZED_MARKER = ".normalized-";

/**
 * The largest source the worker will download for normalization. A slate is
 * seconds long; this bounds a wrong key (a feature film) at disk-size, not at
 * "whatever the bucket holds".
 */
export const SLATE_NORMALIZE_MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

/** The ffmpeg format token an MPEG-TS probe reports (`slateContainer`). */
export const SLATE_TS_CONTAINER = "mpegts";

/** What to do with a slate object before it is handed to the provider. */
export type SlatePreparation =
	| {
			action: "REGISTER_AS_IS";
			/** A still image, or an MPEG-TS movie that matches the ingest already. */
			reason: "IMAGE" | "MATCHES_INGEST";
	  }
	| {
			action: "NORMALIZE";
			target: SlateNormalizationTarget;
			/** Attribute names (the comparison table's vocabulary) that differ, plus `container`. */
			reasons: string[];
	  }
	| {
			action: "WAIT_FOR_INPUT";
			/** What the target still lacks — `ingest reference`, or attribute names. */
			missing: string[];
	  }
	| {
			action: "REFUSE";
			reason: string;
	  };

/**
 * The target a reference yields, or what it lacks. Geometry, frame rate and
 * sample rate are REQUIRED (a slate at the wrong one fails or plays fast);
 * the channel count falls back to `SLATE_ASSUMED_CHANNELS`.
 */
export function slateNormalizationTarget(
	ingest: MediaAttributes | null,
): { target: SlateNormalizationTarget } | { target: null; missing: string[] } {
	if (ingest === null) {
		return { target: null, missing: ["ingest reference"] };
	}
	const missing: string[] = [];
	const video = ingest.video;
	const audio = ingest.audio[0];
	if (video?.width === undefined || video.height === undefined) {
		missing.push("resolution");
	}
	if (video?.frameRate === undefined) {
		missing.push("frame rate");
	}
	if (audio?.sampleRate === undefined) {
		missing.push("audio sample rate");
	}
	if (
		missing.length > 0 ||
		video?.width === undefined ||
		video.height === undefined ||
		video.frameRate === undefined ||
		audio?.sampleRate === undefined
	) {
		return { target: null, missing };
	}
	return {
		target: {
			width: video.width,
			height: video.height,
			frameRate: video.frameRate,
			sampleRate: audio.sampleRate,
			channels: audio.channels ?? SLATE_ASSUMED_CHANNELS,
			channelsAssumed: audio.channels === undefined,
		},
	};
}

/** The facts the ffmpeg argv depends on, read off the probe once. */
export function slateProbeFacts(probe: ProbeResult): {
	hasVideo: boolean;
	hasAudio: boolean;
	/** ffprobe's `field_order` other than `progressive`/unknown. */
	interlaced: boolean;
} {
	const streams = probe.streams ?? [];
	const video = pushableVideoStreams(streams)[0];
	const fieldOrder = (video as { field_order?: string } | undefined)
		?.field_order;
	return {
		hasVideo: video !== undefined,
		hasAudio: streams.some((s) => s.codec_type === "audio"),
		interlaced:
			typeof fieldOrder === "string" &&
			fieldOrder !== "progressive" &&
			fieldOrder !== "unknown",
	};
}

/**
 * Decide what happens to the object. See the module docblock for the policy;
 * the order below is the order the questions can be answered in.
 */
export function decideSlatePreparation(
	probe: ProbeResult | null,
	ingest: MediaAttributes | null,
): SlatePreparation {
	if (probe === null) {
		return {
			action: "REFUSE",
			reason: "the file could not be probed, so nothing is known about it",
		};
	}
	const kind = classifySlateMedia(probe);
	if (kind === "image") {
		return { action: "REGISTER_AS_IS", reason: "IMAGE" };
	}
	if (kind === "unknown") {
		return {
			action: "REFUSE",
			reason: "ffprobe reported no container for the file",
		};
	}
	const facts = slateProbeFacts(probe);
	if (!facts.hasVideo) {
		return {
			action: "REFUSE",
			reason:
				"the file carries no video stream (a slate must be a movie or a still image)",
		};
	}
	const resolved = slateNormalizationTarget(ingest);
	if (resolved.target === null) {
		return { action: "WAIT_FOR_INPUT", missing: resolved.missing };
	}
	const target = resolved.target;
	const reasons: string[] = [];
	const add = (name: string) => {
		if (!reasons.includes(name)) {
			reasons.push(name);
		}
	};
	const container = slateContainer(probe);
	if (container !== SLATE_TS_CONTAINER) {
		add("container");
	}
	// The comparison table's own verdict, on what the reference can see.
	const verdict = compareSlateCompatibility(ingest, probe);
	for (const difference of verdict.differences) {
		if (difference.blocking && difference.attribute !== "container") {
			add(difference.attribute);
		}
	}
	// What the heartbeat reference cannot see, held to the measured rule.
	const media = sourceMediaAttributes(probe);
	const pixelFormat = canonicalPixelFormat(media.video?.pixelFormat);
	if (pixelFormat !== undefined && pixelFormat !== "yuv420p") {
		add(MEDIA_ATTRIBUTE.pixelFormat);
	}
	if (media.audio.length !== 1) {
		add(MEDIA_ATTRIBUTE.audioStreams);
	} else if (media.audio[0]?.channels !== target.channels) {
		add(MEDIA_ATTRIBUTE.audioChannels);
	}
	if (
		media.video?.frameRate !== undefined &&
		Math.abs(media.video.frameRate - target.frameRate) > FRAME_RATE_EPSILON
	) {
		add(MEDIA_ATTRIBUTE.frameRate);
	}
	if (probe.streams?.[0]?.codec_type !== "video") {
		add(SLATE_POSITION_ATTRIBUTE);
	}
	if (reasons.length === 0) {
		return { action: "REGISTER_AS_IS", reason: "MATCHES_INGEST" };
	}
	return { action: "NORMALIZE", target, reasons };
}

/**
 * Where the normalized MPEG-TS goes: next to the source, with the target in
 * its name, so the same source normalized for the same ingest OVERWRITES its
 * own output instead of accumulating copies, and a re-registration of an
 * output does not nest markers.
 */
export function slateNormalizedKey(
	sourceKey: string,
	target: SlateNormalizationTarget,
): string {
	const slash = sourceKey.lastIndexOf("/");
	const dir = slash >= 0 ? sourceKey.slice(0, slash + 1) : "";
	const base = sourceKey.slice(slash + 1);
	// The FULL basename, extension included: `brb.mp4` and `brb.mov` are two
	// clips and must not overwrite each other's output (review of #552, L6).
	const marker = base.indexOf(SLATE_NORMALIZED_MARKER);
	const stem = marker >= 0 ? base.slice(0, marker) : base;
	const fps = slateFrameRateToken(target.frameRate).replace("/", "_");
	return `${dir}${stem}${SLATE_NORMALIZED_MARKER}${target.width}x${target.height}-${fps}-${target.sampleRate}-${target.channels}ch.ts`;
}

export type BuildSlateNormalizeInput = {
	sourcePath: string;
	destPath: string;
	target: SlateNormalizationTarget;
	/** `slateProbeFacts` of the source. */
	hasAudio: boolean;
	interlaced: boolean;
};

/**
 * The frame rate as ffmpeg should be told it: the NTSC rationals exactly
 * (`30000/1001`, not the `29.97` the diff text uses — a slate at 2997/100
 * would be a measurable 0.03 ‰ off the ingest), integers plain, anything
 * else to three decimals.
 */
export function slateFrameRateToken(fps: number): string {
	for (const numerator of [24000, 30000, 60000]) {
		if (Math.abs(fps - numerator / 1001) < 0.001) {
			return `${numerator}/1001`;
		}
	}
	return Number.isInteger(fps) ? String(fps) : fps.toFixed(3);
}

/** ffmpeg's channel-layout token for a channel count. */
function channelLayout(channels: number): string {
	return channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels}c`;
}

/**
 * The transcode. Each choice is a measured requirement or a measured
 * freedom (module docblock): scale+pad keeps the picture's aspect inside the
 * ingest geometry (the provider fits stills on black the same way); `fps`
 * makes the stream CFR at the ingest rate; `format=yuv420p`; libx264 with a
 * 2 s CLOSED GOP (`-flags +cgop`, `-sc_threshold 0` so a scene cut cannot
 * open one); AAC at the ingest rate and channel count; `-f mpegts`. A source
 * without audio gets synthesised silence cut at the video's end
 * (`-shortest`); an interlaced source is deinterlaced frame-for-frame so the
 * rate is unchanged. Bitrate is free, so quality is CRF-driven.
 */
export function buildSlateNormalizeArgs(
	input: BuildSlateNormalizeInput,
): string[] {
	const { target } = input;
	const fps = slateFrameRateToken(target.frameRate);
	const gop = String(Math.max(1, Math.round(target.frameRate * 2)));
	const filters = [
		...(input.interlaced ? ["yadif=mode=send_frame"] : []),
		`scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
		`pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
		"setsar=1",
		`fps=${fps}`,
		"format=yuv420p",
	];
	return [
		"-hide_banner",
		"-nostdin",
		"-v",
		"error",
		"-y",
		"-i",
		input.sourcePath,
		...(input.hasAudio
			? []
			: [
					"-f",
					"lavfi",
					"-i",
					`anullsrc=r=${target.sampleRate}:cl=${channelLayout(target.channels)}`,
				]),
		// `0:V:0`, not `0:v:0`: capital V excludes attached pictures (cover
		// art is typed `video` too), matching `pushableVideoStreams`.
		"-map",
		"0:V:0",
		"-map",
		input.hasAudio ? "0:a:0" : "1:a:0",
		"-vf",
		filters.join(","),
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-profile:v",
		"high",
		"-pix_fmt",
		"yuv420p",
		"-crf",
		"21",
		"-g",
		gop,
		"-keyint_min",
		gop,
		"-sc_threshold",
		"0",
		"-flags",
		"+cgop",
		"-c:a",
		"aac",
		"-ar",
		String(target.sampleRate),
		"-ac",
		String(target.channels),
		"-b:a",
		"128k",
		...(input.hasAudio ? [] : ["-shortest"]),
		"-f",
		"mpegts",
		input.destPath,
	];
}

// ---------------------------------------------------------------------------
// Where the converted file goes
// ---------------------------------------------------------------------------

/** A bucket the channel already writes to, with the prefix its slates go under. */
export type SlateConversionDestination = {
	credentialId: string;
	bucket: string;
	/** Directory prefix without slashes at either end; never empty (`slates` at the root). */
	keyPrefix: string;
	/** The plan output's `key`, for the row's note. */
	outputKey: string;
};

/** Output kinds the worker can upload to (`createS3Browser` provides `putObject`). */
const S3_FAMILY_OUTPUT_KINDS: ReadonlySet<string> = new Set([
	"S3",
	"GENERIC_S3",
]);

function commonDirectoryPrefix(paths: string[]): string {
	const normalized = paths.map((p) => p.replace(/^\/+|\/+$/g, ""));
	// A destination at the bucket root pins the root: slates must not land
	// inside another destination's segment directory.
	if (normalized.some((p) => p.length === 0)) {
		return "";
	}
	const parts = normalized.map((p) => p.split("/"));
	if (parts.length === 0) {
		return "";
	}
	const first = parts[0] as string[];
	let n = first.length;
	for (const other of parts.slice(1)) {
		let i = 0;
		while (i < n && i < other.length && other[i] === first[i]) {
			i += 1;
		}
		n = i;
	}
	return first.slice(0, n).join("/");
}

/**
 * The conversion destination a channel's plan implies: its first S3-family
 * output (the channel writes segments there, so the credential is writable
 * by construction), under the directory its muxings and manifests share plus
 * `/slates`. Null when the plan has no such output (an MSL-only channel):
 * the caller then writes next to the source, which needs a credential that
 * can write there. The plan is read loosely on purpose — a plan that fails
 * the strict schema still names an output.
 */
export function slateConversionDestination(
	plan: unknown,
): SlateConversionDestination | null {
	if (typeof plan !== "object" || plan === null) {
		return null;
	}
	const p = plan as {
		outputs?: unknown;
		muxings?: unknown;
		liveManifests?: unknown;
	};
	const outputs = Array.isArray(p.outputs) ? p.outputs : [];
	const output = outputs.find(
		(
			o,
		): o is {
			key: string;
			kind: string;
			credentialId: string;
			bucket: string;
		} =>
			typeof o === "object" &&
			o !== null &&
			S3_FAMILY_OUTPUT_KINDS.has(String((o as { kind?: unknown }).kind)) &&
			typeof (o as { credentialId?: unknown }).credentialId === "string" &&
			typeof (o as { bucket?: unknown }).bucket === "string" &&
			typeof (o as { key?: unknown }).key === "string",
	);
	if (!output) {
		return null;
	}
	// A delivery MIRROR is written at the same paths as the primary, so it
	// is never a destination's `outputKey` — take every path then.
	const mirrors = Array.isArray(
		(p as { deliveryMirrors?: unknown }).deliveryMirrors,
	)
		? ((p as { deliveryMirrors: unknown[] }).deliveryMirrors as {
				outputKey?: unknown;
			}[])
		: [];
	const isMirror = mirrors.some((m) => m?.outputKey === output.key);
	const paths: string[] = [];
	for (const list of [p.muxings, p.liveManifests]) {
		if (!Array.isArray(list)) {
			continue;
		}
		for (const entry of list) {
			const destination = (entry as { destination?: unknown })?.destination as
				| { outputKey?: unknown; path?: unknown }
				| undefined;
			if (
				(isMirror || destination?.outputKey === output.key) &&
				typeof destination?.path === "string"
			) {
				paths.push(destination.path);
			}
		}
	}
	const base = commonDirectoryPrefix(paths);
	return {
		credentialId: output.credentialId,
		bucket: output.bucket,
		keyPrefix: base.length > 0 ? `${base}/slates` : "slates",
		outputKey: output.key,
	};
}

/**
 * The normalized key at a destination: `<prefix>/<source bucket>/<source key>`
 * so two sources that share a basename (`brand-a/brb.mp4`, `brand-b/brb.mp4`,
 * or one key in two buckets) never overwrite each other's output, and the
 * same source converted again for the same ingest overwrites its own.
 */
export function slateDestinationKey(
	destination: SlateConversionDestination,
	source: { bucket: string; key: string },
	target: SlateNormalizationTarget,
): string {
	const sourcePath = `${source.bucket}/${source.key.replace(/^\/+/, "")}`;
	return slateNormalizedKey(`${destination.keyPrefix}/${sourcePath}`, target);
}
