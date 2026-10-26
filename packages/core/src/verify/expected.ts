/**
 * The expectation compiler: `EncodingPlan` → `ExpectedArtefacts`.
 *
 * This is the half of behavioural verification that needs no credentials, no
 * network and no ffmpeg . It answers one question
 * mechanically — *given this plan, which files must exist in the bucket, and what
 * must be true of each?* — so no scenario ever carries a hand-written expectation
 * file that can rot away from the plan beside it.
 *
 * Why it lives in `packages/core` and stays pure: the same reason the plan compiler
 * does. It is derived from the plan and nothing else, it is golden-pinned per fixture
 * exactly like `.ops.json`, and it must be testable without a worker, a bucket or a
 * Bitmovin account.
 *
 * The line it deliberately does not cross: this file says what to expect, never how
 * to fetch or measure it. Probing, box scanning and manifest parsing live in
 * `apps/worker/src/verify` — keeping ffprobe and the storage drivers out of core.
 *
 * ## Placeholders are preserved, not guessed
 *
 * Per-title output paths carry `{uuid}`/`{bitrate}` (C4) and segment names carry
 * `%number%`. The compiler emits those verbatim inside `PathPattern`, because only
 * the engine — looking at real keys — can know what they expanded to. Pretending to
 * expand them here would produce expectations that are wrong in a way no test could
 * see.
 */

import {
	hlsAudioMediaDefaults,
	hlsChildEntries,
	hlsChildFiles,
} from "../plan/hls-media-defaults";
import { hasMuxedInAudio, muxingStreamKeys } from "../plan/muxing-streams";
import type {
	EncodingPlan,
	PlanManifest,
	PlanMuxing,
	PlanRendition,
} from "../plan/schema";
import { AUDIO_CODECS } from "../plan/schema";
import { enumerateQcTargets } from "../vmaf/targets";

/**
 * A path with the runtime placeholders still in it.
 *
 * `prefix` is everything before the first placeholder — the part the engine can list
 * on. `pattern` is the whole thing, kept so a report can say what was expected.
 */
export type PathPattern = {
	/** Full path as the plan expresses it, placeholders included. */
	pattern: string;
	/** Literal leading portion, safe to use as a storage prefix. */
	prefix: string;
	/** True when the pattern contains `{…}` or `%…%` and cannot be matched literally. */
	templated: boolean;
};

/** Container families, distinguished because they are different artefacts. */
export type ContainerKind =
	| "FMP4_SEGMENTED"
	| "TS_SEGMENTED"
	| "WEBM_SEGMENTED"
	| "TEXT_SINGLE"
	| "TEXT_SEGMENTED"
	| "MP4_PROGRESSIVE"
	| "MP4_FRAGMENTED";

/** What one muxing must have written. */
export type ExpectedMuxing = {
	/** Dedicated provider type; omitted for legacy FMP4 expectations. */
	muxingKind?: "CMAF";
	initSegmentNameTemplate?: string;
	muxingKey: string;
	streamKey: string;
	renditionKey: string;
	container: ContainerKind;
	outputKey: string;
	/** Directory the muxing writes into (`destination.path`). */
	dir: PathPattern;
	/** Init segment, for the segmented families that have one. */
	initSegment?: string;
	/** Segment naming pattern (`%number%` intact) for segmented families. */
	segmentNaming?: string;
	/** Random tokens expand only when the source used segmentNamingTemplate. */
	segmentNamingIsTemplate?: true;
	/** Segment length in seconds — the engine turns this into a count. */
	segmentLengthSec?: number;
	/** Single-file name, for the MP4 families. */
	filename?: string;
	/** ACL the plan asked for, when it said. */
	acl?: "PUBLIC_READ" | "PRIVATE";
	/**
	 * Set when the muxing has no `destination` of its own and writes through a DRM
	 * row's outputs instead. The engine must resolve those before listing.
	 */
	viaDrmKeys?: string[];
	/** Video geometry/codec the artefact must carry; absent for audio/text. */
	video?: {
		height: number | null;
		codec: PlanRendition["codec"];
		profile?: string;
		/** Target bitrate in bps; null for per-title (algorithm decides). */
		bitrate: number | null;
		fps?: number;
	};
	audio?: {
		codec: PlanRendition["codec"];
		bitrate: number;
		sampleRate: number;
		channelLayout?: string;
	};
	text?: { language?: string };
	/** True when the rendition is per-title, so bitrate/height are algorithmic. */
	perTitle: boolean;
	/**
	 * Which per-title mode, because the expected RUNG COUNT differs.
	 *
	 * A `FIXED` muxing pins resolution and bitrate; its guaranteed rung contributes
	 * to the verifier's lower bound. `TEMPLATE` includes fixed-resolution templates,
	 * whose resolution is pinned but resulting rung count is not asserted here. The
	 * engine could previously only assert "at least one rung", so a 7-rung ladder that
	 * collapsed to ONE produced 0 FAILs and 104 PASSes — a real Bitmovin failure mode
	 * reading as fully green. With the mode it can assert a lower bound.
	 */
	perTitleMode?: "TEMPLATE" | "FIXED";
};

/**
 * One EXT-X-STREAM-INF row the compiler emits for an HLS manifest — the
 * `CREATE_HLS_STREAM_INFO` granularity.
 * A fixed video muxing is one row, or one
 * row PER audio group under `variantsPerAudioGroup` (the Dolby fan-out); an
 * `audioVariantStreams` manifest also lists one row per audio muxing, whose
 * URI is the media playlist itself. Per-title video rows are absent: their
 * URIs are resolved at run time from the encoder's ladder.
 *
 * `key` is the check-id suffix, unique within the manifest: the rendition key,
 * with `:<group>` appended for the fan-out rows.
 */
export type ExpectedHlsVariant = {
	key: string;
	renditionKey: string;
	kind: "video" | "audio";
	codec: PlanRendition["codec"];
	/** RESOLUTION height a video row must declare; absent for an audio row. */
	height?: number;
	/** The rendition's target bitrate — the BANDWIDTH band's centre. */
	bitrate: number;
	/**
	 * The AUDIO attribute the row carries — the GROUP-ID it points at. Absent
	 * when the variant is self-contained (muxed-in audio, C33): the compiler
	 * omits the attribute, and a row that carries one names a group that does
	 * not exist.
	 */
	audioGroup?: string;
	/** The media-playlist URI, as the compiler names it (`hlsChildEntries`). */
	uri: string;
};

