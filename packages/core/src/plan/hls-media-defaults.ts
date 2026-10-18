import { type HlsLegKind, hlsLegSelected } from "./hls-legs";
import type { EncodingPlan, PlanRendition } from "./schema";

/** Only packaged WebVTT resources produce EXT-X-MEDIA subtitle groups. */
export function hlsSubtitleGroups(plan: EncodingPlan): string[] {
	const packaged = new Set(
		plan.muxings
			.filter((m) => m.kind === "CHUNKED_TEXT")
			.map((m) => m.streamKey),
	);
	return [
		...new Set(
			plan.renditions.flatMap((r) =>
				r.codec === "WEBVTT" && packaged.has(r.key) ? [r.groupId] : [],
			),
		),
	];
}

/**
 * The NAME and URI an HLS audio EXT-X-MEDIA entry gets when the plan does not
 * spell them .
 *
 * ONE derivation, TWO callers — the compiler emits from it and the validator
 * checks against it — because the defect was a default that was correct for
 * the one-audio plan it was transcribed from and wrong for every other: the
 * vendor's fixed-bitrate sample names its single audio rendition
 * `"HLS Audio Media"`, and the compiler applied that literal to EVERY audio
 * rendition in the group. RFC 8216 §4.3.4.1.1 requires NAME to be unique
 * within a GROUP-ID; two paid AWS runs (VOD case 1, Live cases A/B/E) and the
 * Akamai MSL4 Production run all reproduced the duplicate. The verifier could
 * not see it — `m3u8-parser` stores media entries keyed BY NAME, so the second
 * entry silently overwrote the first in the parsed structure.
 *
 * The URI default had the same shape one step worse: `audio_${bitrate}.m3u8`
 * collides for two audio renditions at the same bitrate (128k stereo and 128k
 * 5.1, say), and a collision there is two media entries pointing at ONE
 * playlist the encoder writes twice.
 *
 * Rule: a rendition that spells `hlsMedia` keeps its own values verbatim. A
 * plan whose group holds ONE defaulted audio rendition keeps the vendor's
 * literal name and bitrate URI byte-for-byte — every single-audio golden is
 * unchanged. Only when the group holds MORE than one defaulted rendition does
 * the name gain a `(<key>)` suffix, and the URI switches to the rendition key
 * only when two defaulted renditions share a bitrate — the key is the one
 * value the schema already guarantees unique.
 */
export type HlsAudioMediaDefaults = {
	name: string;
	uri: string;
	/** True when the plan spelled `hlsMedia` and the values above are its own. */
	explicit: boolean;
};

const VENDOR_NAME = "HLS Audio Media";

export function isHlsAudioRendition(
	rendition: PlanRendition,
): rendition is PlanRendition & { bitrate: number } {
	// HE-AAC is a PROFILE on the AAC codec config, not a codec of its own —
	// the union has four audio members, and this list is them.
	return (
		rendition.codec === "AAC" ||
		rendition.codec === "DD" ||
		rendition.codec === "DDPLUS" ||
		rendition.codec === "DOLBY_ATMOS"
	);
}

/**
 * The muxing legs THIS manifest lists for each AUDIO rendition, in plan-muxing
 * order, keyed by rendition key. A rendition with no selected leg is absent.
 *
 * ONE derivation, THREE readers — the defaults below, the compiler's
 * EXT-X-MEDIA emission, and the validator's multi-leg rail — because those
 * three each answered a DIFFERENT question about the same plan and the
 * difference was invisible until a rendition had two legs: the defaults map
 * asked "does ANY muxing reach this rendition" (once per rendition), the
 * compiler emitted one media row PER MUXING, and the validator checked the
 * derived NAME/URI once per rendition. So one audio rendition packaged into
 * two legs of one manifest — an fMP4 leg beside a TS leg, neither pinned —
 * produced TWO EXT-X-MEDIA entries carrying the SAME NAME and the SAME URI:
 * the RFC 8216 §4.3.4.1.1 violation  removed from ACROSS renditions,
 * reappearing ACROSS the legs of one (2026-08-29 paid re-audit HIGH-5), with
 * the URI half's consequence intact — the encoder writes one playlist twice.
 *
 * The model, stated here so all three read it: a manifest lists ONE entry per
 * audio rendition, and the leg it lists is the FIRST it selects. Which leg that
 * should be is the AUTHOR's call, spelled with `audioMuxingKind` — a plan that
 * offers a manifest two legs for one rendition is refused by
 * `PLAN_HLS_RENDITION_MULTI_LEG` rather than silently resolved here. The live
 * compiler's twin of this shape is already an error (`LIVE_HLS_URI_COLLISION`,
 * "TS+FMP4 legs per rendition with no pin selects BOTH"); VOD had no such rail.
 */
