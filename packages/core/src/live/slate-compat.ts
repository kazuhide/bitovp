import {
	evaluateMediaAttributes,
	MEDIA_ATTRIBUTE,
	MEDIA_ATTRIBUTE_NAMES,
	type MediaAttributeName,
	type MediaAttributes,
	type MediaDifference,
	type ProbeResult,
	sourceMediaAttributes,
} from "./media-attributes";

/**
 * Does a slate clip match the live stream it will be cut into? (C36)
 *
 * Bitmovin's rule, quoted from the SDK's own `InsertableContent` model:
 *
 *   "The movie files must have a video stream at stream position 0, which
 *    matches the codec, resolution and framerate of the livestream. The
 *    number of audio streams must also be the same and they have to match
 *    the sample format, number of channels and sample rate of the audio
 *    streams of the livestream."
 *
 * READY does not check any of it. Measured 2026-09-02 (channel 0645c2f1,
 * ), four arms through the
 * direct path against a 1280×720 @ 30 fps / AAC 48 kHz ingest:
 *
 *  - MKV at 23.976 fps / 44.1 kHz → scheduled entry CREATED → ERROR at +22 s;
 *  - MP4 at 30 fps / 48 kHz (same geometry, High, stereo) → SCHEDULED at once,
 *    never errored;
 *  - MP4 at 23.976 fps / 44.1 kHz → CREATED → ERROR at +22 s;
 *  - the MKV again with a leading `/` on the path → CREATED → ERROR at +22 s.
 *
 * So the attribute mismatch (frame rate and/or audio sample rate — the two
 * were not separable with those files, and Bitmovin's rule requires both) is
 * the cause; the CONTAINER is not decisive (the mismatched MP4 failed the
 * same way) and the leading slash is irrelevant. Content `READY` arrived
 * 1–5 s after creation in every arm and predicted nothing: READY means
 * "registered", nothing more. This module is the check the provider does
 * not perform until air time.
 *
 * THE RULE IS DATA. `SLATE_BLOCKING_ATTRIBUTES` names which measured
 * differences refuse a slate; `SLATE_CONTAINER_ALLOWLIST` names the
 * documented containers (reported, not refused — per the A/B above);
 * `SLATE_ALLOW_IMAGES` says whether a still image is admitted (yes since
 * ); `SLATE_INPUT_PATH_LEADING_SLASH` says what happens
 * to a leading `/`. Everything else is reported and does not block, so
 * changing the rule after another provider A/B is a one-line edit of one of
 * the four.
 *
 * Conservative on every axis, like the feeder gate it grew out of: no probe or
 * no ingest reference means the corresponding checks STAND DOWN (`standDown`
 * says which), and only a measured, blocking difference refuses.
 */

// ---------------------------------------------------------------------------
// The rule set — edit HERE after a provider A/B, nowhere else
// ---------------------------------------------------------------------------

/** Attribute name for a clip whose stream 0 is not video. */
export const SLATE_POSITION_ATTRIBUTE = "video stream position";
/** Attribute name for a container outside the documented list. */
export const SLATE_CONTAINER_ATTRIBUTE = "container";
/** Attribute name for a still image offered where a movie is expected. */
export const SLATE_KIND_ATTRIBUTE = "media kind";

/**
 * ffprobe demuxer tokens (`format.format_name`, comma-separated) of the
 * DOCUMENTED movie container. ffprobe names the QuickTime family as one
 * demuxer, `mov,mp4,m4a,3gp,3g2,mj2`, so both spellings are listed and either
 * token matches. Anything else (Matroska, MPEG-TS …) is REPORTED as a
 * difference and does not block: the 2026-09-02 A/B showed an MP4 with
 * mismatched attributes failing exactly like the MKV, so the container is not
 * a cause and must not be presented as one.
 */
export const SLATE_CONTAINER_ALLOWLIST: readonly string[] = ["mov", "mp4"];