/**
 * The per-child rendition topology a manifest enumerates, each child bound to
 * the plan's exact declared attributes.
 * Count-and-name checks alone passed a 128k rendition delivered at 64k, a
 * wrong codec, and two children swapped, because nothing tied a child to the
 * rendition it was supposed to be. The engine binds each observed
 * variant/representation to the entry for its rendition and asserts the rest
 * against these values.
 *
 * Two populations, split on purpose: the
 * FIXED renditions, whose height/bitrate are plan values a child can be bound
 * to, and the codec FAMILIES, which every listed video rendition declares —
 * per-title included. Per-title VIDEO is absent from `video` only: the encoder
 * chooses that ladder, so a per-title rung's height/bitrate are algorithmic and
 * not a plan value to bind (C1). It is NOT absent from
 * `declaredVideoCodecFamilies`: the codec is a plan value on every rendition,
 * and dropping it with the geometry left the DASH AdaptationSet check with an
 * EMPTY family set — a real H.264/H.265 per-title MPD then FAILed as "no plan
 * family", the only FAIL in the paid Per-Title outputs. Audio is never
 * per-title, so it is always present. The whole field is absent for Smooth,
 * which the engine checks by QualityLevel count only.
 */
export type ManifestRenditionTopology = {
	/** Fixed-ladder video renditions — geometry/bitrate binding targets only. */
	video: {
		renditionKey: string;
		height: number;
		bitrate: number;
		codec: PlanRendition["codec"];
	}[];
	audio: {
		renditionKey: string;
		/** HLS EXT-X-MEDIA GROUP-ID / NAME the master carries; absent for DASH. */
		groupId?: string;
		name?: string;
		/** HLS: the EXT-X-MEDIA URI, as the compiler derives it (`hlsAudioMediaDefaults`). */
		uri?: string;
		codec: PlanRendition["codec"];
		/** The rendition's bitrate — the band centre for a DASH audio representation. */
		bitrate: number;
	}[];
	/**
	 * Every video codec family this manifest lists — fixed AND per-title
	 * renditions — sorted and de-duplicated. The plan's answer to "which
	 * families may a video AdaptationSet / variant CODECS carry"; never derived
	 * from a manifest.
	 */
	declaredVideoCodecFamilies: PlanRendition["codec"][];
	/**
	 * HLS only: the EXT-X-STREAM-INF rows the master must carry, one expected
	 * node per compiler op. Absent for DASH, whose nodes are `video` + `audio`.
	 */
	hlsVariants?: ExpectedHlsVariant[];
};

/** What one manifest must have written, and what must be inside it. */
export type ExpectedManifest = {
	manifestKey: string;
	kind: "HLS" | "DASH" | "SMOOTH";
	outputKey: string;
	dir: PathPattern;
	/** For HLS/DASH: the single manifest file. For Smooth: the server manifest. */
	files: string[];
	/** Variant/representation count the manifest must enumerate. */
	videoEntries: number;
	audioEntries: number;
	textEntries: number;
	/** HLS only: `EXT-X-VERSION` values the plan pinned, when it pinned them. */
	hlsMasterVersion?: string;
	hlsMediaVersion?: string;
	/**
	 * HLS only: every child playlist the master will reference, named as the
	 * compiler names them. The verifier walks each one, and the
	 * foreign-object filter must not call them foreign — the paid audit's
	 * false FAIL. Per-title variants are absent (resolved
	 * at run time); the walk itself reads the master's own URIs.
	 */
	hlsChildFiles?: string[];
	/** HLS only: the video leg's container, so the walk can require EXT-X-MAP on fMP4. */
	hlsVideoLeg?: "FMP4" | "CMAF" | "TS" | "MP4";
	/** DASH only: per-manifest representation addressing — the C-gotcha fixture. */
	dashRepresentationType?: "TEMPLATE" | "TIMELINE";
	/** DASH only: ON_DEMAND means SegmentBase byte ranges, not segments. */
	dashOnDemand?: boolean;
	/** True when the manifest must be generated AFTER the encoding (C1). */
	postEncoding: boolean;
	/**
	 * True when the LADDER this manifest describes was chosen by the encoder, i.e. the
	 * plan carries a per-title rendition.
	 *
	 * Separate from `postEncoding`, and conflating them was a false-green bug on 15
	 * fixtures. `postEncoding` answers "WHEN is the manifest generated" — it is true for
	 * per-title, for multi-encoding, and for any plan that simply declares
	 * `generation.timing: POST_ENCODING`. `perTitle` answers "WHO chose the ladder", which
	 * is the only reason to relax an entry-count assertion from equality to a range.
	 * Branching the relaxation on `postEncoding` loosened 15 plans that know their exact
	 * rendition count, including the Dolby 3-ladders: one that lost 11 of its 12
	 * renditions reported green (review catch).
	 */
	perTitle: boolean;
	/** DRM the manifest signals, when it does. */
	drmKind?: "CENC" | "FAIRPLAY" | "SPEKE";
	/**
	 * The renditions this manifest enumerates, bound to the plan's exact
	 * attributes. HLS and DASH; absent for
	 * Smooth. The video list omits per-title rungs (encoder-chosen — C1).
	 */
	manifestRenditions?: ManifestRenditionTopology;
};

/**
 * The registered DRM system UUIDs, lower-case and dashless — the form `pssh` carries.
 *
 * Fixed by ISO/IEC 23009-1 / the DASH-IF registry, not by us, so they are constants
 * rather than configuration.
 */
const DRM_SYSTEM_IDS = {
	widevine: "edef8ba979d64acea3c827dcd51d21ed",
	playReady: "9a04f07998404286ab92e65be0885f95",
	fairPlay: "94ce86fb07ff4f43adb893d2fa968ca2",
} as const;

/** Which systems this DRM row configures. */
function systemIdsOf(row: {
	kind: string;
	widevine?: unknown;
	playReady?: unknown;
	fairPlay?: unknown;
}): string[] {
	const ids: string[] = [];
	if (row.widevine !== undefined) {
		ids.push(DRM_SYSTEM_IDS.widevine);
	}
	if (row.playReady !== undefined) {
		ids.push(DRM_SYSTEM_IDS.playReady);
	}
	// A FAIRPLAY row is FairPlay by kind; a CENC row may also carry a fairPlay block.
	if (row.fairPlay !== undefined || row.kind === "FAIRPLAY") {
		ids.push(DRM_SYSTEM_IDS.fairPlay);
	}
	return ids;
}

/** DRM expectations, checked by scanning boxes in an init segment. */
export type ExpectedDrm = {
	drmKey: string;
	kind: "CENC" | "FAIRPLAY" | "SPEKE";
	muxingKeys: string[];
	/** Hex KID (lower-case, no dashes) the `tenc` box must carry. */
	kid?: string;
	/**
	 * The DRM system UUIDs the init segment must carry a `pssh` for, derived from the
	 * plan's `widevine`/`playReady`/`fairPlay` blocks.
	 *
	 * The engine asserted only that SOME pssh existed, so a manifest encrypted for the
	 * wrong system passed: a plan configuring Widevine only, against an init segment
	 * carrying the PlayReady system id, produced zero failures (review catch).
	 */
	systemIds?: string[];
	/** CTR ⇒ 8, CBC ⇒ 16 (C9). */
	ivSizeBytes?: 8 | 16;
	/** `cenc` (CTR) or `cbcs` (CBC) in the `schm` box. */
	schemeType?: "cenc" | "cbcs";
	outputKey?: string;
	dir?: PathPattern;
};