export function hlsAudioLegsByRendition(
	plan: EncodingPlan,
	manifest: { audioMuxingKind?: HlsLegKind },
): Map<string, string[]> {
	const audioKeys = new Set(
		plan.renditions.filter(isHlsAudioRendition).map((r) => r.key),
	);
	const out = new Map<string, string[]>();
	for (const muxing of plan.muxings) {
		if (
			!audioKeys.has(muxing.streamKey) ||
			!hlsLegSelected(muxing.kind, manifest.audioMuxingKind)
		) {
			continue;
		}
		out.set(muxing.streamKey, [
			...(out.get(muxing.streamKey) ?? []),
			muxing.key,
		]);
	}
	return out;
}

/**
 * Defaults for every audio rendition THIS manifest lists, as they would appear
 * in its master, keyed by rendition key. `audioMediaUri` is the manifest's
 * literal override (two vendor samples set "audio.m3u8"); it is applied when
 * the group holds one defaulted rendition and ignored — reported by the
 * validator — when it would put two renditions on one playlist.
 *
 * The population is the manifest's, not the plan's (review-323 I1): the first
 * cut counted every audio rendition in the plan, so a second HLS manifest with
 * its own TS-muxed audio pushed the first manifest's sole fMP4 audio into the
 * "(key)" suffix — a gratuitous rename in a group with nothing to disambiguate.
 * A manifest emits one entry per muxing it lists, and one that pins
 * `audioMuxingKind` lists only that leg; the filter below is the compiler's own.
 */
export function hlsAudioMediaDefaults(
	plan: EncodingPlan,
	manifest: {
		audioGroupId: string;
		audioMediaUri?: string;
		audioMuxingKind?: HlsLegKind;
	},
): Map<string, HlsAudioMediaDefaults> {
	const out = new Map<string, HlsAudioMediaDefaults>();
	const legs = hlsAudioLegsByRendition(plan, manifest);
	const audios = plan.renditions
		.filter(isHlsAudioRendition)
		.filter((r) => legs.has(r.key));
	// Defaulted renditions in the manifest's group — the population whose
	// names and URIs this module invents.
	const defaulted = audios.filter((r) => !r.hlsMedia);
	const shared = defaulted.length > 1;
	const bitrateCounts = new Map<number, number>();
	for (const r of defaulted) {
		bitrateCounts.set(r.bitrate, (bitrateCounts.get(r.bitrate) ?? 0) + 1);
	}
	for (const r of audios) {
		if (r.hlsMedia) {
			out.set(r.key, {
				name: r.hlsMedia.name,
				uri: r.hlsMedia.uri,
				explicit: true,
			});
			continue;
		}
		const bitrateShared = (bitrateCounts.get(r.bitrate) ?? 0) > 1;
		out.set(r.key, {
			name: shared ? `${VENDOR_NAME} (${r.key})` : VENDOR_NAME,
			uri:
				manifest.audioMediaUri !== undefined && !shared
					? manifest.audioMediaUri
					: bitrateShared
						? `audio_${r.key}.m3u8`
						: `audio_${r.bitrate}.m3u8`,
			explicit: false,
		});
	}
	return out;
}

/**
 * The media-playlist URI of a VIDEO variant — the compiler's two forms, in one
 * place so the expectation compiler can name the same files .
 *
 * `group` is set only for the Dolby `variantsPerAudioGroup` layout, where one
 * video muxing fans out to one variant per audio group.
 */
export function hlsVariantUri(
	rendition: {
		bitrate: number | null;
		height?: number | null;
		hlsVariantLabel?: string;
	},
	group?: string,
): string {
	if (group !== undefined) {
		const label = rendition.hlsVariantLabel ?? "video";
		return `video_${label}_${rendition.height}p_${rendition.bitrate}_${group}.m3u8`;
	}
	return `video_${rendition.bitrate}.m3u8`;
}