/**
 * Demuxer tokens that mean "a single image file", which Bitmovin's contract
 * admits under a separate clause (PNG, JPEG, GIF, BMP, WebP, TIFF … with
 * `durationInSeconds` required at schedule time). An image has no frame rate
 * or audio to match, so the attribute table does not apply to it. Image
 * admission is decided separately by `SLATE_ALLOW_IMAGES`.
 */
export const SLATE_IMAGE_DEMUXERS: readonly string[] = [
	"png_pipe",
	"apng",
	"jpeg_pipe",
	"image2",
	"gif",
	"bmp_pipe",
	"webp_pipe",
	"tiff_pipe",
];

/**
 * Still images are ADMITTED . Evidence:
 * a JPEG and a transparent PNG inserted through the provider API played for
 * the requested 15 s as a silent, letterboxed-on-black replacement with one
 * black frame at the 10 s mark (* Run29). A still has no frame rate or audio to match, so the attribute table
 * stands down for it; the schedule must carry a duration, which every app
 * path already sends. Formats beyond JPEG/PNG are not measured.
 */
export const SLATE_ALLOW_IMAGES = true;

/**
 * The differences that REFUSE a slate. The positional rule and every
 * attribute the comparison table can emit block (the provider's contract
 * names codec, resolution, frame rate and every audio attribute; the
 * profile/level/pixel-format rows are what the same clip would trip on a copy
 * push, and the A/B could not separate frame rate from sample rate, so both
 * stay). The CONTAINER blocks too since : an MKV whose attributes
 * matched was accepted, reached READY and then silently never aired
 * (measured twice, AWS and Akamai, 2026-09-13) — the one failure neither the
 * tool nor the provider reports. MP4/MOV and MPEG-TS raise no container
 * difference at all (`SLATE_CONTAINER_ADMITTED`). Add or remove a name to
 * change the rule; the difference still appears in `differences` either way.
 */
export const SLATE_BLOCKING_ATTRIBUTES: ReadonlySet<string> = new Set<string>([
	SLATE_POSITION_ATTRIBUTE,
	SLATE_KIND_ATTRIBUTE,
	SLATE_CONTAINER_ATTRIBUTE,
	...MEDIA_ATTRIBUTE_NAMES,
]);

/**
 * Container FAMILIES (as `slateContainer` names them) that register without
 * a container difference: the documented QuickTime family (`mp4`, which the
 * measured audio half-rate makes a normalization candidate, not a refusal —
 * `slate-normalize.ts`) and MPEG-TS, the one container whose audio plays at
 * the right rate. Everything else (`matroska`, `avi`, …) blocks.
 */
export const SLATE_CONTAINER_ADMITTED: readonly string[] = ["mp4", "mpegts"];

/**
 * An `inputPath` is an object key, and object keys carry no leading slash;
 * the panel's placeholder (`/slates/brb.mp4`) taught operators to type one.
 * The A/B's fourth arm showed the slash is irrelevant to the outcome (the
 * same MKV failed with and without it), so this is tidiness, not a cause:
 * `strip` sends the key as the scheduled-source path always has, `keep`
 * would send it verbatim. The original is recorded either way.
 */
export const SLATE_INPUT_PATH_LEADING_SLASH: "strip" | "keep" = "strip";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlateMediaKind = "movie" | "image" | "unknown";

export type SlateStandDown =
	| "NO_PROBE"
	| "NO_INGEST_REFERENCE"
	/** A reference exists but carries nothing the clip can be compared on. */
	| "NO_COMPARABLE_ATTRIBUTE";

export type SlateAttributeName =
	| MediaAttributeName
	| typeof SLATE_POSITION_ATTRIBUTE
	| typeof SLATE_CONTAINER_ATTRIBUTE
	| typeof SLATE_KIND_ATTRIBUTE;
export type SlateDifference = Omit<MediaDifference, "attribute"> & {
	attribute: SlateAttributeName;
	/** True when this difference alone refuses the slate. */
	blocking: boolean;
};