export type ExpectedThumbnails = {
	thumbnailKey: string;
	streamKey: string;
	outputKey: string;
	dir: PathPattern;
	pattern: string;
	height: number;
	/** How many images: one per requested position. */
	count: number;
};

export type ExpectedSprites = {
	spriteKey: string;
	streamKey: string;
	outputKey: string;
	dir: PathPattern;
	/** Sprite image name as the plan gives it (may contain `%number%`); absent ⇒ the API default. */
	spriteName?: string;
	/** The VTT index beside the images. */
	vttName?: string;
	tileWidth?: number;
	tileHeight?: number;
	hTiles?: number;
	vTiles?: number;
	imagesPerFile?: number;
};

/** QC expectations — the shape a VMAF report must have to be believable. */
export type ExpectedQc = {
	vmaf: boolean;
	psnr: boolean;
	model?: string;
	/** One QC mirror per VIDEO rendition; audio has nothing to score. */
	mirrorRenditionKeys: string[];
	/** Mirrors are written under this suffix of each muxing's directory. */
	mirrorDirSuffix: "qc/";
	/**
	 * The mirror files, RESOLVED — because nothing was reading the fields above.
	 *
	 * `expected.qc` existed and the engine never touched it, so the QC mirror MP4 was never
	 * verified for any plan. And a `qc.only` plan was worse than unverified: the compiler emits
	 * NO delivery muxings for it (`compiler.ts`: "VMAF-only encode (qc.only): emit NO delivery
	 * muxings"), while this expectation still demanded them from `plan.muxings`. So
	 * `vmaf-only-h264` FAILed a real run with `init segment init.mp4 — absent` and
	 * `segments matching segment_%number%.m4s — found 0` on an encoding that had FINISHED
	 * correctly and written exactly what it was asked for:
	 *
	 *     output/vmaf-only-h264/video/540p/qc/v540.mp4
	 *
	 * Resolved here rather than reassembled in the engine, so the naming rule lives in ONE
	 * place and matches the compiler's: `filename: ${rendition.key}.mp4` under
	 * `qcOutputPath(destination.path)`.
	 */
	mirrors: {
		renditionKey: string;
		outputKey: string;
		dir: PathPattern;
		filename: string;
	}[];
};

export type ExpectedArtefacts = {
	planName: string;
	/** Output keys the plan writes to, so the engine knows which buckets to open. */
	outputKeys: string[];
	/** Delivery mirror outputs applied to every material muxing output. */
	deliveryMirrorOutputKeys?: string[];
	muxings: ExpectedMuxing[];
	manifests: ExpectedManifest[];
	drm: ExpectedDrm[];
	thumbnails: ExpectedThumbnails[];
	sprites: ExpectedSprites[];
	qc?: ExpectedQc;
	/**
	 * How many source segments the output concatenates, when the plan concatenates at all.
	 *
	 * The engine derives an expected segment COUNT from the reference source's duration, and
	 * that is the wrong duration for a concatenation: the output is the SUM of its parts.
	 * `concatenation-two-sources` FAILed a real run with
	 * `ceil(10.04s / 6s) = 2, so [2, 3] segments — found 4` — and 4 is right, because the run
	 * points both sources at the same 10.04s mezzanine, so the output is 20.08s and
	 * ceil(20.08 / 6) = 4 exactly.
	 *
	 * A COUNT rather than a duration, because the expectation cannot know each part's length —
	 * only the engine has a reference, and only for the one object it probed. Multiplying by
	 * the count is exact when the parts are the same object (which is what the verify rewrite
	 * makes them) and an honest approximation otherwise; the ±1 tolerance already absorbs the
	 * rest, and the notes say so.
	 */
	concatenatedSources?: number;
	/**
	 * The output's duration in seconds when the plan TRIMS, which is not the source's.
	 *
	 * A TIME_BASED trim declares exactly how long the output is. `trimming-time-based` cuts 30
	 * seconds out of its source, and running it against the full 596.46s Big Buck Bunny made the
	 * engine demand `[99, 101]` segments of a correct encode that wrote 5 — the number the trim
	 * asks for. The source duration is the wrong divisor whenever a trim is in play, in exactly
	 * the way it is wrong for a concatenation in the other direction.
	 */
	trimmedToSeconds?: number;
	/**
	 * True when the plan compiles to more than one Bitmovin encoding (Dolby
	 * DV/HDR10/SDR ladders). Artefacts then come from several encodings merged into
	 * shared manifests, which the engine must not treat as one encoding's output.
	 */
	multiEncoding: boolean;
	/** Notes the engine surfaces in its report — never assertions. */
	notes: string[];
};

const PLACEHOLDER = /\{[^}]+\}|%[^%]+%/;

/** Split a plan path into its literal prefix and the templated remainder. */
/** A destination path is a directory; the schema does not force the slash. */
export function withTrailingSlash(raw: string): string {
	return raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
}

export function pathPattern(raw: string): PathPattern {
	const hit = PLACEHOLDER.exec(raw);
	if (!hit) {
		return { pattern: raw, prefix: raw, templated: false };
	}
	return {
		pattern: raw,
		prefix: raw.slice(0, hit.index),
		templated: true,
	};
}

/**
 * The codec sets come from the SCHEMA, not from a copy here.
 *
 * This module first re-declared them, and got the Dolby names wrong: it listed
 * `DOLBY_DIGITAL_PLUS`/`DOLBY_DIGITAL` where the schema literals are `DDPLUS`/`DD`
 * (`schema.ts`). Three muxings across two fixtures then fell through every arm and
 * came out with no `audio` block and no note, so the engine emitted zero assertions
 * for them: a DDP muxing containing silence, AAC, or a video track passed. Found by
 * review. Importing the sets makes that drift impossible rather than merely fixed.
 */
const VIDEO_CODECS = new Set(["H264", "H265", "VP9", "AV1"]);

/**
 * `mode` lives on the VIDEO rendition variants only — the audio and WebVTT members
 * of the union have no such field, so reading it unguarded does not typecheck (and
 * would silently read `undefined` in JS). Per-title is a video-only concept anyway.
 */