/** One child playlist the master will reference, and the leg that writes it. */
export type HlsChildEntry = {
	uri: string;
	/** The muxing whose segments the playlist lists. */
	muxingKey: string;
	/** The rendition that muxing packages. */
	renditionKey: string;
	/**
	 * Which master row references this child: a video EXT-X-STREAM-INF, an
	 * audio EXT-X-MEDIA, or a subtitle EXT-X-MEDIA. Carried so the verifier's
	 * expected-node model (row 284) is read off THIS enumeration rather than a
	 * third copy of the fan-out rule.
	 */
	kind: "video" | "audio" | "text";
	/**
	 * The audio GROUP-ID a `variantsPerAudioGroup` video row names — one entry
	 * per (video muxing × group), which is the compiler's `CREATE_HLS_STREAM_INFO`
	 * granularity. Absent on every other row.
	 */
	group?: string;
};

/**
 * Every child playlist an HLS manifest's master will reference, as the
 * compiler will name them — video variants, audio media, subtitle media and
 * the Dolby per-group fan-out — each paired with the muxing leg that writes
 * it. Per-title variants are excluded: their URIs are resolved at run time
 * from the encoder's chosen ladder.
 *
 * `hlsChildFiles` is this list de-duplicated; the PAIRS are what the
 * validator's `PLAN_HLS_RENDITION_MULTI_LEG` rail needs, because the defect it
 * catches is invisible in the de-duplicated form — two legs of one rendition
 * collapse into the one URI they collide on (2026-08-29 paid re-audit HIGH-5).
 */
export function hlsChildEntries(
	plan: EncodingPlan,
	manifest: {
		key: string;
		audioGroupId: string;
		audioMediaUri?: string;
		variantsPerAudioGroup?: boolean;
		audioVariantStreams?: boolean;
		videoMuxingKind?: HlsLegKind;
		audioMuxingKind?: HlsLegKind;
	},
): HlsChildEntry[] {
	const out: HlsChildEntry[] = [];
	const defaults = hlsAudioMediaDefaults(plan, manifest);
	const groups = manifest.variantsPerAudioGroup
		? [
				...new Set(
					plan.renditions.flatMap((r) =>
						r.hlsMedia ? [r.hlsMedia.groupId] : [],
					),
				),
			].sort()
		: [];
	for (const muxing of plan.muxings) {
		const rendition = plan.renditions.find((r) => r.key === muxing.streamKey);
		if (!rendition) {
			continue;
		}
		const entry = (
			uri: string,
			kind: HlsChildEntry["kind"],
			group?: string,
		) => {
			out.push({
				uri,
				muxingKey: muxing.key,
				renditionKey: rendition.key,
				kind,
				...(group !== undefined ? { group } : {}),
			});
		};
		if (isHlsAudioRendition(rendition)) {
			if (!hlsLegSelected(muxing.kind, manifest.audioMuxingKind)) {
				continue;
			}
			const uri = defaults.get(rendition.key)?.uri;
			if (uri) {
				entry(uri, "audio");
			}
			continue;
		}
		// Subtitle media playlists (review-325 I1): the compiler emits one
		// CREATE_HLS_SUBTITLES_MEDIA per CHUNKED_TEXT muxing with the
		// rendition's own `uri` — the first cut enumerated audio and video and
		// silently dropped this family, so a correct encode's subtitle playlist
		// was FOREIGN to --strict-prefix and unread by the child walk.
		if (rendition.codec === "WEBVTT") {
			if (muxing.kind === "CHUNKED_TEXT") {
				entry(rendition.uri, "text");
			}
			continue;
		}
		const video =
			rendition.codec === "H264" ||
			rendition.codec === "H265" ||
			rendition.codec === "VP9" ||
			rendition.codec === "AV1";
		if (!video) {
			continue;
		}
		if (
			"mode" in rendition &&
			typeof rendition.mode === "string" &&
			rendition.mode.startsWith("PER_TITLE")
		) {
			continue;
		}
		if (!hlsLegSelected(muxing.kind, manifest.videoMuxingKind)) {
			continue;
		}
		if (manifest.variantsPerAudioGroup) {
			for (const group of groups) {
				entry(hlsVariantUri(rendition, group), "video", group);
			}
		} else {
			entry(hlsVariantUri(rendition), "video");
		}
	}
	return dedupeVideoChildUris(out);
}