export type SlateCompatibility = {
	/** False only on a measured, blocking difference. */
	ok: boolean;
	/**
	 * Which checks could run. The container and position checks need a probe;
	 * the attribute checks need a probe AND an ingest reference. A verdict
	 * whose `attributes` is false is `ok` by absence of evidence, and the
	 * caller must say so ("UNVERIFIED"), not "compatible".
	 */
	checked: { container: boolean; attributes: boolean };
	standDown: SlateStandDown | null;
	kind: SlateMediaKind;
	/** The container family the probe reported (`mp4`, `matroska`, `png_pipe` …). */
	container: string | null;
	differences: SlateDifference[];
	/**
	 * Which attributes the verdict actually compared (both sides carried
	 * them) and which it could not. An `ok` verdict is a statement about
	 * `compared` ONLY: a heartbeat-derived reference cannot see profile, level
	 * or pixel format, and before rev406 could not see the audio sample rate
	 * either, so "OK" must name its scope or it lies by omission.
	 */
	compared: string[];
	notComparable: string[];
};

export type SlateInputPath = {
	/** What goes on the wire. */
	path: string;
	/** What the caller sent. */
	original: string;
	/** True when the leading slash was removed. */
	stripped: boolean;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function formatTokens(probe: ProbeResult): string[] {
	const name = probe.format?.format_name;
	return typeof name === "string"
		? name
				.split(",")
				.map((token) => token.trim().toLowerCase())
				.filter((token) => token.length > 0)
		: [];
}

/**
 * The container FAMILY a probe reports: `mp4` for anything in the QuickTime
 * demuxer's token list, the image demuxer's own name for an image, otherwise
 * the first token (`matroska` for `matroska,webm`, `mpegts`, …). Null when
 * ffprobe reported no format at all.
 */
export function slateContainer(probe: ProbeResult): string | null {
	const tokens = formatTokens(probe);
	if (tokens.length === 0) {
		return null;
	}
	if (tokens.some((token) => SLATE_CONTAINER_ALLOWLIST.includes(token))) {
		return "mp4";
	}
	const image = tokens.find((token) => SLATE_IMAGE_DEMUXERS.includes(token));
	return image ?? tokens[0] ?? null;
}

/** Movie, single image, or a probe that names no container. */
export function classifySlateMedia(probe: ProbeResult): SlateMediaKind {
	const tokens = formatTokens(probe);
	if (tokens.length === 0) {
		return "unknown";
	}
	return tokens.some((token) => SLATE_IMAGE_DEMUXERS.includes(token))
		? "image"
		: "movie";
}

/** Apply `SLATE_INPUT_PATH_LEADING_SLASH` to a caller-supplied input path. */
export function normalizeSlateInputPath(original: string): SlateInputPath {
	const trimmed = original.trim();
	if (SLATE_INPUT_PATH_LEADING_SLASH === "strip" && trimmed.startsWith("/")) {
		return { path: trimmed.replace(/^\/+/, ""), original, stripped: true };
	}
	return { path: trimmed, original, stripped: false };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Compare a candidate slate (its ffprobe result) against what the encoder is
 * ingesting. Either side may be absent; the verdict then records what could
 * not be checked instead of guessing.
 */
export function compareSlateCompatibility(
	ingest: MediaAttributes | null,
	probe: ProbeResult | null,
): SlateCompatibility {
	const blocking = (attribute: string) =>
		SLATE_BLOCKING_ATTRIBUTES.has(attribute);
	if (probe === null) {
		return {
			ok: true,
			checked: { container: false, attributes: false },
			standDown: "NO_PROBE",
			kind: "unknown",
			container: null,
			differences: [],
			compared: [],
			notComparable: [],
		};
	}
	const kind = classifySlateMedia(probe);
	const container = slateContainer(probe);
	const differences: SlateDifference[] = [];
	const compared: string[] = [];
	let notComparable: string[] = [];

	// A still image where a movie is expected: refused as a KIND, not as an
	// attribute — the table has nothing to compare it against.
	if (kind !== "unknown") {
		compared.push(SLATE_KIND_ATTRIBUTE);
	}
	if (kind === "image" && !SLATE_ALLOW_IMAGES) {
		differences.push({
			attribute: SLATE_KIND_ATTRIBUTE,
			reference: "movie",
			candidate: "image",
			blocking: blocking(SLATE_KIND_ATTRIBUTE),
		});
	}

	// "a video stream at stream position 0" — positional, the one rule in the
	// contract about layout rather than attributes. An audio-first mezzanine
	// is a commonplace layout, so this is a real refusal.
	const first = probe.streams?.[0];
	if (kind !== "image" && first !== undefined) {
		compared.push(SLATE_POSITION_ATTRIBUTE);
	}
	if (kind !== "image" && first !== undefined && first.codec_type !== "video") {
		differences.push({
			attribute: SLATE_POSITION_ATTRIBUTE,
			reference: "video",
			candidate: first.codec_type ?? "an untyped stream",
			blocking: blocking(SLATE_POSITION_ATTRIBUTE),
		});
	}

	// The attribute table needs both sides. An image has no frame rate or
	// audio to hold to the stream's, so the table does not apply to it.
	let attributesChecked = false;
	let nothingComparable = false;
	if (ingest !== null && kind !== "image") {
		const evaluation = evaluateMediaAttributes(
			ingest,
			sourceMediaAttributes(probe),
		);
		// A reference that carries nothing SUBSTANTIVE the table can read on
		// both sides (a heartbeat with no geometry, rate or audio numbers —
		// stream presence alone does not count) compared nothing: that is a
		// stand-down, not an "OK" (rev406 R1). A structural difference (a
		// missing video stream, an audio-count mismatch) still refuses.
		nothingComparable =
			evaluation.differences.length === 0 &&
			!evaluation.compared.some(
				(name) =>
					name !== MEDIA_ATTRIBUTE.videoStream &&
					name !== MEDIA_ATTRIBUTE.audioStreams,
			);
		attributesChecked = !nothingComparable;
		compared.push(...evaluation.compared);
		notComparable = evaluation.notComparable;
		for (const difference of evaluation.differences) {
			differences.push({
				...difference,
				blocking: blocking(difference.attribute),
			});
		}
	}

	// LAST, so the list never leads with the container: a movie outside the
	// admitted families is a difference of its own (blocking since  —
	// an MKV silently never airs). An image is admitted under its own clause;
	// an unknown container is no opinion.
	if (kind === "movie" && container !== null) {
		compared.push(SLATE_CONTAINER_ATTRIBUTE);
	}
	if (
		kind === "movie" &&
		container !== null &&
		!SLATE_CONTAINER_ADMITTED.includes(container)
	) {
		differences.push({
			attribute: SLATE_CONTAINER_ATTRIBUTE,
			reference: SLATE_CONTAINER_ADMITTED.join("/"),
			candidate: container,
			blocking: blocking(SLATE_CONTAINER_ATTRIBUTE),
		});
	}

	return {
		ok: !differences.some((d) => d.blocking),
		checked: { container: true, attributes: attributesChecked },
		standDown:
			ingest === null && kind !== "image"
				? "NO_INGEST_REFERENCE"
				: nothingComparable
					? "NO_COMPARABLE_ATTRIBUTE"
					: null,
		kind,
		container,
		differences,
		compared,
		notComparable,
	};
}

/** The position-0 difference, if the verdict carries one. */
export function slatePositionDifference(
	result: SlateCompatibility,
): SlateDifference | undefined {
	return result.differences.find(
		(d) => d.attribute === SLATE_POSITION_ATTRIBUTE,
	);
}

/** The still-image refusal, if the verdict carries one. */
export function slateImageDifference(
	result: Pick<SlateCompatibility, "differences">,
): SlateDifference | undefined {
	return result.differences.find((d) => d.attribute === SLATE_KIND_ATTRIBUTE);
}