function isPerTitle(rendition: PlanRendition | undefined): boolean {
	// `startsWith`, matching `validate.ts` (5 sites, including the C1 rail). The exact
	// string missed `PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE`, which the corpus
	// uses 37 times against 32 for the plain mode — two definitions of one concept in
	// one package, and the wrong one here would have cost a plan its `postEncoding` and
	// its C4 note (review catch).
	return (
		rendition !== undefined &&
		"mode" in rendition &&
		typeof rendition.mode === "string" &&
		rendition.mode.startsWith("PER_TITLE")
	);
}

/**
 * `FIXED` when the rendition pins its own resolution/bitrate (so it yields exactly one
 * per-title rung), `TEMPLATE` when the encoder expands it into an unknown number.
 */
function perTitleModeOf(
	rendition: PlanRendition | undefined,
): "TEMPLATE" | "FIXED" {
	if (
		rendition !== undefined &&
		"mode" in rendition &&
		typeof rendition.mode === "string" &&
		rendition.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
	) {
		return "FIXED";
	}
	return "TEMPLATE";
}

function containerOf(muxing: PlanMuxing): ContainerKind {
	switch (muxing.kind) {
		case "FMP4":
		case "CMAF":
			return "FMP4_SEGMENTED";
		case "TS":
			return "TS_SEGMENTED";
		case "WEBM":
			return "WEBM_SEGMENTED";
		case "TEXT":
			return "TEXT_SINGLE";
		case "CHUNKED_TEXT":
			return "TEXT_SEGMENTED";
		case "MP4":
			// Both absent ⇒ progressive; fragmentDuration + manifestType ⇒ fragmented.
			// These are genuinely different files, which is why the schema refuses
			// to default either field (see mp4MuxingSchema's comment).
			return muxing.fragmentDuration === undefined &&
				muxing.manifestType === undefined
				? "MP4_PROGRESSIVE"
				: "MP4_FRAGMENTED";
		default: {
			// The union is closed today; this makes a NEW muxing kind a compile error
			// here rather than a silently-unverified artefact.
			const unreachable: never = muxing;
			throw new Error(`unhandled muxing kind: ${JSON.stringify(unreachable)}`);
		}
	}
}

/**
 * Which rendition a muxing ultimately carries.
 *
 * A muxing names a `streamKey`; a stream names a rendition. Plans express that link
 * in several ways across the corpus (`renditions[].key` used directly as the stream
 * key in the simple ladders, `streams[]` in the richer ones), so this resolves by
 * key match and falls back to the raw stream key — the engine reports an unresolved
 * link rather than the compiler inventing one.
 */
function renditionFor(
	plan: EncodingPlan,
	streamKey: string,
): PlanRendition | undefined {
	return plan.renditions.find((r) => r.key === streamKey);
}

/** Everything a `{…}`-free plan path resolves to, per output. */
function destinationOf(
	muxing: PlanMuxing,
):
	| { outputKey: string; path: string; acl?: "PUBLIC_READ" | "PRIVATE" }
	| undefined {
	return muxing.destination
		? {
				outputKey: muxing.destination.outputKey,
				path: muxing.destination.path,
				...(muxing.destination.acl ? { acl: muxing.destination.acl } : {}),
			}
		: undefined;
}