/**
 * Two DIFFERENT video renditions deriving one uri — a shared bitrate (row
 * #325, owner 2026-09-11) — get `_1`, `_2`… before the extension in plan
 * order; the first keeps the bare name every fixture was named by. One
 * rendition listed twice keeps its duplicate on purpose: that is the
 * `PLAN_HLS_RENDITION_MULTI_LEG` shape and must stay visible to its rail.
 * Audio defaults already disambiguate by key, and explicit audio/text uris
 * are the author's — the validator, not a rename, answers those.
 */
/** `name.m3u8` → `name_<n>.m3u8`; a name without the extension still changes (review-538 O2). */
function suffixChildUri(base: string, n: number): string {
	const stem = base.endsWith(".m3u8") ? base.slice(0, -".m3u8".length) : base;
	const ext = base.endsWith(".m3u8") ? ".m3u8" : "";
	return `${stem}_${n}${ext}`;
}

function dedupeVideoChildUris(
	entries: HlsChildEntry[],
	reserved: Iterable<string> = [],
): HlsChildEntry[] {
	const ownerOf = new Map<string, string>();
	const taken = new Set(reserved);
	return entries.map((entry) => {
		if (entry.kind !== "video") {
			return entry;
		}
		const owner = ownerOf.get(entry.uri);
		if (
			(owner === undefined && !taken.has(entry.uri)) ||
			owner === entry.renditionKey
		) {
			ownerOf.set(entry.uri, entry.renditionKey);
			taken.add(entry.uri);
			return entry;
		}
		let uri = entry.uri;
		for (let n = 1; taken.has(uri); n += 1) {
			uri = suffixChildUri(entry.uri, n);
		}
		taken.add(uri);
		ownerOf.set(uri, entry.renditionKey);
		return { ...entry, uri };
	});
}

/**
 * Every child playlist an HLS manifest's master will reference, de-duplicated.
 *
 * Two readers: the verifier's foreign-object filter (a child the compiler
 * itself named is not foreign — paid audit 893eb66 BLOCKER-5, the false FAIL)
 * and its child-playlist walk (each of these must exist, parse, and close).
 */
export function hlsChildFiles(
	plan: EncodingPlan,
	manifest: Parameters<typeof hlsChildEntries>[1],
): string[] {
	return [...new Set(hlsChildEntries(plan, manifest).map((e) => e.uri))];
}

/** Generated I-frame filename by selected muxing (#325). I-frame playlists
 * have a distinct parser/closure contract and are not ordinary media rungs.
 */
export function hlsIframeUris(
	plan: EncodingPlan,
	manifest: Parameters<typeof hlsChildEntries>[1] & {
		iframePlaylists?: boolean;
	},
): Map<string, string> {
	if (!manifest.iframePlaylists || !manifest.variantsPerAudioGroup)
		return new Map();
	const entries = hlsChildEntries(plan, manifest);
	// One I-frame writer per selected video muxing, not per audio group.
	const writers = new Map<string, HlsChildEntry>();
	for (const entry of entries) {
		if (
			entry.kind !== "video" ||
			entry.group === undefined ||
			writers.has(entry.muxingKey)
		)
			continue;
		const rendition = plan.renditions.find((r) => r.key === entry.renditionKey);
		if (rendition && "bitrate" in rendition) {
			writers.set(entry.muxingKey, {
				...entry,
				uri: hlsVariantUri(rendition, "iframe"),
			});
		}
	}
	// Ordinary playlists own their names, including explicit audio/text URIs
	// and a video group literally named "iframe". Only generated I-frame names
	// are suffixed; the compiler and static collision checks share this map.
	return new Map(
		dedupeVideoChildUris(
			[...writers.values()],
			entries.map((e) => e.uri),
		).map((entry) => [entry.muxingKey, entry.uri]),
	);
}

/** Static write names, without adding I-frame files to ordinary media checks. */
export function hlsStaticChildUris(
	plan: EncodingPlan,
	manifest: Parameters<typeof hlsIframeUris>[1],
): string[] {
	return [
		...new Set([
			...hlsChildFiles(plan, manifest),
			...hlsIframeUris(plan, manifest).values(),
		]),
	];
}