export function compileExpectedArtefacts(
	plan: EncodingPlan,
): ExpectedArtefacts {
	const notes: string[] = [];
	const outputKeys = new Set<string>();
	const deliveryMirrorOutputKeys =
		plan.deliveryMirrors?.map(({ outputKey }) => outputKey) ?? [];
	for (const outputKey of deliveryMirrorOutputKeys) {
		outputKeys.add(outputKey);
	}

	// ---- muxings ------------------------------------------------------------
	/**
	 * A `qc.only` plan expects NO delivery artefacts.
	 *
	 * The compiler is explicit: "VMAF-only encode (qc.only): emit NO delivery muxings (and no
	 * DRM on them). The qc-mirror block below still reads plan.muxings for each rendition's
	 * destination — that is why the muxings stay in the plan". This expectation read the same
	 * `plan.muxings` and concluded the opposite, so `vmaf-only-h264` was asked for an
	 * `init.mp4` and segments that were never meant to exist. The mirrors in `qc` are what the
	 * run actually produces, and the engine checks those.
	 */
	const deliveryMuxings = plan.qc?.only ? [] : plan.muxings;
	const muxings: ExpectedMuxing[] = deliveryMuxings.map((muxing) => {
		const rendition = renditionFor(plan, muxing.streamKey);
		const dest = destinationOf(muxing);
		// A muxing with no destination writes through the DRM rows that target it —
		// the engine resolves those, because a DRM row may fan out to several outputs.
		const viaDrm = dest
			? undefined
			: plan.drm.filter((d) => d.muxingKey === muxing.key).map((d) => d.key);
		if (dest) {
			outputKeys.add(dest.outputKey);
		}
		for (const d of plan.drm) {
			if (d.muxingKey === muxing.key && d.destination) {
				outputKeys.add(d.destination.outputKey);
			}
		}

		const perTitle = isPerTitle(rendition);

		const expected: ExpectedMuxing = {
			muxingKey: muxing.key,
			streamKey: muxing.streamKey,
			renditionKey: rendition?.key ?? muxing.streamKey,
			container: containerOf(muxing),
			...(perTitle ? { perTitleMode: perTitleModeOf(rendition) } : {}),
			outputKey: dest?.outputKey ?? "",
			// withTrailingSlash: a slash-less directory made dir.prefix match
			// SIBLING directories too (out/thumbs vs out/thumbsXL) — false PASS
			// on the existence/count assertions, false FAIL on foreign-objects
			// .
			dir: pathPattern(withTrailingSlash(dest?.path ?? "")),
			perTitle,
			...(dest?.acl ? { acl: dest.acl } : {}),
			...(viaDrm && viaDrm.length > 0 ? { viaDrmKeys: viaDrm } : {}),
		};

		if ("segmentNaming" in muxing) {
			const template =
				"segmentNamingTemplate" in muxing
					? muxing.segmentNamingTemplate
					: undefined;
			expected.segmentNaming = template ?? muxing.segmentNaming;
			if (template !== undefined) expected.segmentNamingIsTemplate = true;
			expected.segmentLengthSec = muxing.segmentLength;
		}
		if (muxing.kind === "CMAF") expected.muxingKind = "CMAF";
		if (muxing.kind === "CMAF" && muxing.initSegmentNameTemplate) {
			expected.initSegmentNameTemplate = muxing.initSegmentNameTemplate;
		} else if ("initSegmentName" in muxing) {
			expected.initSegment = muxing.initSegmentName;
		}
		if ("filename" in muxing) {
			expected.filename = muxing.filename;
		}

		/**
		 * EVERY stream the container packages, not just the primary (#192).
		 *
		 * This was an if/else-if over `muxing.streamKey`. That described a
		 * single-stream container completely and a multiplexed one by HALF: a
		 * muxed HLS/TS got `video` and no `audio`, so the engine's
		 * `if (muxing.audio)` never fired and nothing ever ffprobed for the AAC
		 * track inside those segments. The audio that is the whole POINT of
		 * muxing it in was the one fact the harness could not check — and it
		 * said nothing, which is precisely the silent-unverified shape the
		 * codec note-arm below was added to prevent one axis over.
		 *
		 * Each arm ASSIGNS its own field, so a container carrying a picture and
		 * a track fills `video` and `audio` both; a single-stream container
		 * fills exactly the one field it filled before, which is what keeps
		 * every unmuxed golden byte-identical.
		 */
		for (const streamKey of muxingStreamKeys(muxing)) {
			const packaged =
				streamKey === muxing.streamKey
					? rendition
					: renditionFor(plan, streamKey);
			const packagedCodec = packaged?.codec;
			if (packaged === undefined) {
				notes.push(
					`muxing ${muxing.key} references stream "${streamKey}", which is not a rendition key — the engine will report it unresolved rather than assert on it`,
				);
			} else if (
				packagedCodec !== undefined &&
				VIDEO_CODECS.has(packagedCodec)
			) {
				const v = packaged as Extract<PlanRendition, { codec: "H264" }>;
				expected.video = {
					height: v.height ?? null,
					codec: packagedCodec,
					bitrate: v.bitrate ?? null,
					...(v.profile ? { profile: v.profile } : {}),
					...(typeof v.rate === "number" ? { fps: v.rate } : {}),
				};
			} else if (
				packagedCodec !== undefined &&
				AUDIO_CODECS.has(packagedCodec)
			) {
				const a = packaged as Extract<PlanRendition, { codec: "AAC" }>;
				expected.audio = {
					codec: packagedCodec,
					bitrate: a.bitrate,
					sampleRate: a.rate,
					...(a.channelLayout ? { channelLayout: a.channelLayout } : {}),
				};
			} else if (packagedCodec === "WEBVTT" || packagedCodec === "IMSC") {
				expected.text = {};
			} else {
				// The arm that did not exist. A codec in no set produced an expectation with
				// nothing to assert AND no note, so the muxing was silently unverified — the
				// failure shape that let three Dolby muxings through. A note is the minimum;
				// it surfaces in the report instead of vanishing.
				notes.push(
					`muxing ${muxing.key} carries codec "${packagedCodec}", which the expectation compiler has no arm for — nothing about its media is asserted. Add it to the video/audio/text handling in expected.ts.`,
				);
			}
		}
		return expected;
	});

	// ---- manifests ----------------------------------------------------------
	const videoRenditions = plan.renditions.filter((r) =>
		VIDEO_CODECS.has(r.codec),
	);
	const audioRenditions = plan.renditions.filter((r) =>
		AUDIO_CODECS.has(r.codec),
	);
	const textRenditions = plan.renditions.filter((r) => r.codec === "WEBVTT");
	const anyPerTitle = plan.renditions.some((r) => isPerTitle(r));
	const multiEncoding =
		"encodings" in plan &&
		Array.isArray((plan as { encodings?: unknown[] }).encodings) &&
		((plan as { encodings?: unknown[] }).encodings?.length ?? 0) > 1;

	const manifests: ExpectedManifest[] = plan.manifests.map(
		(manifest: PlanManifest) => {
			outputKeys.add(manifest.destination.outputKey);
			// The path is a DIRECTORY (Bitmovin joins `manifestName` onto it), and
			// the schema does not force a trailing slash — `expected-live.ts`
			// normalises for the same reason. Every VOD fixture happens to end in
			// `/`, so this is a no-op for the corpus and a trap removed for the
			// first plan that does not.
			const dir = pathPattern(withTrailingSlash(manifest.destination.path));
			// The plan SAYS which, so read it rather than re-deriving it. The first
			// version computed `anyPerTitle || multiEncoding` and ignored the required
			// `generation.timing` — so `dash-hls-sftp-output-post-encoding` came out
			// indistinguishable from `…-just-in-time`, the two fixtures that exist
			// precisely to separate them, and 8 fixtures were wrong (review catch).
			//
			// The derivation is kept as a CONSTRAINT, not as the answer: per-title and
			// multi-encoding manifests cannot be JIT, because their entries name
			// PER_TITLE_RESULT streams that do not exist before the run (C1). If a plan
			// ever claims JIT with per-title, the expectation says post-encoding and
			// notes the contradiction rather than quietly believing either side.
			const declared = plan.generation.timing === "POST_ENCODING";
			const forced = anyPerTitle || multiEncoding;
			// (a manifest-level `perTitleLadder` twin lived here until the per-
			// manifest `perTitleLadderHere` below superseded it;  sweep)
			const postEncoding = declared || forced;
			if (forced && !declared) {
				notes.push(
					`manifest ${manifest.key}: the plan declares generation.timing JUST_IN_TIME but ${anyPerTitle ? "per-title" : "multi-encoding"} manifests can only be generated post-encoding (C1) — treated as POST_ENCODING`,
				);
			}

			/**
			 * How many entries this manifest enumerates for one media family.
			 *
			 * A manifest that pins a muxing kind enumerates only that leg — the
			 * per-title samples deliberately produce FMP4-for-DASH and TS-for-HLS.
			 *
			 * The unpinned case used to fall back to `keys.size`, the count of
			 * RENDITIONS, and that stopped being the same number twice over
			 * (#192): a manifest emits one entry per MUXING, so a rendition with
			 * two legs was undercounted, and a track muxed into the video owns no
			 * muxing at all, so it was over-counted — the muxed HLS fixture
			 * claimed `audioEntries: 1` against zero emitted audio media ops.
			 * Counting muxings answers both, because "which containers does this
			 * manifest list" is the question the entry count actually asks.
			 */
			const listedMuxings = (kind: string | undefined, keys: Set<string>) =>
				muxings.filter(
					(m) =>
						keys.has(m.renditionKey) &&
						(manifest.kind !== "HLS" || m.muxingKind !== "CMAF") &&
						(kind === undefined ||
							(m.muxingKind ?? m.container).startsWith(kind)),
				);
			const legFilter = (kind: string | undefined, keys: Set<string>) =>
				listedMuxings(kind, keys).length;
			const videoKeys = new Set(videoRenditions.map((r) => r.key));
			const audioKeys = new Set(audioRenditions.map((r) => r.key));
			/**
			 * The manifest's per-child topology,
			 * built from the SAME muxings the entry counts come from so the two can
			 * never describe different ladders. Per-title video is dropped from the
			 * GEOMETRY list only (the encoder chooses that ladder — C1) and kept in
			 * the codec-family set; audio is never
			 * per-title. Kept ONE entry per rendition so the engine's per-rendition
			 * check ids stay unique even when a manifest lists two legs of one
			 * rendition.
			 */
			const topologyFor = (
				videoMuxes: ExpectedMuxing[],
				audioMuxes: ExpectedMuxing[],
				hlsAudio:
					| {
							group: Map<string, string>;
							name: Map<string, string>;
							uri: Map<string, string>;
					  }
					| undefined,
			): ManifestRenditionTopology => {
				const seenVideo = new Set<string>();
				const video = videoMuxes.flatMap((m) => {
					if (
						!m.video ||
						m.perTitle ||
						m.video.height === null ||
						m.video.bitrate === null ||
						seenVideo.has(m.renditionKey)
					) {
						return [];
					}
					seenVideo.add(m.renditionKey);
					return [
						{
							renditionKey: m.renditionKey,
							height: m.video.height,
							bitrate: m.video.bitrate,
							codec: m.video.codec,
						},
					];
				});
				// EVERY listed video muxing contributes its family — the per-title
				// legs the geometry list above skips included. A plan value, read
				// off the plan; the manifest is never consulted for it.
				const declaredVideoCodecFamilies = [
					...new Set(
						videoMuxes.flatMap((m) => (m.video ? [m.video.codec] : [])),
					),
				].sort();
				const seenAudio = new Set<string>();
				const audio = audioMuxes.flatMap((m) => {
					if (!m.audio || seenAudio.has(m.renditionKey)) {
						return [];
					}
					seenAudio.add(m.renditionKey);
					const name = hlsAudio?.name.get(m.renditionKey);
					const uri = hlsAudio?.uri.get(m.renditionKey);
					// The GROUP-ID is PER RENDITION, not the manifest default: the
					// compiler emits each EXT-X-MEDIA with `rendition.hlsMedia.groupId`
					// when set (compiler.ts) — `variantsPerAudioGroup` (Dolby) fans a
					// ladder across "atmos"/"aac" groups, so a flat stamp FAILs a
					// correct master.
					const groupId = hlsAudio?.group.get(m.renditionKey);
					return [
						{
							renditionKey: m.renditionKey,
							codec: m.audio.codec,
							...(groupId !== undefined ? { groupId } : {}),
							...(name !== undefined ? { name } : {}),
							...(uri !== undefined ? { uri } : {}),
							bitrate: m.audio.bitrate,
						},
					];
				});
				return { video, audio, declaredVideoCodecFamilies };
			};
			/**
			 * The EXT-X-STREAM-INF rows an HLS master must carry, one expected node
			 * per compiler op: read off
			 * `hlsChildEntries`, the enumeration the validator and the foreign-object
			 * filter already trust, so the fan-out rule has ONE home. A fixed video
			 * muxing yields one row, or one per audio group under
			 * `variantsPerAudioGroup`; an `audioVariantStreams` manifest lists one
			 * row per audio muxing too. The AUDIO attribute follows C33: a
			 * self-contained (muxed-in) variant carries none.
			 */
			const hlsVariantsFor = (
				hlsManifest: Extract<PlanManifest, { kind: "HLS" }>,
				videoMuxes: ExpectedMuxing[],
				audioMuxes: ExpectedMuxing[],
				mediaUri: Map<string, string>,
			): ExpectedHlsVariant[] => {
				const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
				const out: ExpectedHlsVariant[] = [];
				const seen = new Set<string>();
				for (const entry of hlsChildEntries(plan, hlsManifest)) {
					if (entry.kind === "video") {
						const m = videoMuxes.find((x) => x.muxingKey === entry.muxingKey);
						const planMuxing = plan.muxings.find(
							(x) => x.key === entry.muxingKey,
						);
						if (
							!m?.video ||
							m.perTitle ||
							m.video.height === null ||
							m.video.bitrate === null ||
							planMuxing === undefined
						) {
							continue;
						}
						const key =
							entry.group === undefined
								? entry.renditionKey
								: `${entry.renditionKey}:${entry.group}`;
						if (seen.has(key)) {
							continue; // a second leg of one rendition — the validator refuses it
						}
						seen.add(key);
						const audioGroup =
							entry.group ??
							(hasMuxedInAudio(planMuxing, renditionByKey)
								? undefined
								: hlsManifest.audioGroupId);
						out.push({
							key,
							renditionKey: entry.renditionKey,
							kind: "video",
							codec: m.video.codec,
							height: m.video.height,
							bitrate: m.video.bitrate,
							...(audioGroup !== undefined ? { audioGroup } : {}),
							uri: entry.uri,
						});
					} else if (
						entry.kind === "audio" &&
						hlsManifest.audioVariantStreams
					) {
						const m = audioMuxes.find((x) => x.muxingKey === entry.muxingKey);
						const rendition = renditionByKey.get(entry.renditionKey);
						const uri = mediaUri.get(entry.renditionKey);
						if (
							!m?.audio ||
							uri === undefined ||
							seen.has(entry.renditionKey)
						) {
							continue;
						}
						seen.add(entry.renditionKey);
						out.push({
							key: entry.renditionKey,
							renditionKey: entry.renditionKey,
							kind: "audio",
							codec: m.audio.codec,
							bitrate: m.audio.bitrate,
							// The same derivation as the compiler's audio-variant op.
							audioGroup:
								rendition?.hlsMedia?.groupId ?? hlsManifest.audioGroupId,
							uri,
						});
					}
				}
				return out;
			};
			/**
			 * Does THIS manifest's video ladder come from per-title?
			 *
			 * Per manifest, not per plan. `anyPerTitle` was the first version and it is
			 * R3-C1 in miniature: a plan with one per-title muxing and one fixed-ladder
			 * manifest would get the relaxed entry-count bound on a manifest that knows its
			 * exact count. No fixture has that shape, so it was latent — but the whole
			 * defect being fixed here was a plan-wide flag standing in for a per-manifest
			 * fact, and repeating it one level down would be the same mistake.
			 *
			 * A manifest that pins a muxing kind enumerates only that leg, so the question
			 * is asked of the muxings this manifest actually lists.
			 */
			const videoLeg =
				"videoMuxingKind" in manifest
					? (manifest.videoMuxingKind as string | undefined)
					: undefined;
			const perTitleLadderHere = muxings.some(
				(m) =>
					m.perTitle &&
					videoKeys.has(m.renditionKey) &&
					(videoLeg === undefined || m.container.startsWith(videoLeg)),
			);

			if (manifest.kind === "HLS") {
				const hlsVideoMuxes = listedMuxings(
					manifest.videoMuxingKind,
					videoKeys,
				);
				const hlsAudioMuxes = listedMuxings(
					manifest.audioMuxingKind,
					audioKeys,
				);
				const mediaDefaults = hlsAudioMediaDefaults(plan, manifest);
				const mediaUri = new Map(
					[...mediaDefaults].map(([key, v]) => [key, v.uri] as const),
				);
				return {
					manifestKey: manifest.key,
					kind: "HLS",
					outputKey: manifest.destination.outputKey,
					dir,
					files: [manifest.manifestName],
					videoEntries: legFilter(manifest.videoMuxingKind, videoKeys),
					audioEntries: legFilter(manifest.audioMuxingKind, audioKeys),
					textEntries: textRenditions.length,
					postEncoding,
					perTitle: perTitleLadderHere,
					manifestRenditions: {
						...topologyFor(hlsVideoMuxes, hlsAudioMuxes, {
							// Same rule as the compiler and validator
							// (`rendition.hlsMedia?.groupId ?? manifest.audioGroupId`):
							// an explicit hlsMedia group wins, so a Dolby
							// variantsPerAudioGroup ladder binds atmos/aac, not "audio".
							group: new Map(
								audioRenditions.map(
									(r) =>
										[
											r.key,
											r.hlsMedia?.groupId ?? manifest.audioGroupId,
										] as const,
								),
							),
							name: new Map(
								[...mediaDefaults].map(([key, v]) => [key, v.name] as const),
							),
							uri: mediaUri,
						}),
						hlsVariants: hlsVariantsFor(
							manifest,
							hlsVideoMuxes,
							hlsAudioMuxes,
							mediaUri,
						),
					},
					...(manifest.masterVersion
						? { hlsMasterVersion: manifest.masterVersion }
						: {}),
					...(manifest.mediaVersion
						? { hlsMediaVersion: manifest.mediaVersion }
						: {}),
					hlsChildFiles: hlsChildFiles(plan, manifest),
					// DERIVED from the containers this manifest enumerates when the
					// plan does not pin a leg: `?? "FMP4"` called the muxed-TS
					// fixture fMP4 and would have demanded an EXT-X-MAP it must not
					// have. Mixed or absent → undefined, and the walk skips the check.
					...(() => {
						const legs = new Set(
							muxings
								.filter(
									(m) =>
										videoKeys.has(m.renditionKey) &&
										(videoLeg === undefined ||
											m.container.startsWith(videoLeg)),
								)
								.map((m) => m.container.split("_")[0]),
						);
						const leg = legs.size === 1 ? [...legs][0] : undefined;
						return leg === "FMP4" ||
							leg === "CMAF" ||
							leg === "TS" ||
							leg === "MP4"
							? { hlsVideoLeg: leg }
							: {};
					})(),
				};
			}
			if (manifest.kind === "DASH") {
				return {
					manifestKey: manifest.key,
					kind: "DASH",
					outputKey: manifest.destination.outputKey,
					dir,
					files: [manifest.manifestName],
					videoEntries: legFilter(
						manifest.videoMuxingKind ??
							(manifest.profile === "ON_DEMAND" ? "MP4" : "FMP4"),
						videoKeys,
					),
					audioEntries: legFilter(
						manifest.audioMuxingKind ??
							(manifest.profile === "ON_DEMAND" ? "MP4" : "FMP4"),
						audioKeys,
					),
					textEntries: plan.muxings.filter(
						(m) =>
							(m.kind === "CHUNKED_TEXT" &&
								plan.renditions.find((r) => r.key === m.streamKey)?.codec ===
									"WEBVTT") ||
							(m.kind === "TEXT" &&
								plan.renditions.find((r) => r.key === m.streamKey)?.codec ===
									"IMSC"),
					).length,
					dashRepresentationType: manifest.representationType,
					dashOnDemand: manifest.profile === "ON_DEMAND",
					postEncoding,
					perTitle: perTitleLadderHere,
					manifestRenditions: topologyFor(
						listedMuxings(
							manifest.videoMuxingKind ??
								(manifest.profile === "ON_DEMAND" ? "MP4" : "FMP4"),
							videoKeys,
						),
						listedMuxings(
							manifest.audioMuxingKind ??
								(manifest.profile === "ON_DEMAND" ? "MP4" : "FMP4"),
							audioKeys,
						),
						undefined,
					),
					...(manifest.drmKind ? { drmKind: manifest.drmKind } : {}),
				};
			}
			return {
				manifestKey: manifest.key,
				kind: "SMOOTH",
				outputKey: manifest.destination.outputKey,
				dir,
				files: [manifest.serverManifestName, manifest.clientManifestName],
				videoEntries: videoRenditions.length,
				audioEntries: audioRenditions.length,
				textEntries: 0,
				postEncoding,
				perTitle: perTitleLadderHere,
				...(manifest.drmKind ? { drmKind: manifest.drmKind } : {}),
			};
		},
	);

	// ---- DRM ----------------------------------------------------------------
	const drm: ExpectedDrm[] = plan.drm.map((row) => {
		if (row.destination) outputKeys.add(row.destination.outputKey);
		if (row.kind === "SPEKE")
			return {
				drmKey: row.key,
				kind: "SPEKE" as const,
				muxingKeys: [row.muxingKey],
				...(row.kid ? { kid: row.kid.toLowerCase() } : {}),
				systemIds: row.systemIds.map((id) =>
					id.replace(/-/g, "").toLowerCase(),
				),
				outputKey: row.destination.outputKey,
				dir: pathPattern(withTrailingSlash(row.destination.path)),
			};
		// C9: CTR pairs with an 8-byte IV, CBC with 16. The plan states the mode;
		// the compiler derives the size rather than trusting a second field.
		// C9: CTR ⇒ 8-byte IV, CBC ⇒ 16. `ivSize` is optional in the plan, and
		// `encryptionMode` is the field that actually decides, so derive from the mode
		// and let an explicit ivSize override it. FairPlay is CBC, hence 16.
		const ivSizeBytes: 8 | 16 =
			row.kind !== "CENC"
				? 16
				: row.ivSize === "IV_16_BYTES"
					? 16
					: row.ivSize === "IV_8_BYTES"
						? 8
						: row.encryptionMode === "CBC"
							? 16
							: 8;
		return {
			drmKey: row.key,
			kind: row.kind,
			muxingKeys: [row.muxingKey],
			ivSizeBytes,
			// From the MODE, not from the IV size. Reading the size made the two fields
			// restate each other, so the property test that claimed to check the C9
			// pairing was a tautology: a review measured that swapping this derivation
			// failed 0 of the 66 goldens, and that flipping the CTR default (`: 8` → 16,
			// a direct C9 violation) also failed 0 — because every CENC fixture happens
			// to carry an explicit `ivSize`. cbcs is the CBC scheme; cenc is CTR.
			schemeType:
				row.kind === "CENC" && row.encryptionMode !== "CBC"
					? ("cenc" as const)
					: ("cbcs" as const),
			...(row.kind === "CENC" && row.kid
				? { kid: row.kid.replace(/-/g, "").toLowerCase() }
				: {}),
			...(systemIdsOf(row).length > 0 ? { systemIds: systemIdsOf(row) } : {}),
			...(row.destination
				? {
						outputKey: row.destination.outputKey,
						dir: pathPattern(withTrailingSlash(row.destination.path)),
					}
				: {}),
		};
	});

	// ---- thumbnails / sprites ----------------------------------------------
	const thumbnails: ExpectedThumbnails[] = plan.thumbnails.map((t) => {
		outputKeys.add(t.destination.outputKey);
		return {
			thumbnailKey: t.key,
			streamKey: t.streamKey,
			outputKey: t.destination.outputKey,
			dir: pathPattern(withTrailingSlash(t.destination.path)),
			pattern: t.pattern,
			height: t.height,
			count: t.positions.length,
		};
	});

	const sprites: ExpectedSprites[] = plan.sprites.map((s) => {
		outputKeys.add(s.destination.outputKey);
		return {
			spriteKey: s.key,
			streamKey: s.streamKey,
			outputKey: s.destination.outputKey,
			dir: pathPattern(withTrailingSlash(s.destination.path)),
			...(s.spriteName ? { spriteName: s.spriteName } : {}),
			...(s.vttName ? { vttName: s.vttName } : {}),
			...(s.width !== undefined ? { tileWidth: s.width } : {}),
			...(s.height !== undefined ? { tileHeight: s.height } : {}),
			...(s.hTiles !== undefined ? { hTiles: s.hTiles } : {}),
			...(s.vTiles !== undefined ? { vTiles: s.vTiles } : {}),
			...(s.imagesPerFile !== undefined
				? { imagesPerFile: s.imagesPerFile }
				: {}),
		};
	});

	// ---- QC ------------------------------------------------------------------
	const qcPlan = plan.qc;
	/**
	 * Where each QC mirror lands, by the compiler's own rule.
	 *
	 * `compiler.ts` writes `filename: ${rendition.key}.mp4` to `qcOutputPath(base.path)`, where
	 * `base` is the rendition's muxing destination or, when the muxing has none, the DRM row's.
	 * Reproduced here so the engine can check a file rather than a field nobody read.
	 */
	/**
	 * The mirrors, DERIVED from the runner's own target enumeration (review-325
	 * I4): `enumerateQcTargets` is what the VMAF worker measures from, and it
	 * skips a rendition whose mirror base OR reference source cannot resolve —
	 * this expectation used to check only the mirror base, so a Dolby-Vision-
	 * sourced rendition would have been demanded as a scored result the worker
	 * structurally never produces. One population, one derivation (it also
	 * retires this file's third copy of the mirror-base rule).
	 */
	const qcMirrors = enumerateQcTargets(plan).map((target) => {
		const slash = target.distorted.path.lastIndexOf("/");
		return {
			renditionKey: target.renditionKey,
			outputKey: target.distorted.outputKey,
			dir: pathPattern(target.distorted.path.slice(0, slash + 1)),
			filename: target.distorted.path.slice(slash + 1),
		};
	});
	/**
	 * The mirrors' buckets count as outputs the engine must open.
	 *
	 * For a `qc.only` plan they are the ONLY ones: `deliveryMuxings` is empty, so nothing else
	 * adds an output key, and an empty `outputKeys` would leave the engine with no bucket to
	 * list — verifying nothing and saying so in no way a reader would notice.
	 */
	for (const mirror of qcMirrors) {
		outputKeys.add(mirror.outputKey);
	}
	const qc: ExpectedQc | undefined =
		qcPlan && (qcPlan.vmaf || qcPlan.psnr)
			? {
					vmaf: qcPlan.vmaf === true,
					psnr: qcPlan.psnr === true,
					...(qcPlan.model ? { model: qcPlan.model } : {}),
					mirrorRenditionKeys: videoRenditions.map((r) => r.key),
					mirrorDirSuffix: "qc/",
					mirrors: qcMirrors,
				}
			: undefined;

	if (anyPerTitle) {
		notes.push(
			"per-title plan: heights and bitrates are algorithmic, so rung geometry is asserted as ordered-and-present rather than against plan values (C1/C4)",
		);
	}
	if (multiEncoding) {
		notes.push(
			"multi-encoding plan: artefacts come from several encodings merged into shared manifests",
		);
	}

	/**
	 * The largest concatenation in the plan, in source count.
	 *
	 * Largest rather than a per-muxing value: every muxing of a concatenated encoding carries
	 * the joined stream, so one number describes the whole output. If a plan ever mixes joined
	 * and unjoined streams this becomes too generous for the unjoined ones — recorded rather
	 * than guessed at, since no fixture does that today.
	 */
	/**
	 * The shortest TIME_BASED trim, which bounds the output.
	 *
	 * Shortest rather than longest: every muxing of a trimmed encoding carries the trimmed
	 * stream, so the tightest trim describes the output. A plan mixing trimmed and untrimmed
	 * streams would make this too small for the untrimmed ones — recorded rather than guessed at,
	 * since no fixture does that.
	 */
	const trimmedToSeconds = (plan.trimmingStreams ?? []).reduce<
		number | undefined
	>((least, trim) => {
		// Narrowed by `kind`, because only a TIME_BASED trim carries `duration` — a
		// TIMECODE_TRACK one declares start/end timecodes, which need the source's timecode
		// track to resolve and are therefore not derivable here.
		if (trim.kind !== "TIME_BASED" || typeof trim.duration !== "number") {
			return least;
		}
		return least === undefined ? trim.duration : Math.min(least, trim.duration);
	}, undefined);
	if (trimmedToSeconds !== undefined) {
		notes.push(
			`trimming plan: the output is ${trimmedToSeconds}s, so a segment count derived from the SOURCE's duration would be wrong by however much longer the source is`,
		);
	}

	const concatenatedSources = (plan.concatenationStreams ?? []).reduce(
		(most, stream) => Math.max(most, stream.sources.length),
		0,
	);
	if (concatenatedSources > 1) {
		notes.push(
			`concatenation plan: the output is ${concatenatedSources} sources joined, so a segment count derived from ONE source's duration would be short by a factor of ${concatenatedSources}`,
		);
	}

	return {
		planName: plan.name,
		outputKeys: [...outputKeys].sort(),
		...(deliveryMirrorOutputKeys.length > 0
			? { deliveryMirrorOutputKeys }
			: {}),
		muxings,
		manifests,
		drm,
		thumbnails,
		sprites,
		...(qc ? { qc } : {}),
		...(concatenatedSources > 1 ? { concatenatedSources } : {}),
		...(trimmedToSeconds !== undefined ? { trimmedToSeconds } : {}),
		multiEncoding,
		notes,
	};
}
