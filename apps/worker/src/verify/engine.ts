/**
 * The verification engine: `ExpectedArtefacts` + a bucket → a `VerificationReport`.
 *
 * This is the half that touches the world. It takes what the expectation compiler
 * derived from the plan (`packages/core/src/verify/expected.ts`, pure) and checks it
 * against the files the encoder actually wrote.
 *
 * Every side effect arrives through `EngineDeps`, and that is not decoration: the
 * self-test drives this same code against locally synthesized artefacts with planted
 * defects, which is the only way to know the checks fire. A verifier whose failure has
 * never been observed is not evidence .
 *
 * THE RULE, learned across five instances and two independent sweeps:
 *
 *   **Never gate an assertion on a value the artefact under test supplies.**
 *
 * A guard on a PLAN field is fine — `drm.kid`, `sprite.vttName`, `muxing.initSegment`,
 * `manifest.dashOnDemand`. When the plan does not state an expectation, nothing is owed
 * and no check is missing. Most guards in this file are that kind.
 *
 * A guard on a MEASURED value is the bug. `probe.videoCodec`, `probe.fps`,
 * `probe.audioSampleRate`, `probe.bitrateBps`, `deps.reference.durationSec` — gating on
 * those lets the artefact decide whether it gets checked, and the odd file that returns
 * less than usual is exactly the one you wanted checked hardest. At its worst it was
 * self-cancelling: a truthiness test on `bitrateBps` meant a **zero-bitrate file deleted
 * its own bitrate check**. If a measured value is missing, that is a finding, or at
 * minimum a SKIP that names it. Never silence.
 *
 * `engine-no-silence.test.ts` enforces this by property: for one plan and one set of
 * artefacts, the set of check IDs must be identical whether the probe returns rich facts
 * or almost none.
 *
 * Verdicts, per  §5:
 *   PASS    the assertion held
 *   WARN    a heuristic tripped — a human should look, the build is not wrong
 *   FAIL    a contract was violated
 *   SKIP    not checkable here, with the reason named
 * There is deliberately no fifth, quieter state.
 */

import type {
	ExpectedArtefacts,
	ExpectedDrm,
	ExpectedManifest,
	ExpectedMuxing,
	ManifestRenditionTopology,
	PerTitleActualPopulations,
	PerTitleActualQcUnit,
	PerTitleActualVideoFamilies,
} from "@bitovp/core";
import { createFilenameMatcher } from "@bitovp/core";
import {
	expandRandomFilenameTokens,
	initSegmentCandidates,
} from "../bitmovin/filename-template";
import {
	bindHlsVideoReferences,
	checkHlsReferenceObjects,
	type HlsVideoReferences,
	referencedObjectKey,
	storageObjectUrl,
} from "./hls-video-reference-binding";
import {
	collectHlsReferenceChecks,
	selectedHlsAudioGroups,
} from "./manifest-reference-checks";
import {
	MAX_NORMALIZED_BITRATE_COST,
	matchOneToOne,
	normalizedBitrateCost,
	UNKNOWN_BITRATE_COST,
} from "./one-to-one";
import {
	bindPerTitleDelivery,
	type PerTitleDeliveryBinding,
} from "./per-title-delivery";
import { perTitleMediaExpectation } from "./per-title-media";
import {
	scopedPerTitleResults,
	scopedPerTitleVideoFamilies,
} from "./per-title-selection";
import { MAX_SUBTITLE_XML_BYTES, validateSubtitleXml } from "./subtitle-xml";

export type Verdict = "PASS" | "WARN" | "FAIL" | "SKIP";

export type Check = {
	/** Stable id so a report diff is readable across runs. */
	id: string;
	area:
		| "muxing"
		| "rendition"
		| "manifest"
		| "drm"
		| "thumbnails"
		| "sprites"
		| "qc"
		| "hygiene";
	verdict: Verdict;
	/** One line, in the form "what was expected vs what was there". */
	detail: string;
};

export type VerificationReport = {
	planName: string;
	checks: Check[];
	counts: Record<Verdict, number>;
	/** FAIL count — the number a caller gates on. Derived; see `appendCheck`. */
	readonly failed: number;
};

/**
 * Append a check to a finished report and keep every derived number honest.
 *
 * `build` used to snapshot `failed: counts.FAIL`, and callers appended checks after the
 * fact by bumping `counts.FAIL` directly. `verify job` returns `report.failed` as its
 * PROCESS EXIT CODE — so a truncated listing printed `FAIL 1` in its own summary and
 * exited 0, which the nightly job reads as green. The comment beside that push described
 * the mechanism it was failing to use (review catch).
 *
 * `failed` is a getter now, so no snapshot can go stale, and this is the only sanctioned
 * way to append: fixing the single call site would have left the trap armed for whoever
 * pushes the next check.
 */
export function appendCheck(report: VerificationReport, check: Check): void {
	report.checks.push(check);
	report.counts[check.verdict] += 1;
}

/**
 * Per-title evidence gaps that forbid a release PASS.
 *
 * A SKIP is normally capability-limited and does not make an otherwise useful
 * report fail. The per-title population is different: it is the authority for
 * which RESULT rungs and output legs existed. If that authority is incomplete,
 * legacy, or cannot be joined to a provider output, another artefact's PASS
 * must not launder the scenario green. Callers map these rows to INVALID while
 * preserving the SKIP/UNVERIFIED classification inside the report.
 */
export function perTitleUnverifiedChecks(
	report: Pick<VerificationReport, "checks">,
): Check[] {
	return report.checks.filter(
		(check) =>
			check.verdict === "SKIP" &&
			(check.id.startsWith("pertitle:") || check.id.startsWith("qc:pertitle:")),
	);
}

/** One object as the storage layer describes it. */
export type ObjectEntry = {
	key: string;
	size?: number;
	/**
	 * ISO timestamp, when the driver reports one.
	 *
	 * Carried because `--strict-prefix` DOCUMENTED a timestamp comparison and did not
	 * make one: it matched basenames only, so stale segments from an earlier run of the
	 * same plan — the exact incident it exists for, 100 identically-named segments —
	 * were not excluded, while a correct output's own media playlists were counted
	 * foreign (review catch).
	 */
	lastModified?: string;
};

/** Probe facts the engine needs; the worker supplies these via ffprobe. */
export type MediaProbe = {
	width?: number;
	height?: number;
	videoCodec?: string;
	profile?: string;
	fps?: number;
	nbFrames?: number;
	durationSec?: number;
	bitrateBps?: number;
	audioCodec?: string;
	audioChannels?: number;
	audioSampleRate?: number;
	/** The AUDIO stream's own bitrate in bps — for the exact-topology check (row 272). */
	audioBitrateBps?: number;
	/** True when the container has no video stream at all (audio-only rungs). */
	videoAbsent?: boolean;
	/** The VIDEO stream's own duration — see `adapters.ts` for why it is not the container's. */
	videoDurationSec?: number;
};

/** MP4 boxes the DRM checks need, from a bounded read of an init segment. */
export type BoxFacts = {
	/** `pssh` system ids found, lower-case hex, no dashes. */
	psshSystemIds: string[];
	/** `schm` scheme type, e.g. `cenc` / `cbcs`. */
	schemeType?: string;
	/** `tenc` default_IV_size. */
	ivSizeBytes?: number;
	/** `tenc` default_KID, lower-case hex, no dashes. */
	defaultKid?: string;
};

export type ParsedHls = {
	/**
	 * Variant streams in the master playlist. `resolution` is `WxH`, `codecs`
	 * the RFC 6381 list — both bound to the plan's rendition (row 272); a variant
	 * that omits either yields an explicit SKIP, never a silent pass.
	 */
	variants: {
		uri: string;
		bandwidth?: number;
		resolution?: string;
		codecs?: string;
		/**
		 * The AUDIO attribute — the GROUP-ID the variant points at, absent on a
		 * self-contained (muxed-in) variant. Part of the row's IDENTITY for the
		 * one-to-one binding (row 284): a `variantsPerAudioGroup` master lists one
		 * row per (video muxing × group), and only AUDIO tells them apart.
		 */
		audio?: string;
	}[];
	/**
	 * Rendition groups (audio/subtitles) declared by EXT-X-MEDIA. `name` is the
	 * EXT-X-MEDIA NAME, the child's identity for binding to a plan rendition (row
	 * 272). Uniqueness of NAME within a group is still enforced from the RAW TEXT
	 * (`:media-names-unique`), because `m3u8-parser` keys media BY name and so
	 * collapses a duplicate — a defect this binding must not be the sole reader of.
	 */
	media: {
		type: string;
		groupId?: string;
		name?: string;
		uri?: string;
		language?: string;
		instreamId?: string;
	}[];
	version?: number;
	/**
	 * Segment count, for a MEDIA playlist. Present so "the parser accepted it" can be
	 * distinguished from "it is actually a playlist": m3u8-parser does not throw on
	 * garbage, it returns an empty result, so a parse check that only catches throws
	 * passes on any text at all. The self-test proved that on the first run.
	 */
	segments?: number;
	/**
	 * Every media segment URI a MEDIA playlist references, in order, plus the
	 * EXT-X-MAP init when present : the walk
	 * used to COUNT `#EXTINF` lines and never fetch what they named.
	 */
	segmentUris?: string[];
	mapUri?: string;
	/** Per-segment addressing, retaining every initialization change and byte range. */
	mediaSegments?: {
		uri: string;
		byteRange?: { offset?: number; length?: number };
		map?: { uri: string; byteRange?: { offset?: number; length?: number } };
	}[];
};

export type ParsedDash = {
	representations: {
		periodIndex?: number;
		/** Concrete image references expanded by the DASH parser, including inherited templates. */
		imageUris?: string[];
		baseUrl?: string;
		language?: string;
		id?: string;
		height?: number;
		width?: number;
		bandwidth?: number;
		/**
		 * The RFC 6381 codec string this representation (or its AdaptationSet)
		 * declares — bound to the plan's rendition codec (row 272). Absent yields
		 * an explicit SKIP.
		 */
		codecs?: string;
		/** How the representation addresses segments. */
		addressing: "TEMPLATE" | "TIMELINE" | "BASE" | "LIST" | "UNKNOWN";
		/**
		 * What the representation carries
		 * from the enclosing AdaptationSet's `contentType`, else its
		 * `mimeType` prefix, else the representation's own `height` (video) —
		 * an audio-only MPD with four expected video entries used to pass a
		 * count-of-everything check as long as the TOTAL happened to be right.
		 */
		kind: "video" | "audio" | "text" | "image" | "unknown";
	}[];
	periods: number;
	durationSec?: number;
	/**
	 * The playlists mpd-parser RESOLVED (video variants and audio groups) with
	 * every segment URI and the init URI, relative to the MPD .
	 */
	playlists?: {
		kind: "video" | "audio" | "unknown";
		id?: string;
		baseUrl?: string;
		periodIndex?: number;
		/** A parser playlist may aggregate the same file across several periods. */
		periodIndices?: number[];
		codecs?: string;
		mapUri?: string;
		segmentUris: string[];
	}[];
	/**
	 * AdaptationSet structure from the document : which codecs
	 * each video/audio set carries — the shape paid case F broke (two codecs in
	 * one set) and no count-based check could see.
	 */
	adaptationSets?: {
		periodIndex?: number;
		kind: "video" | "audio" | "text" | "image" | "unknown";
		codecs: string[];
	}[];
};

export type EngineDeps = {
	/** List every object under a prefix, recursing — the engine needs the full set. */
	listAll(outputKey: string, prefix: string): Promise<ObjectEntry[]>;
	/** Download an object (optionally a byte range) and return a local path. */
	fetchObject(
		outputKey: string,
		key: string,
		range?: { start: number; end: number },
	): Promise<string>;
	/**
	 * Download several objects and concatenate them, in order, into ONE local file.
	 *
	 * Exists because an fMP4 media segment is not independently parseable. `moof`+`mdat`
	 * carry no `moov`, so ffprobe on a bare `.m4s` answers
	 * `Invalid data found when processing input` — and it is not a corrupt file, it is a
	 * file that needs its `init.mp4` in front of it.
	 *
	 * This was found the hard way. The previous round fixed a real defect (an init segment
	 * has no frames, so fps and bitrate could not be checked from it) by probing the first
	 * real segment instead — and that traded one blind spot for 19 false FAILs on the next
	 * corpus run, including a scenario whose artefacts I had just verified BY HAND against
	 * the bucket and found perfect. The lesson is the one this file's header already states
	 * in another form: an assertion must be given the input its subject actually requires.
	 *
	 * REQUIRED, not optional. An optional dep would let a fake omit it and every media
	 * property quietly SKIP, which is the fifth quiet state `engine-no-silence` exists to
	 * forbid.
	 */
	fetchConcatenated(outputKey: string, keys: string[]): Promise<string>;
	/** ffprobe a local file. */
	probe(path: string): Promise<MediaProbe>;
	/** Scan MP4 boxes in a local file. */
	scanBoxes(path: string): Promise<BoxFacts>;
	/** Read a text artefact (manifest) as a string. */
	readText(outputKey: string, key: string): Promise<string>;
	/**
	 * Parse an HLS master playlist with a real player-family parser (D1).
	 *
	 * Async because the real adapter `import`s `m3u8-parser` — the first draft typed
	 * these synchronously and the adapter had to throw from them, which is not a seam,
	 * it is a hole.
	 */
	parseHls(text: string): Promise<ParsedHls>;
	/** Parse an MPD with a real player-family parser (D1). */
	parseDash(text: string): Promise<ParsedDash>;
	/** Reference facts, when the runner knows them (source duration/fps). */
	reference?: {
		durationSec?: number;
		fps?: number;
		nbFrames?: number;
		/** The VIDEO stream's duration, which the container's overstates when audio is longer. */
		videoDurationSec?: number;
	};
	/**
	 * Objects written by OTHER runs that must be ignored. Empty for a namespaced
	 * verify run; populated when verifying a historical job whose prefix is shared.
	 */
	foreignKeyFilter?: (key: string, entry?: ObjectEntry) => boolean;
	/**
	 * The per-title RESULT population's video codec families, when the caller
	 * captured them: the third witness of the
	 * declared / actual / manifest family comparison on a per-title manifest.
	 * Absent ⇒ that comparison is an explicit UNVERIFIED (SKIP), never a PASS.
	 */
	perTitleActual?: PerTitleActualVideoFamilies;
	/** Complete provider RESULT populations; present for every per-title job. */
	perTitlePopulations?: PerTitleActualPopulations;
	/** Plan output key -> provider output UUID, read from the job's create steps. */
	providerOutputIds?: Readonly<Record<string, string>>;
};

/** Tolerances, in one place so a report can state them. */
/**
 * Segment count is ASYMMETRIC on purpose. A symmetric ±1 was the first version and
 * the self-test caught it immediately: on a 12s clip at 4s segments, `want` is 3, and
 * removing a segment leaves 2 — inside ±1, so a truncated ladder passed. Missing
 * segments are always a defect; ONE extra trailing segment is normal, because an
 * encoder may flush a short final fragment. So the band is [want, want + 1].
 */
const SEGMENT_COUNT_EXTRA_ALLOWED = 1;
const BITRATE_LOW = 0.5;
const BITRATE_HIGH = 1.6;
/**
 * AUDIO bitrate band. Tighter than the video
 * band above, and a FAIL outside it rather than a WARN: an AAC/Dolby track is
 * (near-)CBR and lands within a few percent of target, so the "128k delivered at
 * 64k" the audit had to catch with a separate ffprobe (ratio 0.5) sits well
 * outside a defensible band, while container framing overhead is absorbed on the
 * high side. §17 P1-3's bar is that one mutated audio bitrate turns the verdict
 * red — a WARN would not.
 */
const AUDIO_BITRATE_LOW = 0.7;
const AUDIO_BITRATE_HIGH = 1.45;
/**
 * HLS variant BANDWIDTH band (row 272). EXT-X-STREAM-INF BANDWIDTH is the
 * variant's PEAK — the video target plus the muxed/associated audio plus
 * container overhead — so it is always ≥ the video bitrate and never a tight
 * match. The band is asymmetric and generous on the high side; the load-bearing
 * bound is the low one, which fails a variant declaring far less bandwidth than
 * its bound rendition's video bitrate (a swapped or mislabelled child).
 */
const HLS_BANDWIDTH_LOW = 0.9;
const HLS_BANDWIDTH_HIGH = 3.0;
/**
 * How many foreign keys `hygiene:foreign-objects` names in its detail line.
 *
 * Bounded because a genuinely contaminated prefix holds hundreds ('s
 * held 606) and a report line is read, not paged. Enough to identify the FAMILY,
 * which is the diagnosis a bare count withheld.
 */
const FOREIGN_KEYS_NAMED = 5;

export class ReportBuilder {
	readonly checks: Check[] = [];

	add(id: string, area: Check["area"], verdict: Verdict, detail: string): void {
		this.checks.push({ id, area, verdict, detail });
	}

	pass(id: string, area: Check["area"], detail: string): void {
		this.add(id, area, "PASS", detail);
	}
	fail(id: string, area: Check["area"], detail: string): void {
		this.add(id, area, "FAIL", detail);
	}
	warn(id: string, area: Check["area"], detail: string): void {
		this.add(id, area, "WARN", detail);
	}
	skip(id: string, area: Check["area"], detail: string): void {
		this.add(id, area, "SKIP", detail);
	}

	/** `cond ? PASS : FAIL`, so a call site reads as the assertion it is. */
	assert(
		id: string,
		area: Check["area"],
		cond: boolean,
		detail: string,
	): boolean {
		this.add(id, area, cond ? "PASS" : "FAIL", detail);
		return cond;
	}

	build(planName: string): VerificationReport {
		const counts: Record<Verdict, number> = {
			PASS: 0,
			WARN: 0,
			FAIL: 0,
			SKIP: 0,
		};
		for (const c of this.checks) {
			counts[c.verdict] += 1;
		}
		return {
			planName,
			checks: this.checks,
			counts,
			// Derived, never snapshotted: see `appendCheck`.
			get failed() {
				return counts.FAIL;
			},
		};
	}
}

/** Turn a `%number%`-style pattern into a matcher for real keys. */
function patternToRegExp(pattern: string, namingTemplate?: boolean): RegExp {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Generic paths retain explicit-length expansion; literal segment names expand none.
	const random =
		namingTemplate === false
			? escaped
			: expandRandomFilenameTokens(
					escaped,
					Number.MAX_SAFE_INTEGER,
					namingTemplate === true,
				);
	let withHoles = random.replace(/%[a-zA-Z]+%/g, "[^/]+");
	// Directory placeholders do not define a policy for literal segment filenames.
	if (namingTemplate === undefined)
		withHoles = withHoles.replace(/\\\{[a-zA-Z]+\\\}/g, "[^/]+");
	return new RegExp(`^${withHoles}$`);
}

/** Resolve the directories a muxing may have written into. */
function directoriesFor(
	muxing: ExpectedMuxing,
	drm: ExpectedDrm[],
): { outputKey: string; prefix: string; pattern: string }[] {
	if (muxing.outputKey !== "") {
		return [
			{
				outputKey: muxing.outputKey,
				prefix: muxing.dir.prefix,
				pattern: muxing.dir.pattern,
			},
		];
	}
	// A DRM'd muxing has no destination of its own: it writes through the DRM rows
	// that target it, and a row may point at a different output entirely.
	return drm
		.filter(
			(d) => muxing.viaDrmKeys?.includes(d.drmKey) && d.dir && d.outputKey,
		)
		.map((d) => ({
			outputKey: d.outputKey as string,
			prefix: (d.dir as { prefix: string }).prefix,
			pattern: (d.dir as { pattern: string }).pattern,
		}));
}

async function verifyMuxing(
	report: ReportBuilder,
	deps: EngineDeps,
	expected: ExpectedArtefacts,
	muxing: ExpectedMuxing,
): Promise<void> {
	const id = `muxing:${muxing.muxingKey}`;
	const dirs = directoriesFor(muxing, expected.drm);
	if (dirs.length === 0) {
		report.fail(
			id,
			"muxing",
			`no destination and no DRM route resolves for ${muxing.muxingKey} — nothing knows where to look`,
		);
		return;
	}

	const keys: string[] = [];
	// Which output each key came from. `dirs` can hold more than one — `directoriesFor`'s
	// own comment says a DRM row "may point at a different output entirely" — and every
	// fetch below used `dirs[0].outputKey`, so a key listed from the second output would
	// have been downloaded from the FIRST bucket: either a 404 reported as a probe
	// failure, or, worse, a same-named object in the wrong bucket probed as if it were
	// this one. No fixture routes a muxing to two outputs today (I checked all 66), so it
	// is latent — but a latent wrong-bucket read is not something to leave in a verifier.
	// PAIRS, not a Map keyed by the key string. A map collides when the same basename
	// exists under two outputs, which is the very case that makes a wrong-bucket read
	// dangerous rather than merely broken: a same-named object in the wrong bucket gets
	// probed as though it were the artefact, and reports a confident PASS about a file
	// that is not the one under test. My first attempt used a Map and a test could not
	// tell the difference — last write won.
	const listedKeys: { outputKey: string; key: string; size?: number }[] = [];
	for (const dir of dirs) {
		const listed = await deps.listAll(dir.outputKey, dir.prefix);
		let kept = 0;
		for (const o of listed) {
			if (deps.foreignKeyFilter?.(o.key, o) === true) {
				continue;
			}
			keys.push(o.key);
			listedKeys.push({
				outputKey: dir.outputKey,
				key: o.key,
				...(o.size !== undefined ? { size: o.size } : {}),
			});
			kept += 1;
		}
		// EACH destination must have received something. `keys` is the union across dirs,
		// so without this a muxing writing to two outputs passed every check on ONE
		// output's artefacts while the other produced nothing at all — a false PASS, and
		// the more dangerous half of the wrong-bucket finding it came in with (review
		// catch). Only emitted when there is more than one destination, so single-output
		// muxings keep their existing `id` FAIL for an empty prefix and no report shape
		// changes.
		if (dirs.length > 1 && kept === 0) {
			report.fail(
				`${id}:dest:${dir.outputKey}`,
				"muxing",
				`this muxing writes to ${dirs.length} destinations and ${dir.outputKey}:${dir.pattern} received nothing — another destination's artefacts cannot stand in for it`,
			);
		}
	}
	/** The output a key was listed from — first match, in `dirs` order. */
	const outputFor = (key: string): string =>
		listedKeys.find((x) => x.key === key)?.outputKey ??
		dirs[0]?.outputKey ??
		"";
	if (keys.length === 0) {
		report.fail(
			id,
			"muxing",
			`expected artefacts under ${dirs.map((d) => `${d.outputKey}:${d.pattern}`).join(", ")} — the prefix is empty`,
		);
		return;
	}

	// ---- per-title: one rung per directory, not one file seen seven times ------
	// Segmented per-title, init segment or not. Gating on `initSegment` left the TS leg
	// of every dual-leg per-title fixture on the shared-prefix path, where its segments
	// were summed across all rungs — half of `pertitle-h264-fmp4-ts-*`.
	if (muxing.perTitle && (muxing.segmentNaming || muxing.filename)) {
		await verifyPerTitleRungs(
			report,
			deps,
			expected,
			muxing,
			dirs,
			keys,
			listedKeys,
			id,
		);
		return;
	}

	// ---- the container family decides which files must be there ---------------
	const single =
		muxing.container === "TEXT_SINGLE" ||
		muxing.container === "WEBM_PROGRESSIVE" ||
		muxing.container === "MP4_PROGRESSIVE" ||
		muxing.container === "MP4_FRAGMENTED";
	if (single) {
		const name = muxing.filename;
		const hit = name
			? keys.find((k) =>
					muxing.container === "WEBM_PROGRESSIVE"
						? dirs.some((dir) => k === `${dir.prefix}${name}`)
						: k.endsWith(name),
				)
			: undefined;
		if (
			!report.assert(
				`${id}:file`,
				"muxing",
				hit !== undefined,
				`${muxing.container} must write ${name ?? "(unnamed)"} — ${hit ?? "absent"}`,
			)
		) {
			return;
		}
		if (muxing.container === "WEBM_PROGRESSIVE") {
			const object = listedKeys.find((entry) => entry.key === hit);
			if (object?.size === undefined)
				report.skip(
					`${id}:file-bytes`,
					"muxing",
					"Object size unavailable for the progressive WebM file",
				);
			else
				report.assert(
					`${id}:file-bytes`,
					"muxing",
					object.size > 0,
					"Progressive WebM file must contain bytes",
				);
		}
		if (muxing.container === "TEXT_SINGLE") {
			const listed = listedKeys.find((x) => x.key === hit);
			if (listed?.size === undefined)
				report.skip(`${id}:file-bytes`, "muxing", "Object size unavailable");
			else
				report.assert(
					`${id}:file-bytes`,
					"muxing",
					listed.size > 0,
					`Subtitle file contains ${listed.size} bytes`,
				);
			if (listed?.size !== undefined && listed.size > MAX_SUBTITLE_XML_BYTES) {
				report.fail(
					`${id}:file-xml`,
					"muxing",
					"Subtitle XML exceeds the 8 MiB verification limit",
				);
			} else {
				try {
					const validation = validateSubtitleXml(
						await deps.readText(outputFor(hit as string), hit as string),
					);
					report.assert(
						`${id}:file-xml`,
						"muxing",
						validation.valid,
						validation.detail,
					);
				} catch {
					report.fail(
						`${id}:file-xml`,
						"muxing",
						"Subtitle XML could not be read",
					);
				}
			}
			return;
		}
		// A progressive WebM or MP4 is self-contained: one key, no init to prepend.
		await verifyMediaProperties(
			report,
			deps,
			muxing,
			outputFor(hit as string),
			[hit as string],
		);
		return;
	}

	// Segmented: an init segment where the family has one, plus segments matching
	// the naming pattern — and the count must match the duration.
	/**
	 * The init segment's EXISTENCE, always; its media properties only as a FALLBACK.
	 *
	 * Now that the segment probe assembles `[init, segment]`, an init-only probe reports the
	 * same `rendition:*` check ids a second time with strictly less information — and duplicate
	 * ids are not free: they double-count in `report.counts`, which is exactly what the run
	 * report's `skipped ÷ evaluated` ranking divides by. A real re-verification printed
	 * `rendition:v540:height` twice and reported PASS 38 where 30 checks had been made.
	 *
	 * It is still the only signal when there is nothing to assemble, so it runs exactly then: a
	 * broken encode that wrote an init and no segments still gets its codec and geometry read,
	 * instead of one bare `:segments` FAIL and silence.
	 */
	const initCandidates = initSegmentCandidates(
		keys,
		muxing.initSegment,
		muxing.initSegmentNameTemplate,
	);
	const initKeyForMuxing =
		initCandidates.length === 1 ? initCandidates[0] : undefined;
	if (muxing.initSegment || muxing.initSegmentNameTemplate) {
		report.assert(
			`${id}:init`,
			"muxing",
			initKeyForMuxing !== undefined,
			`init segment ${muxing.initSegmentNameTemplate ?? muxing.initSegment} — ${initKeyForMuxing ?? `expected one match, found ${initCandidates.length}`}`,
		);
	}
	if (muxing.segmentNaming) {
		const rx = patternToRegExp(
			muxing.segmentNaming,
			muxing.segmentNamingIsTemplate === true,
		);
		const segments = keys.filter((k) => rx.test(k.split("/").pop() ?? ""));

		/**
		 * The segments must contain BYTES.
		 *
		 * `:segments` and `:segment-count` count FILES, so an origin write failure that
		 * truncates every segment to zero bytes reads as a perfectly healthy encode. §9b has
		 * recorded this as a known VOD gap since phase A — "nothing reads
		 * `ObjectEntry.size`, so a 0-byte segment still passes" — and the live tier got the
		 * check while VOD never did. A reviewer pointed out that with a real corpus in flight
		 * that gap is live ammunition, and it is a false GREEN, which is the worst kind.
		 *
		 * `size` is a value the world supplies, so an absent one SKIPs rather than gating —
		 * the rule at the top of this file.
		 */
		const sized = listedKeys.filter(
			(x) => rx.test(x.key.split("/").pop() ?? "") && x.size !== undefined,
		);
		if (segments.length > 0 && sized.length === 0) {
			report.skip(
				`${id}:segment-bytes`,
				"muxing",
				`the listing reported no object sizes, so ${segments.length} segment(s) could not be checked for content`,
			);
		} else if (segments.length > 0) {
			const empty = sized.filter((x) => (x.size ?? 0) === 0);
			report.assert(
				`${id}:segment-bytes`,
				"muxing",
				empty.length === 0,
				`segments must carry bytes — ${empty.length} of ${sized.length} are zero-length${empty.length > 0 ? ` (${empty[0]?.key})` : ""}`,
			);
		}
		/**
		 * Probe a real SEGMENT, not only the init.
		 *
		 * The segmented path probed the init segment and nothing else, so `fps` and `bitrate`
		 * — the two properties an init segment cannot carry — were structurally unverifiable
		 * for every segmented muxing in the corpus. The first real run made that visible from
		 * the other side: it reported `fps 25 — 25000`, the track TIMESCALE read off an init
		 * segment, and the honest fix is both to stop asking the init segment and to start
		 * asking a segment that has frames.
		 *
		 * `initOnly` is absent here on purpose: this file has media in it.
		 */
		const firstSegment = segments.sort((a, b) => a.localeCompare(b))[0];
		if (firstSegment !== undefined) {
			/**
			 * With the init segment IN FRONT of it, where the family has one.
			 *
			 * This is exactly what a player does with `EXT-X-MAP` / DASH's
			 * `<Initialization>`, so it is the format's own assembly rather than a workaround.
			 * Probing the segment alone was the previous version, and it turned a correct
			 * encode into a FAIL on 19 of 38 scenarios: `moof`+`mdat` with no `moov` is not
			 * something ffprobe can read, and its complaint —
			 * `Invalid data found when processing input` — reads exactly like a corrupt file.
			 *
			 * A TS segment needs no init and there is none in the plan, so it stays a
			 * single-key probe and keeps working.
			 */
			await verifyMediaProperties(
				report,
				deps,
				muxing,
				outputFor(firstSegment),
				initKeyForMuxing ? [initKeyForMuxing, firstSegment] : [firstSegment],
			);
		} else if (initKeyForMuxing) {
			// Nothing to assemble, so the init is all there is: fewer facts, honestly labelled.
			await verifyMediaProperties(
				report,
				deps,
				muxing,
				outputFor(initKeyForMuxing),
				[initKeyForMuxing],
				{ initOnly: true },
			);
		}
		if (
			!report.assert(
				`${id}:segments`,
				"muxing",
				segments.length > 0,
				`segments matching ${muxing.segmentNaming} — found ${segments.length}`,
			)
		) {
			return;
		}
		/**
		 * The OUTPUT's duration, not one source's.
		 *
		 * A concatenation's output is the sum of its parts, and the engine's only reference is
		 * the single object it probed. `concatenation-two-sources` FAILed a real run with
		 * `ceil(10.04s / 6s) = 2, so [2, 3] segments — found 4`, and 4 was right: the run points
		 * both sources at the same 10.04s mezzanine, so the output is 20.08s.
		 */
		const refDuration = outputDurationSec(expected, deps, muxing);
		const segLen = muxing.segmentLengthSec;
		if (refDuration !== undefined && segLen !== undefined) {
			/**
			 * The floor is the LOWER bound, because an encoder may absorb a short tail.
			 *
			 * `input/AWOLNATION_muxed_30s.mkv` is 30.03s at a 6s segment length. `ceil` says 6;
			 * Bitmovin wrote 5 and folded the trailing 0.03s into the last segment rather than
			 * emitting a 0.03-second fragment. The band `[ceil, ceil+1]` failed a correct encode
			 * for 30 milliseconds of content.
			 *
			 * Two real observations bracket it: 30.03s/6s → floor 5, ceil 6, observed **5**; and
			 * 10.04s/6s → floor 1, ceil 2, observed **2**. Both sit inside `[floor, ceil+1]`, and
			 * the band still catches gross truncation — 2 segments where 6 belong is far outside
			 * it. The upper tolerance is unchanged and has its own reason (a flushed final
			 * fragment) recorded at `SEGMENT_COUNT_EXTRA_ALLOWED`.
			 */
			const want = Math.ceil(refDuration / segLen);
			const least = Math.max(1, Math.floor(refDuration / segLen));
			const most = want + SEGMENT_COUNT_EXTRA_ALLOWED;
			const ok = segments.length >= least && segments.length <= most;
			report.add(
				`${id}:segment-count`,
				"muxing",
				ok ? "PASS" : "FAIL",
				`${refDuration.toFixed(2)}s / ${segLen}s allows [${least}, ${most}] segments — a short tail may be absorbed into the last one — found ${segments.length}`,
			);
		} else {
			report.skip(
				`${id}:segment-count`,
				"muxing",
				"no reference duration available, so the segment count cannot be derived",
			);
		}
	}
}

/** Probe one artefact and check geometry/codec/bitrate against the plan. */
/**
 * Per-title muxings, one rung at a time.
 *
 * `pathPattern` cuts a templated path at its FIRST placeholder, so every rung of a
 * per-title ladder resolves to the same listing prefix — in `pertitle-h264-openapi`,
 * seven FMP4 muxings all carry `…/video/dash/`. A review drove the shipped engine
 * against a CORRECT 3-rung result and got seven failures: `keys.find(k =>
 * k.endsWith("init.mp4"))` returned the same file every time, and the segment count
 * summed all rungs and compared the total against one rendition's expectation
 * (`found 6` where 2 were wanted).
 *
 * The honest model is that per-title rungs are chosen by the ENCODER: the plan cannot
 * name their heights or how many there will be. So this asserts what is actually
 * knowable — that the placeholder expanded (C4), that each rung carries an init
 * segment and its own segments in the right number, that the codec is right, and that
 * the rungs are distinct — and never asserts a template value the plan deliberately
 * left out.
 */
async function verifyPerTitleRungs(
	report: ReportBuilder,
	deps: EngineDeps,
	expected: ExpectedArtefacts,
	muxing: ExpectedMuxing,
	dirs: { outputKey: string; prefix: string; pattern: string }[],
	keys: string[],
	/** Every (output, key) pair listed — see the comment at the call site. */
	listedKeys: { outputKey: string; key: string }[],
	id: string,
): Promise<void> {
	// Group by the path component directly under the shared prefix. Keys arrive from
	// every dir, so strip whichever prefix each one actually starts with.
	const rungs = new Map<string, string[]>();
	for (const key of keys) {
		const dir = dirs.find((d) => key.startsWith(d.prefix));
		if (!dir) {
			continue;
		}
		const rest = key.slice(dir.prefix.length).replace(/^\/+/, "");
		const slash = rest.indexOf("/");
		if (slash <= 0) {
			// A file directly under the shared prefix is not a rung — a per-title ladder
			// always writes into per-rung directories, so this is either contamination or
			// a plan whose placeholder never expanded, and the C4 check below says which.
			continue;
		}
		const rung = rest.slice(0, slash);
		const list = rungs.get(rung);
		if (list) {
			list.push(key);
		} else {
			rungs.set(rung, [key]);
		}
	}

	const literal = [...rungs.keys()].filter((r) => /[{}]/.test(r));
	report.assert(
		`${id}:rung-placeholders`,
		"muxing",
		literal.length === 0,
		literal.length === 0
			? `every rung directory expanded its {…} placeholders (C4)`
			: `rung directories still contain literal placeholders (C4): ${literal.join(", ")}`,
	);

	/**
	 * How many rungs must be here, at minimum.
	 *
	 * `rungs.size > 0` was the only check, and it was not enough: a 7-rung ladder that
	 * collapsed to ONE produced 0 FAILs and 104 PASSes, because the loop below only ever
	 * iterates the rungs that DO exist. A missing rung is invisible to per-rung checks by
	 * construction, so the count has to be asserted separately.
	 *
	 * Every per-title muxing sharing this prefix contributes: a `FIXED` one pins its own
	 * resolution and so yields exactly one rung directory, while a `TEMPLATE` one is
	 * expanded by the encoder into an unknown number ≥ 1. So the bound is exact when all
	 * siblings are FIXED and a true lower bound otherwise — never an upper one, because
	 * per-title choosing MORE rungs than the template suggested is correct behaviour.
	 */
	const here = new Set(dirs.map((d) => `${d.outputKey}\0${d.prefix}`));
	const siblings = expected.muxings.filter(
		(m) =>
			m.perTitle &&
			m.container === muxing.container &&
			// RESOLVED directories, not `m.dir.prefix`. A DRM'd muxing has no destination
			// of its own — all four muxings of `pertitle-h264-mp4-smooth-drm-on-aws` carry
			// `dir.prefix: ""` and reach storage through their DRM rows — so comparing the
			// raw field found NO siblings, which made the bound "exactly 1" and failed a
			// correct 4-rung ladder before it ever reached the per-rung checks. Found by
			// writing the MP4 test, not by reading the code.
			directoriesFor(m, expected.drm).some((d) =>
				here.has(`${d.outputKey}\0${d.prefix}`),
			),
	);
	/**
	 * A BAND, and the two ends come from different guarantees.
	 *
	 * Bitmovin's per-title semantics, confirmed against the encoding API rather than
	 * inferred from the fixtures:
	 *
	 *   FIXED     `PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE` pins its resolution
	 *             and bitrate, and the algorithm never prunes it — exactly one rung,
	 *             whatever the source complexity. So the count of FIXED siblings is a
	 *             hard floor.
	 *   TEMPLATE  plain `PER_TITLE_TEMPLATE` is a CANDIDATE for the convex hull, and the
	 *             algorithm routinely drops it: no perceptual gain on low-motion content,
	 *             a target height above the source's, `maxBitrate`/step-size pruning, or
	 *             redundancy against a fixed rung. **Zero rungs from a template is
	 *             correct behaviour**, so it contributes to the ceiling and nothing to
	 *             the floor.
	 *
	 * My previous bound was `fixed + templates`, which asserts the opposite of that — and
	 * a review measured the cost: on `pertitle-h264-openapi` a legitimate 4-rung result
	 * (Bitmovin's own stated minimum for 4 fixed + 3 template) produced **14 FAILs**, and
	 * the same across four other per-title fixtures. I had gone from a false green
	 * (`> 0`, which passed a collapsed ladder) straight past the answer to a false red, in
	 * the round whose whole purpose is removing false reds.
	 *
	 * `[fixed, siblings.length]` still catches the collapse this check exists for: one
	 * rung where four are fixed fails, and the ceiling bites too — 8 rungs against 7
	 * declared muxings fails, because per-title selects from the declared streams and
	 * never instantiates new ones. When every sibling is FIXED the band closes to an
	 * equality on its own, so there is no separate `exact` branch to go stale — the
	 * previous one never fired on any of the 66 fixtures, since all 14 per-title plans
	 * carry at least one flexible template.
	 *
	 * Two things the floor deliberately does NOT use, both raised in review:
	 *
	 *   `forcedRenditionAboveHighestFixedRepresentation: 1` (which `pertitle-h264-openapi`
	 *   sets) would justify `fixed + 1`, and Bitmovin puts that fixture's range at 5..7.
	 *   But that guarantee is CONDITIONAL on the source resolution permitting a rung above
	 *   the highest fixed one, and this engine has no source height — `reference` carries
	 *   duration/fps/frames only. Tightening to `fixed + 1` would therefore reintroduce a
	 *   false red on a 720p source, which is the mistake this band exists to undo.
	 *
	 *   `siblings` filters on `m.container === muxing.container`, so if two containers ever
	 *   shared one resolved prefix the CEILING would under-count and produce a false red.
	 *   No fixture does that today — the dual-leg fixtures separate `video/dash/` from
	 *   `video/hls/` — so it is latent and recorded rather than guessed at.
	 */
	const fixed = siblings.filter((m) => m.perTitleMode === "FIXED").length;
	const templates = siblings.length - fixed;
	const atLeast = Math.max(1, fixed);
	const atMost = Math.max(atLeast, siblings.length);
	/**
	 * The FLOOR fails; the CEILING only warns. They are not equally knowable.
	 *
	 * The floor is sound: each FIXED template is guaranteed a rung, and a ladder that collapsed
	 * below it is the real defect this check exists for.
	 *
	 * The ceiling was `siblings.length`, and a real run refuted it. `pertitle-av1-fmp4-dash-on-aws`
	 * declares TWO per-title video muxings and the encoder wrote FOUR rung directories:
	 *
	 *   360p_128000   360p_415163   720p_1346567   720p_1615880
	 *
	 * Both extras are explained by the plan's own per-title configuration, which the ceiling did
	 * not consult. `forcedRenditionAboveHighestFixedRepresentation: 1` with
	 * `…Factor: 1.2` and `…CalculationMode: LAST_CALCULATED_BITRATE` predicts a rung at
	 * 1346567 × 1.2 = 1615880.4 — the observed 720p_1615880, to the rounding. And `minBitrate:
	 * 128000` matches 360p_128000 exactly. So the encoder was doing what it was asked.
	 *
	 * Bitmovin's own docs agent, asked directly, says the template count IS a strict upper bound
	 * and four directories from two templates "indicates a misconfiguration". The bucket says
	 * otherwise and names the arithmetic. When a documented claim and the artefact disagree, the
	 * artefact wins — that is the whole premise of this harness — but the disagreement is real
	 * enough that suppressing it entirely would be dishonest too.
	 *
	 * So: WARN, with the arithmetic in the message. It keeps the signal for a human without
	 * reporting a correct encode as broken, which is the failure mode that cost this run 19 of
	 * its 32 FAILs elsewhere. Tightening it to `siblings + forced` would need the per-title
	 * config threaded into the expectation (66 goldens) — recorded in STATUS.md, not guessed at.
	 */
	if (
		!report.assert(
			`${id}:rungs`,
			"muxing",
			rungs.size >= atLeast,
			`at least ${atLeast} rung director${atLeast === 1 ? "y" : "ies"} under ${dirs.map((d) => d.pattern).join(", ")} — ${fixed} fixed muxing(s) are guaranteed a rung each, ${templates} flexible template(s) may be pruned by the convex hull — found ${rungs.size}`,
		)
	) {
		return;
	}
	if (rungs.size > atMost) {
		report.warn(
			`${id}:rungs-above-templates`,
			"muxing",
			`${rungs.size} rung directories from ${siblings.length} per-title muxing(s) — more than the templates alone explain. Legitimate causes are in the plan's own perTitle config: forcedRenditionAboveHighestFixedRepresentation, a minBitrate floor rung, or autoRepresentations. Not failed, because a real run produced exactly this from a correct encode (see the comment above).`,
		);
	}

	// C4: the placeholders have to have been EXPANDED. A literal `{height}` directory
	// means Bitmovin wrote the template as a name, which produced a plausible-looking
	// tree and would otherwise pass every check below.

	// Same correction on the per-title path — see the note at the segmented site.
	const refDuration = outputDurationSec(expected, deps, muxing);
	const segLen = muxing.segmentLengthSec;
	const rx = muxing.segmentNaming
		? patternToRegExp(
				muxing.segmentNaming,
				muxing.segmentNamingIsTemplate === true,
			)
		: undefined;

	for (const [rung, rungKeys] of [...rungs.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const rid = `${id}:${rung}`;
		// Three container shapes, three places to look:
		//   FMP4/WebM  the init segment
		//   TS         the first segment (no init exists), so its codec and geometry are
		//              checked rather than skipped — half of every dual-leg fixture
		//   MP4        the single file the muxing names
		// The MP4 case is why `filename` opens this branch at all: the four MP4 muxings of
		// `pertitle-h264-mp4-smooth-drm-on-aws` all resolve to ONE prefix and all name
		// `video.ismv`, so the single-file path probed the same file four times and
		// reported it as four renditions — the aliasing bug this branch exists to remove,
		// still live for single-file containers until now (second review's priority 2).
		const hasInit = Boolean(
			muxing.initSegment || muxing.initSegmentNameTemplate,
		);
		const initCandidates = initSegmentCandidates(
			rungKeys,
			muxing.initSegment,
			muxing.initSegmentNameTemplate,
		);
		const probeKey = hasInit
			? initCandidates.length === 1
				? initCandidates[0]
				: undefined
			: muxing.filename
				? rungKeys.find((k) => k.endsWith(muxing.filename as string))
				: rungKeys.find((k) => rx?.test(k.split("/").pop() ?? ""));
		if (!hasInit && muxing.filename) {
			report.assert(
				`${rid}:file`,
				"muxing",
				probeKey !== undefined,
				`rung ${rung}: ${muxing.container} must write ${muxing.filename} — ${probeKey ?? "absent"}`,
			);
		}
		if (hasInit) {
			report.assert(
				`${rid}:init`,
				"muxing",
				probeKey !== undefined,
				`rung ${rung}: init segment ${muxing.initSegmentNameTemplate ?? muxing.initSegment} — ${probeKey ?? `expected one match, found ${initCandidates.length}`}`,
			);
		}
		if (probeKey) {
			// The rung's first media segment, so an init-plus-segment assembly is possible.
			// Absent for the MP4 single-file shape, where `probeKey` IS the whole file.
			const firstRungSegment =
				hasInit && rx
					? rungKeys
							.filter((k) => rx.test(k.split("/").pop() ?? ""))
							.sort((a, b) => a.localeCompare(b))[0]
					: undefined;
			await probeRung(
				report,
				deps,
				muxing,
				listedKeys.find((x) => x.key === probeKey)?.outputKey ??
					dirs[0]?.outputKey ??
					"",
				firstRungSegment ? [probeKey, firstRungSegment] : [probeKey],
				rid,
			);
		}
		if (rx) {
			const segments = rungKeys.filter((k) =>
				rx.test(k.split("/").pop() ?? ""),
			);
			if (
				report.assert(
					`${rid}:segments`,
					"muxing",
					segments.length > 0,
					`rung ${rung}: segments matching ${muxing.segmentNaming} — found ${segments.length}`,
				)
			) {
				if (refDuration !== undefined && segLen !== undefined) {
					const want = Math.ceil(refDuration / segLen);
					report.add(
						`${rid}:segment-count`,
						"muxing",
						segments.length >= want &&
							segments.length <= want + SEGMENT_COUNT_EXTRA_ALLOWED
							? "PASS"
							: "FAIL",
						`rung ${rung}: ceil(${refDuration.toFixed(2)}s / ${segLen}s) = ${want}, so [${want}, ${want + SEGMENT_COUNT_EXTRA_ALLOWED}] segments — found ${segments.length}`,
					);
				} else {
					// A SKIP, never silence. The non-per-title path already had this `else`
					// and the per-rung path did not, so with no reference duration **56
					// per-rung checks simply vanished** and a broken ladder reported zero
					// FAILs — while `verifyJob` had logged "reference unavailable …
					// duration-derived checks will SKIP", a promise this path did not keep.
					//
					// This file's own header says there is "deliberately no fifth, quieter
					// state". A check that disappears IS that state, and it is the fourth
					// time in this branch it has been the defect (review catch).
					report.skip(
						`${rid}:segment-count`,
						"muxing",
						`rung ${rung}: no reference duration available, so the segment count cannot be derived — ${segments.length} segment(s) present, unchecked`,
					);
				}
			}
		}
	}

	/**
	 * There is deliberately NO distinct-geometry check here.
	 *
	 * I wrote one — "per-title rungs must differ in geometry" — and it failed a correct
	 * ladder on the first run: `pertitle-h264-openapi` legitimately carries two rungs at
	 * height 360 with different bitrates (`{height}p_{bitrate}` is why the directory name
	 * has both). The invariant I reached for was distinctness of the DIRECTORY, which is
	 * already guaranteed — they are map keys — while distinctness of (height, bitrate)
	 * needs a bitrate an init segment does not carry. So the check had no content it could
	 * honestly assert, and shipping it would have added exactly the kind of false FAIL
	 * this whole round exists to remove.
	 */
}

/**
 * The duration the OUTPUT should have, from the reference the runner probed.
 *
 * For most plans that is the source duration. For a concatenation it is the sum of the parts,
 * and the expectation carries the part COUNT because only the engine has a duration and only
 * for the one object it measured — which, under the verify rewrite, is every part.
 *
 * Returns `undefined` when there is no reference at all, so the caller SKIPs rather than
 * inventing a number: the rule at the top of this file.
 */
function outputDurationSec(
	expected: ExpectedArtefacts,
	deps: EngineDeps,
	/**
	 * The muxing whose count is being derived, when there is one.
	 *
	 * A VIDEO muxing runs for as long as the VIDEO does, and that is not the container's
	 * duration when the audio track is longer. `generic-s3-akamai-io` on a 30.03s source wrote
	 * 6 audio segments and 5 video ones, and the engine failed the video with
	 * `ceil(30.03s / 6s) = 6 … found 5` — the encoder was right and the divisor was wrong.
	 *
	 * The same distinction already bit the thumbnail gate one commit earlier (a position at 10s
	 * on a container that says 10.04s but whose video ends at 9.04s), which is what makes this
	 * the second confirming instance rather than a guess.
	 */
	muxing?: ExpectedMuxing,
): number | undefined {
	const container = deps.reference?.durationSec;
	const fps = deps.reference?.fps;
	const frames = deps.reference?.nbFrames;
	/**
	 * The stream's own duration FIRST, frames ÷ fps second.
	 *
	 * Matroska usually omits `nb_frames`, and `input/AWOLNATION_muxed_30s.mkv` does — so the
	 * frames route alone fell straight back to the container and the fix changed nothing.
	 */
	const video =
		deps.reference?.videoDurationSec ??
		(frames !== undefined && fps !== undefined && fps > 0
			? frames / fps
			: undefined);
	// Video muxings measure video; everything else measures the container. An unmeasurable
	// video duration falls back rather than skipping the check entirely.
	/**
	 * The video stream's duration when it is known, the container's otherwise.
	 *
	 * The distinction is real — a container is as long as its LONGEST track, and the thumbnail
	 * gate needed exactly this — but it was NOT the cause of the count mismatch it was reached
	 * for. On `input/AWOLNATION_muxed_30s.mkv` the video's own `tags.DURATION` is 30.03s, the
	 * same as the container, and 5 segments were still written. Falling back keeps the check
	 * running instead of SKIPping on a theory the data refuted.
	 */
	/**
	 * A TRIM overrides the source entirely: the output is exactly as long as the trim says.
	 *
	 * Checked before the source duration, because it is the more specific fact. Running
	 * `trimming-time-based` against the full 596.46s Big Buck Bunny had the engine demand
	 * `[99, 101]` segments of an encode that correctly wrote 5 — the plan trims to 30 seconds.
	 */
	if (expected.trimmedToSeconds !== undefined) {
		return expected.trimmedToSeconds;
	}
	const base = muxing?.video ? (video ?? container) : container;
	if (base === undefined) {
		return undefined;
	}
	return base * Math.max(1, expected.concatenatedSources ?? 1);
}

/** Probe one per-title rung's init segment (or, for TS, its first segment). */
async function probeRung(
	report: ReportBuilder,
	deps: EngineDeps,
	muxing: ExpectedMuxing,
	outputKey: string,
	/**
	 * The rung's file as the ORDERED assembly a player would make.
	 *
	 * `[init]` alone is right for fMP4 — an `init.mp4` carries `moov` and probes fine — but
	 * NOT for WebM: `pertitle-vp9-webm-fmp4-dash-on-aws` failed a real run with
	 * `init.hdr: End of file`, because a WebM header without any cluster after it is a
	 * truncated file. Passing `[init, firstSegment]` is correct for both, and it also makes
	 * fps and bitrate readable for per-title rungs, which an init-only probe cannot give.
	 */
	keys: string[],
	rid: string,
): Promise<void> {
	const subject = keys[keys.length - 1] ?? "(nothing)";
	let probe: MediaProbe;
	try {
		const path = await deps.fetchConcatenated(outputKey, keys);
		probe = await deps.probe(path);
	} catch (err) {
		report.fail(
			`${rid}:probe`,
			"rendition",
			`could not probe ${subject}${keys.length > 1 ? ` (with ${keys[0]})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	if (muxing.video) {
		report.assert(
			`${rid}:height`,
			"rendition",
			(probe.height ?? 0) > 0,
			`rung must carry a real height — ${probe.height ?? "none"}`,
		);
		if (probe.videoCodec) {
			const want = muxing.video.codec;
			const seen = probe.videoCodec.toUpperCase();
			report.assert(
				`${rid}:codec`,
				"rendition",
				(want === "H264" && seen === "H264") ||
					(want === "H265" && (seen === "HEVC" || seen === "H265")) ||
					(want === "VP9" && seen === "VP9") ||
					(want === "AV1" && (seen === "AV1" || seen === "LIBAOM-AV1")),
				`rung ${rid}: video codec ${want} — ffprobe says ${probe.videoCodec}`,
			);
		} else {
			// A missing OBSERVATION is a SKIP, not silence: the expectation exists,
			// so a vanished check is the fifth quiet state this engine forbids.
			report.skip(
				`${rid}:codec`,
				"rendition",
				`ffprobe reported no video codec for this rung, so codec ${muxing.video.codec} could not be checked`,
			);
		}
	}
}

/**
 * RFC 6381 codec-string prefixes for each plan codec.
 * A manifest declares codecs as `avc1.640028` / `mp4a.40.2`; the plan
 * names a family. Matching is a case-insensitive prefix. An unknown plan codec
 * returns an empty list, and the caller SKIPs rather than inventing a verdict.
 */
function rfcCodecPrefixes(codec: string): string[] {
	switch (codec) {
		case "H264":
			return ["avc1", "avc3"];
		case "H265":
			return ["hev1", "hvc1", "hevc"];
		case "VP9":
			return ["vp09", "vp9"];
		case "AV1":
			return ["av01"];
		case "OPUS":
			return ["opus"];
		case "AAC":
			return ["mp4a"]; // AAC-LC / HE / HEv2 all mp4a.40.*
		case "DD":
		case "AC3":
			return ["ac-3", "mp4a.a5"];
		case "DDPLUS":
		case "EAC3":
		case "DOLBY_ATMOS":
			return ["ec-3", "mp4a.a6"]; // Atmos rides E-AC-3 (JOC)
		default:
			return [];
	}
}

/** Whether an RFC 6381 codec string belongs to the plan codec's family. */
function rfcCodecMatches(rfc: string, codec: string): boolean {
	const prefixes = rfcCodecPrefixes(codec);
	if (prefixes.length === 0) {
		return false;
	}
	const lc = rfc.trim().toLowerCase();
	return prefixes.some((p) => lc.startsWith(p));
}

/**
 * The ffprobe `codec_name`(s) each plan audio codec must report (row 272). An
 * unknown plan codec returns undefined and the caller SKIPs.
 */
function ffprobeAudioCodecsOf(codec: string): string[] | undefined {
	switch (codec) {
		case "OPUS":
			return ["opus"];
		case "AAC":
			return ["aac"];
		case "DD":
		case "AC3":
			return ["ac3"];
		case "DDPLUS":
		case "EAC3":
			return ["eac3"];
		case "DOLBY_ATMOS":
			return ["eac3", "truehd"];
		default:
			return undefined;
	}
}

/**
 * The channel COUNT a Bitmovin `channelLayout` (CL_*) enum names (row 272), to
 * compare against ffprobe's `channels`. ffprobe reports a count, not the
 * vendor's layout name, so the layout is bound through its cardinality — enough
 * to catch "stereo delivered as 5.1" (2 vs 6), the audit's case. An enum this
 * map does not know (including NONE / passthrough) returns undefined and the
 * caller SKIPs rather than guessing.
 */
function channelCountFor(layout: string): number | undefined {
	const table: Record<string, number> = {
		MONO: 1,
		CL_MONO: 1,
		CL_STEREO: 2,
		CL_SURROUND: 3,
		CL_4_0: 4,
		CL_5_0_BACK: 5,
		CL_5_1_BACK: 6,
		XCL_5_1_BACK: 6,
		CL_QUAD: 4,
		CL_4_1: 5,
		CL_6_1: 7,
		CL_7_1: 8,
		CL_7_1_WIDE_BACK: 8,
	};
	return table[layout];
}

async function verifyMediaProperties(
	report: ReportBuilder,
	deps: EngineDeps,
	muxing: ExpectedMuxing,
	outputKey: string,
	/**
	 * The file to probe, as the ORDERED list of objects a player would assemble.
	 *
	 * One key for a self-contained file (progressive MP4, a TS segment); two for fMP4, where
	 * the init segment must precede the media segment. A bare `.m4s` carries `moof`+`mdat` and
	 * no `moov`, so ffprobe answers `Invalid data found when processing input` — which is not
	 * a corrupt artefact, it is an incomplete question. Nineteen scenarios FAILed that way on
	 * a real run, one of them a scenario whose bucket I had verified by hand and found perfect.
	 */
	keys: string[],
	options: { initOnly?: boolean } = {},
): Promise<void> {
	const id = `rendition:${muxing.renditionKey}`;
	const subject = keys[keys.length - 1] ?? "(nothing)";
	let probe: MediaProbe;
	try {
		const path = await deps.fetchConcatenated(outputKey, keys);
		probe = await deps.probe(path);
	} catch (err) {
		report.fail(
			id,
			"rendition",
			`could not probe ${subject}${keys.length > 1 ? ` (with ${keys[0]})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	if (muxing.video) {
		if (muxing.video.width !== undefined && !muxing.perTitle) {
			report.assert(
				`${id}:width`,
				"rendition",
				probe.width === muxing.video.width,
				`width ${muxing.video.width} — ${probe.width ?? "none"}`,
			);
		}
		const wantHeight = muxing.video.height;
		if (wantHeight === null || muxing.perTitle) {
			// Per-title heights are algorithmic (C1/C4): assert presence and sanity,
			// never a plan value the plan deliberately left out.
			report.assert(
				`${id}:height`,
				"rendition",
				(probe.height ?? 0) > 0,
				`per-title rung must carry a real height — ${probe.height ?? "none"}`,
			);
		} else {
			report.assert(
				`${id}:height`,
				"rendition",
				probe.height === wantHeight,
				`height ${wantHeight} — ${probe.height ?? "none"}`,
			);
		}
		if (probe.videoCodec) {
			const want = muxing.video.codec;
			const seen = probe.videoCodec.toUpperCase();
			const matches =
				(want === "H264" && seen === "H264") ||
				(want === "H265" && (seen === "HEVC" || seen === "H265")) ||
				(want === "VP9" && seen === "VP9") ||
				(want === "AV1" && (seen === "AV1" || seen === "LIBAOM-AV1"));
			report.assert(
				`${id}:codec`,
				"rendition",
				matches,
				`video codec ${want} — ffprobe says ${probe.videoCodec}`,
			);
		} else {
			// A missing OBSERVATION is a SKIP, not silence: the expectation exists,
			// so a vanished check is the fifth quiet state this engine forbids.
			report.skip(
				`${id}:codec`,
				"rendition",
				`ffprobe reported no video codec, so codec ${muxing.video.codec} could not be checked`,
			);
		}
		// An init segment carries no media bitrate; only score it on a real payload.
		const wantBitrate = muxing.video.bitrate;
		// `=== undefined`, not truthiness. A **zero** bitrate used to suppress its own
		// check — the degenerate-output pathology §9b already names, with the defect
		// deleting the very assertion that would have caught it. A real 0 now reaches the
		// band and WARNs.
		//
		// Only the third conjunct is the dangerous kind, and that is why my own static
		// sweep missed this site and reported four instances instead of five: it
		// classified the guard by its FIRST conjunct. `!options.initOnly` and
		// `wantBitrate !== null` are structural and plan-side — nothing is owed when they
		// are false. `probe.bitrateBps` is supplied by the artefact under test.
		if (!options.initOnly && wantBitrate !== null) {
			if (probe.bitrateBps === undefined) {
				report.skip(
					`${id}:bitrate`,
					"rendition",
					`the plan targets ${wantBitrate} bps but ffprobe reported no bitrate, so it could not be scored`,
				);
			} else {
				const ratio = probe.bitrateBps / wantBitrate;
				const inBand = ratio >= BITRATE_LOW && ratio <= BITRATE_HIGH;
				report.add(
					`${id}:bitrate`,
					"rendition",
					inBand ? "PASS" : "WARN",
					`bitrate within [${BITRATE_LOW}×, ${BITRATE_HIGH}×] of ${wantBitrate} — measured ${probe.bitrateBps} (${ratio.toFixed(2)}×)`,
				);
			}
		}
		// Only when there IS an expectation. My first version of this `else` fired whenever
		// either side was undefined, so a plan that pins no frame rate — most of them —
		// emitted `the plan pins undefined fps`, which the very first real run printed. A
		// SKIP for a check that has no expectation is noise, and noise is what gets a report
		// ignored; the rule is narrower than "never be silent". It is "never be silent about
		// something you were going to check".
		/**
		 * NOT on an init segment. An init segment carries a sample ENTRY and no samples, so
		 * ffprobe has no frame durations to average — it reports the track's TIMESCALE as the
		 * rate. The first real corpus run said `fps 25 — 25000` on two scenarios: 25000 is the
		 * timescale of a 25fps track, not a frame rate, and the plan was right all along.
		 *
		 * `initOnly` already suppressed the bitrate check for the same reason (an init segment
		 * carries no media payload) and fps belongs in exactly that category. Only a real run
		 * could surface it: every fixture test hands the probe a synthetic fps.
		 */
		if (!options.initOnly && muxing.video.fps !== undefined) {
			if (probe.fps !== undefined) {
				report.assert(
					`${id}:fps`,
					"rendition",
					Math.abs(probe.fps - muxing.video.fps) < 0.02,
					`fps ${muxing.video.fps} — ${probe.fps}`,
				);
			} else {
				report.skip(
					`${id}:fps`,
					"rendition",
					`the plan pins ${muxing.video.fps} fps but ffprobe reported none, so it could not be checked`,
				);
			}
		} else if (options.initOnly && muxing.video.fps !== undefined) {
			// Emitted, so the id set does not change shape with the file being probed — the
			// no-silence invariant applies to this axis too.
			report.skip(
				`${id}:fps`,
				"rendition",
				`an init segment has no frames, so its ${muxing.video.fps} fps target cannot be measured there — ffprobe reports the track timescale instead`,
			);
		}
	}

	if (muxing.audio) {
		const audio = muxing.audio;
		report.assert(
			`${id}:audio-present`,
			"rendition",
			probe.audioCodec !== undefined,
			`audio stream expected (${audio.codec}) — ${probe.audioCodec ?? "none"}`,
		);
		// CODEC equality, not just presence: a
		// muxing carrying SOME audio in the WRONG codec passed on `:audio-present`
		// alone. Emitted as assert-or-skip so the id is a function of the plan, not
		// of what ffprobe happened to read.
		{
			const want = ffprobeAudioCodecsOf(audio.codec);
			if (probe.audioCodec === undefined) {
				report.skip(
					`${id}:audio-codec`,
					"rendition",
					`ffprobe reported no audio codec, so ${audio.codec} could not be checked`,
				);
			} else if (want === undefined) {
				report.skip(
					`${id}:audio-codec`,
					"rendition",
					`no ffprobe codec name is mapped for plan audio codec ${audio.codec}, so it was not asserted`,
				);
			} else {
				report.assert(
					`${id}:audio-codec`,
					"rendition",
					want.includes(probe.audioCodec.toLowerCase()),
					`audio codec ${audio.codec} (${want.join("/")}) — ffprobe says ${probe.audioCodec}`,
				);
			}
		}
		// BITRATE within a band, a FAIL outside it (row 272). 128k delivered at
		// 64k is ratio 0.5 — below AUDIO_BITRATE_LOW.
		if (probe.audioBitrateBps === undefined) {
			report.skip(
				`${id}:audio-bitrate`,
				"rendition",
				`the plan targets ${audio.bitrate} bps but ffprobe reported no audio bitrate, so it could not be scored`,
			);
		} else {
			const ratio = probe.audioBitrateBps / audio.bitrate;
			report.assert(
				`${id}:audio-bitrate`,
				"rendition",
				ratio >= AUDIO_BITRATE_LOW && ratio <= AUDIO_BITRATE_HIGH,
				`audio bitrate within [${AUDIO_BITRATE_LOW}×, ${AUDIO_BITRATE_HIGH}×] of ${audio.bitrate} — measured ${probe.audioBitrateBps} (${ratio.toFixed(2)}×)`,
			);
		}
		if (probe.audioSampleRate !== undefined) {
			report.assert(
				`${id}:audio-rate`,
				"rendition",
				probe.audioSampleRate === audio.sampleRate,
				`sample rate ${audio.sampleRate} — ${probe.audioSampleRate}`,
			);
		} else {
			// A missing OBSERVATION is a SKIP, not silence: the expectation exists,
			// so a vanished check is the fifth quiet state this engine forbids.
			report.skip(
				`${id}:audio-rate`,
				"rendition",
				`ffprobe reported no audio sample rate, so ${audio.sampleRate} could not be checked`,
			);
		}
		// CHANNEL LAYOUT through its cardinality (row 272): stereo delivered as 5.1
		// is 2 vs 6. Gated on the plan pinning a layout — a plan gate, so the id set
		// stays a function of the plan.
		if (audio.channelLayout !== undefined) {
			const wantChannels = channelCountFor(audio.channelLayout);
			if (wantChannels === undefined) {
				report.skip(
					`${id}:audio-channels`,
					"rendition",
					`channel layout ${audio.channelLayout} has no known channel count, so it was not asserted`,
				);
			} else if (probe.audioChannels === undefined) {
				report.skip(
					`${id}:audio-channels`,
					"rendition",
					`ffprobe reported no channel count, so layout ${audio.channelLayout} (${wantChannels}ch) could not be checked`,
				);
			} else {
				report.assert(
					`${id}:audio-channels`,
					"rendition",
					probe.audioChannels === wantChannels,
					`layout ${audio.channelLayout} = ${wantChannels} channel(s) — ffprobe says ${probe.audioChannels}`,
				);
			}
		}
	}
}

/** `dir/../x` → the key a player would request; keys never start with "/". */
export function resolveReferencedKey(dir: string, uri: string): string {
	const parts: string[] = [];
	for (const part of `${dir}${uri}`.split("/")) {
		if (part === "" || part === ".") {
			continue;
		}
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}

/**
 * Media-byte CLOSURE . The walk
 * used to COUNT `#EXTINF` lines and never touch what they named, so a
 * missing or empty init/media object behind a correct playlist stayed green.
 * Every object a playlist references must exist under the manifest's prefix
 * with bytes, must not be foreign (older than this job / outside the declared
 * population), and the ORDERED assembly a player would make must decode.
 * Assemblies beyond MAX_FULL_ASSEMBLY objects are sampled (init + first,
 * middle, last) and the detail says so — bounded, never silent.
 */
const MAX_FULL_ASSEMBLY = 200;
async function verifyMediaClosure(
	report: ReportBuilder,
	deps: EngineDeps,
	outputKey: string,
	listing: Map<string, number | undefined>,
	idPrefix: string,
	referenced: { mapKey?: string; segmentKeys: string[] },
): Promise<void> {
	const keys = [
		...(referenced.mapKey ? [referenced.mapKey] : []),
		...referenced.segmentKeys,
	];
	const missing = keys.filter((k) => !listing.has(k));
	const empty = keys.filter(
		(k) => listing.has(k) && (listing.get(k) ?? 0) === 0,
	);
	const foreign = keys.filter(
		(k) =>
			listing.has(k) &&
			deps.foreignKeyFilter?.(k, { key: k, size: listing.get(k) }) === true,
	);
	const closed =
		keys.length > 0 &&
		missing.length === 0 &&
		empty.length === 0 &&
		foreign.length === 0;
	const first = (list: string[]) => (list[0] ? ` (first ${list[0]})` : "");
	report.assert(
		`${idPrefix}:media-closure`,
		"manifest",
		closed,
		`${keys.length} referenced object(s) (${referenced.mapKey ? "init + " : ""}${referenced.segmentKeys.length} segment(s)) — ${missing.length} missing${first(missing)}, ${empty.length} empty${first(empty)}, ${foreign.length} foreign${first(foreign)}`,
	);
	if (!closed) {
		report.skip(
			`${idPrefix}:media-decodes`,
			"manifest",
			"not assembled — the closure above failed, so the assembly would be of the wrong objects",
		);
		return;
	}
	const sampled = keys.length > MAX_FULL_ASSEMBLY;
	const segs = referenced.segmentKeys;
	const assembly = sampled
		? [
				...(referenced.mapKey ? [referenced.mapKey] : []),
				...[
					segs[0],
					segs[Math.floor(segs.length / 2)],
					segs[segs.length - 1],
				].filter((k): k is string => k !== undefined),
			]
		: keys;
	try {
		const path = await deps.fetchConcatenated(outputKey, assembly);
		const probe = await deps.probe(path);
		// Decoded = ffprobe saw frames, a duration or a frame rate — or, for an
		// audio-only assembly, a codec with a sample rate (audio segments carry
		// no frame rate).
		const decodes =
			(probe.nbFrames ?? 0) > 0 ||
			(probe.durationSec ?? 0) > 0 ||
			(probe.fps ?? 0) > 0 ||
			(probe.audioCodec !== undefined && (probe.audioSampleRate ?? 0) > 0);
		report.assert(
			`${idPrefix}:media-decodes`,
			"manifest",
			decodes,
			`the ordered assembly of ${assembly.length} referenced object(s)${sampled ? ` (sampled of ${keys.length})` : ""} decodes — ${decodes ? "frames present" : "no frames, duration or fps"}`,
		);
	} catch (err) {
		report.fail(
			`${idPrefix}:media-decodes`,
			"manifest",
			`could not fetch or probe the referenced assembly: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** `WxH` → H, the height a player selects on. */
function resolutionHeight(resolution: string | undefined): number | undefined {
	if (resolution === undefined) {
		return undefined;
	}
	const m = /^(\d+)x(\d+)$/.exec(resolution.trim());
	return m ? Number(m[2]) : undefined;
}

/** The plan's video families, in the order a token is matched against them. */
const VIDEO_FAMILIES = ["H264", "H265", "VP9", "AV1"] as const;
const AUDIO_FAMILIES = ["AAC", "DD", "DDPLUS", "DOLBY_ATMOS"] as const;

/** The plan video family an RFC 6381 token belongs to, if any. */
function videoFamilyOf(token: string): string | undefined {
	return VIDEO_FAMILIES.find((f) => rfcCodecMatches(token, f));
}
function isAudioToken(token: string): boolean {
	return AUDIO_FAMILIES.some((f) => rfcCodecMatches(token, f));
}
function codecTokens(codecs: string | undefined): string[] {
	return (codecs ?? "")
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

/**
 * A declared-but-wrong attribute must never beat a fully matching row merely
 * because its BANDWIDTH is closer. Missing evidence ranks between exact and
 * contradictory evidence so it can still bind (and produce an explicit SKIP)
 * when it is the only row available.
 */
const ATTRIBUTE_RANK_STRIDE =
	Math.max(MAX_NORMALIZED_BITRATE_COST, UNKNOWN_BITRATE_COST) + 1;
function attributeRankCost(
	checks: { observed: unknown; matches: boolean }[],
): number {
	return checks.reduce(
		(total, check) =>
			total +
			(check.observed === undefined
				? ATTRIBUTE_RANK_STRIDE
				: check.matches
					? 0
					: ATTRIBUTE_RANK_STRIDE * 2),
		0,
	);
}

/**
 * What the engine knows about a manifest beyond its topology (row 284).
 */
export type TopologyContext = {
	hlsAudioGroups?: ExpectedManifest["hlsAudioGroups"];
	/** The manifest's video ladder is encoder-chosen (`ExpectedManifest.perTitle`). */
	perTitle: boolean;
	/** The per-title RESULT population's families, when the caller captured them. */
	perTitleActual?: PerTitleActualVideoFamilies;
};

/**
 * The families a manifest's UNBOUND video rows enumerate — the per-title rungs
 * after every fixed node has consumed its row — read as the OBSERVED side of the
 * comparison below. Tokens that name no plan family at all are carried
 * separately: they are a verdict, not a family.
 */
function manifestVideoFamilies(rows: { codecs?: string }[]): {
	families: Set<string>;
	unrecognised: string[];
	rows: number;
	rowsWithCodecs: number;
} {
	const families = new Set<string>();
	const unrecognised: string[] = [];
	let rowsWithCodecs = 0;
	for (const row of rows) {
		if (row.codecs === undefined) {
			continue;
		}
		rowsWithCodecs += 1;
		for (const token of codecTokens(row.codecs)) {
			const family = videoFamilyOf(token);
			if (family !== undefined) {
				families.add(family);
			} else if (!isAudioToken(token)) {
				unrecognised.push(token);
			}
		}
	}
	return { families, unrecognised, rows: rows.length, rowsWithCodecs };
}

/**
 * Per-title manifests: the declared / actual / manifest family comparison.
 * The plan declares which families its
 * templates carry; the provider's RESULT capture says which it produced; the
 * manifest says which it enumerates. All three must agree — and when the
 * capture is absent or incomplete the verdict is an explicit UNVERIFIED (SKIP)
 * that names why, never an empty-set FAIL and never a PASS. The manifest is
 * only ever the observed side: nothing here reads a family off the master or
 * MPD and hands it back as the expectation.
 */
function verifyPerTitleVideoFamilies(
	report: ReportBuilder,
	id: string,
	declared: readonly string[],
	manifest: ReturnType<typeof manifestVideoFamilies>,
	actual: PerTitleActualVideoFamilies | undefined,
): void {
	const cid = `${id}:pertitle-video-families`;
	const fmt = (xs: Iterable<string>) => {
		const sorted = [...xs].sort();
		return sorted.length > 0 ? sorted.join("+") : "none";
	};
	const seen = `declared ${fmt(declared)}; manifest ${fmt(manifest.families)}${
		manifest.unrecognised.length > 0
			? ` (+ unrecognised ${manifest.unrecognised.join(", ")})`
			: ""
	}`;
	if (
		(manifest.unrecognised.length > 0 ||
			[...manifest.families].some((family) => !declared.includes(family))) &&
		(actual?.status !== "complete" || manifest.rowsWithCodecs < manifest.rows)
	) {
		report.fail(
			cid,
			"manifest",
			`The manifest declares a video codec outside the selected templates; ${seen}`,
		);
		return;
	}
	if (actual === undefined) {
		report.skip(
			cid,
			"manifest",
			`UNVERIFIED — no per-title RESULT capture was handed to the verifier, so the actual family set is unknown; ${seen}`,
		);
		return;
	}
	if (actual.status !== "complete") {
		report.skip(cid, "manifest", `UNVERIFIED — ${actual.reason}; ${seen}`);
		return;
	}
	if (manifest.rowsWithCodecs < manifest.rows) {
		report.skip(
			cid,
			"manifest",
			`UNVERIFIED — only ${manifest.rowsWithCodecs} of ${manifest.rows} per-title video row(s) declare codecs, so the full family set cannot be read; RESULT ${fmt(actual.families)}; ${seen}`,
		);
		return;
	}
	const actualSet = new Set(actual.families);
	const withinDeclared = [...actualSet].every((f) => declared.includes(f));
	const equal =
		actualSet.size === manifest.families.size &&
		[...actualSet].every((f) => manifest.families.has(f));
	const why = !equal
		? " — the manifest enumerates a different family set than the provider produced"
		: !withinDeclared
			? " — the provider produced a family the plan never declared"
			: manifest.unrecognised.length > 0
				? " — the manifest carries a video codec no plan family names"
				: "";
	report.assert(
		cid,
		"manifest",
		equal && withinDeclared && manifest.unrecognised.length === 0,
		`per-title video families agree three ways — ${seen}; RESULT ${fmt(actualSet)} (${actual.results} stream(s))${why}`,
	);
}

/** Provider-chosen playlist names are observed identities, bound to declared media writers. */
async function bindDefaultHlsTopology(
	report: ReportBuilder,
	id: string,
	manifest: ExpectedManifest,
	parsed: ParsedHls,
	deps: EngineDeps,
	muxings: readonly ExpectedMuxing[],
): Promise<void> {
	const selection = manifest.hlsDefault;
	if (!selection) return;
	const root = new URL("https://manifest-storage.invalid/");
	const children = new Map<string, ParsedHls | undefined>();
	const childKeys = new Map<string, string>();
	const child = async (uri: string): Promise<ParsedHls | undefined> => {
		if (!children.has(uri)) {
			try {
				const key = referencedObjectKey(
					uri,
					storageObjectUrl(
						root,
						`${manifest.dir.prefix}${manifest.files[0] ?? "stream.m3u8"}`,
					),
					root,
				);
				if (key === undefined)
					throw new Error("The generated child has no local storage identity");
				childKeys.set(uri, key);
				children.set(
					uri,
					await deps.parseHls(await deps.readText(manifest.outputKey, key)),
				);
			} catch {
				children.set(uri, undefined);
			}
		}
		return children.get(uri);
	};
	type Track = (typeof selection.tracks)[number];
	type Writer = Track["resources"][number] & {
		actualWriterId?: string;
		resultStreamId?: string;
	};
	type WriterBinding = Check & {
		writerIdentity?: string;
		muxingKey?: string;
		resultStreamId?: string;
	};
	const writerListings = new Map<string, Promise<ObjectEntry[]>>();
	const writerObjects = (resource: Writer) => {
		const key = JSON.stringify([manifest.outputKey, resource.directory]);
		let listing = writerListings.get(key);
		if (!listing) {
			listing = deps
				.listAll(manifest.outputKey, resource.directory)
				.then((objects) =>
					objects.filter(
						(object) => deps.foreignKeyFilter?.(object.key, object) !== true,
					),
				);
			writerListings.set(key, listing);
		}
		return listing;
	};
	const resources = (track: Track): Writer[] => {
		if (!track.perTitle) return track.resources;
		const population = deps.perTitlePopulations;
		const outputId = deps.providerOutputIds?.[manifest.outputKey];
		if (population?.status !== "complete" || !outputId) return [];
		return population.deliveryMuxings
			.filter(
				(muxing) =>
					muxing.templateRendition === track.renditionKey &&
					population.results.some(
						(result) =>
							result.streamId === muxing.streamId &&
							result.templateRendition === track.renditionKey,
					),
			)
			.flatMap((muxing) =>
				muxing.legs
					.filter((leg) => leg.outputId === outputId)
					.flatMap((leg) =>
						track.resources
							.filter(
								(resource) =>
									resource.container === muxing.muxingType.toUpperCase() &&
									(resource.drmKey
										? leg.drmId !== undefined
										: leg.drmId === undefined),
							)
							.map((resource) => ({
								...resource,
								directory: leg.resolvedPath,
								actualWriterId: `${muxing.streamId}:${muxing.muxingId}:${leg.drmId ?? "clear"}:${leg.outputId}`,
								resultStreamId: muxing.streamId,
								...(muxing.filename ? { filename: muxing.filename } : {}),
							})),
					),
			);
	};
	const binding = async (
		track: Track,
		uri: string,
		candidate?: Writer,
	): Promise<WriterBinding> => {
		const playlist = await child(uri);
		if (!playlist)
			return {
				id: "",
				area: "manifest" as const,
				verdict: "FAIL" as const,
				detail:
					"The provider-selected child playlist could not be read and parsed",
			};
		const candidates = candidate ? [candidate] : resources(track);
		if (track.perTitle && !candidates.length)
			return {
				id: "",
				area: "manifest" as const,
				verdict: "SKIP" as const,
				detail:
					"UNVERIFIED — selected Per-Title writer identities need attributed RESULT output legs and provider output IDs",
			};
		const checks = await Promise.all(
			candidates.map(async (resource) => {
				const bound = bindHlsVideoReferences("", { resource }, playlist, {
					outputKey: manifest.outputKey,
					playlist: storageObjectUrl(root, childKeys.get(uri) ?? ""),
					storageRoot: root,
				});
				let check = bound.check;
				if (check.verdict === "PASS") {
					try {
						check = checkHlsReferenceObjects(
							"",
							bound.objects,
							await writerObjects(resource),
						);
					} catch {
						check = {
							id: "",
							area: "manifest",
							verdict: "FAIL",
							detail:
								"The selected HLS writer's complete object listing could not be read",
						};
					}
				}
				return {
					...check,
					writerIdentity:
						resource.actualWriterId ??
						JSON.stringify([
							resource.muxingKey,
							resource.drmKey,
							resource.outputKey,
							resource.directory,
						]),
					muxingKey: resource.muxingKey,
					resultStreamId: resource.resultStreamId,
				};
			}),
		);
		const passed = checks.filter((check) => check.verdict === "PASS");
		if (new Set(passed.map((check) => check.writerIdentity)).size > 1)
			return {
				id: "",
				area: "manifest",
				verdict: "SKIP",
				detail:
					"UNVERIFIED — child references match multiple selected writer identities",
			};
		return (
			passed[0] ??
			checks.find((check) => check.verdict === "SKIP") ?? {
				id: "",
				area: "manifest",
				verdict: "FAIL",
				detail:
					"The generated child does not reference a media writer selected by this encoding",
			}
		);
	};
	const unique = <T extends { uri: string }>(rows: T[]) => [
		...new Map(rows.map((row) => [row.uri, row])).values(),
	];
	const hasVideoCodec = (codecs: string | undefined) =>
		codecTokens(codecs).some((token) => videoFamilyOf(token) !== undefined);
	const videoRows = unique(
		parsed.variants.filter(
			(row) =>
				row.resolution !== undefined ||
				hasVideoCodec(row.codecs) ||
				(row.codecs === undefined &&
					selection.tracks.some((track) => track.kind === "video")),
		),
	);
	const audioRows = unique([
		...parsed.media.flatMap((row) =>
			row.type === "AUDIO" && row.uri ? [{ ...row, uri: row.uri }] : [],
		),
		...parsed.variants.filter(
			(row) =>
				row.resolution === undefined &&
				row.codecs !== undefined &&
				codecTokens(row.codecs).every(isAudioToken),
		),
	]);
	const textRows = unique(
		parsed.media.flatMap((row) =>
			row.type === "SUBTITLES" && row.uri ? [{ ...row, uri: row.uri }] : [],
		),
	);
	const actual = scopedPerTitleVideoFamilies(
		deps.perTitlePopulations,
		selection.perTitleSelection,
	);
	const selectedResults = scopedPerTitleResults(
		deps.perTitlePopulations,
		selection.perTitleSelection,
	);
	const population = deps.perTitlePopulations;
	const capturedVideoMaximum =
		selectedResults.status === "complete" && population?.status === "complete"
			? selection.tracks
					.filter((track) => track.kind === "video")
					.reduce(
						(total, track) =>
							total +
							track.resources.length *
								(track.perTitle
									? population.results.filter(
											(result) =>
												result.templateRendition === track.renditionKey,
										).length
									: 1),
						0,
					)
			: undefined;
	for (const [kind, rows] of [
		["audio", audioRows],
		["text", textRows],
	] as const) {
		const bound = selection.counts[kind];
		const minimum = bound.min;
		const maximum = bound.max;
		report.assert(
			`${id}:default-${kind}-count`,
			"manifest",
			rows.length >= minimum &&
				(maximum === undefined || rows.length <= maximum),
			`${kind} playlists from encoding ${selection.encodingKey}: expected ${minimum}${maximum === minimum ? "" : `–${maximum ?? "encoder-selected"}`}, observed ${rows.length}`,
		);
	}
	const variantIdentities = parsed.variants.map((row) =>
		JSON.stringify([
			row.uri,
			row.audio,
			row.resolution,
			row.codecs,
			row.bandwidth,
		]),
	);
	report.assert(
		`${id}:default-variants-duplicate`,
		"manifest",
		new Set(variantIdentities).size === variantIdentities.length,
		"A Default HLS master must not repeat an identical variant row",
	);
	for (const [index, reason] of selection.unverified.entries())
		report.skip(
			`${id}:default-selection:${index}`,
			"manifest",
			`UNVERIFIED — ${reason}`,
		);
	const checkVideoAttributes = (track: Track, cid: string, uri: string) => {
		for (const [index, row] of parsed.variants
			.filter((row) => row.uri === uri)
			.entries()) {
			const vid = `${cid}:row:${index}`;
			if (!track.perTitle && track.height !== undefined) {
				if (row.resolution === undefined)
					report.skip(
						`${vid}:resolution`,
						"manifest",
						"The generated variant declares no resolution",
					);
				else
					report.assert(
						`${vid}:resolution`,
						"manifest",
						resolutionHeight(row.resolution) === track.height,
						`Video height ${track.height} — ${row.resolution}`,
					);
			}
			if (!track.perTitle && track.width !== undefined) {
				if (row.resolution === undefined)
					report.skip(
						`${vid}:width`,
						"manifest",
						"The generated variant declares no resolution",
					);
				else
					report.assert(
						`${vid}:width`,
						"manifest",
						Number(row.resolution.split("x")[0]) === track.width,
						`Video width ${track.width} — ${row.resolution}`,
					);
			}
			if (row.codecs === undefined)
				report.skip(
					`${vid}:codec`,
					"manifest",
					"The generated variant declares no codecs",
				);
			else
				report.assert(
					`${vid}:codec`,
					"manifest",
					codecTokens(row.codecs).some((token) =>
						rfcCodecMatches(token, track.codec),
					),
					`Video codec ${track.codec} — ${row.codecs}`,
				);
			if (!track.perTitle && track.bitrate !== undefined) {
				if (row.bandwidth === undefined)
					report.skip(
						`${vid}:bandwidth`,
						"manifest",
						"The generated variant declares no bandwidth",
					);
				else {
					const ratio = row.bandwidth / track.bitrate;
					report.assert(
						`${vid}:bandwidth`,
						"manifest",
						ratio >= HLS_BANDWIDTH_LOW && ratio <= HLS_BANDWIDTH_HIGH,
						`Variant bandwidth ${row.bandwidth} must match the declared video target ${track.bitrate} plus audio and overhead`,
					);
				}
			}
		}
	};
	const boundWriters = new Map<
		string,
		{ source: WriterBinding; track: Track }
	>();
	const matchTracks = async (
		kind: "video" | "audio",
		rows: { uri: string; language?: string }[],
	) => {
		const tracks = selection.tracks.filter(
			(track) => track.kind === kind && !track.perTitle,
		);
		const nodes = tracks.flatMap((track) =>
			track.resources.map((resource, index) => ({
				key: `${track.renditionKey}:${index}`,
				track,
				resource,
			})),
		);
		const checks = new Map<string, WriterBinding>();
		for (const node of nodes)
			for (const row of rows)
				checks.set(
					`${node.key}\u0000${row.uri}`,
					await binding(node.track, row.uri, node.resource),
				);
		const matched = matchOneToOne({
			expected: nodes,
			observed: rows,
			expectedKey: (node) => node.key,
			observedKey: (row) => row.uri,
			compatible: (node, row) => {
				const check = checks.get(`${node.key}\u0000${row.uri}`);
				return check !== undefined && check.verdict !== "FAIL";
			},
			cost: () => 0,
		});
		for (const track of tracks)
			report.assert(
				`${id}:default-${kind}:${track.renditionKey}:0:present`,
				"manifest",
				matched.pairs.some(
					(pair) => pair.expected.track.renditionKey === track.renditionKey,
				),
				`Selected encoding track ${track.renditionKey} must be referenced by a generated ${kind} playlist`,
			);
		for (const node of nodes) {
			const pair = matched.pairs.find(
				(entry) => entry.expected.key === node.key,
			);
			const cid = `${id}:default-${kind}:${node.key}`;
			if (!pair) continue;
			const source = checks.get(`${node.key}\u0000${pair.observed.uri}`);
			if (source) {
				boundWriters.set(`${kind}:${pair.observed.uri}`, {
					source,
					track: node.track,
				});
				report.add(
					`${cid}:writer`,
					"manifest",
					source.verdict,
					source.detail.replaceAll("VIDEO", kind),
				);
			}
			if (kind === "audio" && node.track.language !== undefined)
				report.assert(
					`${cid}:language`,
					"manifest",
					pair.observed.language === node.track.language,
					`Audio language ${node.track.language} — ${pair.observed.language ?? "absent"}`,
				);
			if (kind === "video")
				checkVideoAttributes(node.track, cid, pair.observed.uri);
		}
		return matched.unmatchedObserved;
	};
	const remainingVideo = await matchTracks("video", videoRows);
	const remainingAudio = await matchTracks("audio", audioRows);
	const perTitleTracks = selection.tracks.filter(
		(track) => track.perTitle && track.kind === "video",
	);
	if (
		population?.status === "complete" &&
		population.results.every((result) => result.templateRendition !== undefined)
	)
		for (const track of perTitleTracks.filter(
			(track) => track.mode !== "PER_TITLE_TEMPLATE",
		))
			report.assert(
				`${id}:default-video-required:${track.renditionKey}`,
				"manifest",
				population.results.some(
					(result) => result.templateRendition === track.renditionKey,
				),
				`Fixed Per-Title template ${track.renditionKey} must produce a captured RESULT`,
			);
	for (const [index, row] of remainingVideo.entries()) {
		const checks = await Promise.all(
			selection.tracks
				.filter((track) => track.kind === "video")
				.map(async (track) => ({
					track,
					source: await binding(track, row.uri),
				})),
		);
		const matched =
			checks.find(({ source }) => source.verdict === "PASS") ??
			checks.find(({ source }) => source.verdict === "SKIP");
		if (matched) {
			boundWriters.set(`video:${row.uri}`, matched);
			report.add(
				`${id}:default-video-result:${index}:writer`,
				"manifest",
				matched.source.verdict,
				matched.source.detail,
			);
			if (!matched.track.perTitle || matched.source.verdict === "PASS")
				checkVideoAttributes(
					matched.track,
					`${id}:default-video-alias:${index}`,
					row.uri,
				);
		} else
			report.fail(
				`${id}:default-video-result:${index}:writer`,
				"manifest",
				"A generated video playlist belongs to no selected fixed or Per-Title media writer",
			);
	}
	const writers = videoRows.map(
		(row) => boundWriters.get(`video:${row.uri}`)?.source,
	);
	const minimum =
		selectedResults.status === "complete"
			? selection.tracks.filter(
					(track) => track.kind === "video" && !track.perTitle,
				).length + selectedResults.results.length
			: selection.counts.video.min;
	const maximum = capturedVideoMaximum ?? selection.counts.video.max;
	if (
		writers.every(
			(writer) =>
				writer?.verdict === "PASS" && writer.writerIdentity !== undefined,
		)
	) {
		const count = new Set(writers.map((writer) => writer?.writerIdentity)).size;
		report.assert(
			`${id}:default-video-count`,
			"manifest",
			count >= minimum && (maximum === undefined || count <= maximum),
			`Selected video writers from encoding ${selection.encodingKey}: expected ${minimum}${maximum === minimum ? "" : `–${maximum ?? "encoder-selected"}`}, observed ${count}`,
		);
	} else if (videoRows.length < selection.counts.video.min)
		report.fail(
			`${id}:default-video-count`,
			"manifest",
			"The generated master omits selected video tracks",
		);
	else
		report.skip(
			`${id}:default-video-count`,
			"manifest",
			"UNVERIFIED — video writer identities are incomplete or ambiguous, so variant aliases cannot establish a rung count",
		);
	if (selectedResults.status === "complete") {
		const covered = new Set(
			writers.flatMap((writer) =>
				writer?.verdict === "PASS" && writer.resultStreamId
					? [writer.resultStreamId]
					: [],
			),
		);
		for (const result of selectedResults.results) {
			const cid = `${id}:default-video-result:${result.streamId}:present`;
			if (
				!covered.has(result.streamId) &&
				writers.some((writer) => writer?.verdict === "SKIP")
			)
				report.skip(
					cid,
					"manifest",
					`UNVERIFIED — generated video writer provenance cannot establish whether RESULT ${result.streamId} is present`,
				);
			else
				report.assert(
					cid,
					"manifest",
					covered.has(result.streamId),
					`Selected RESULT ${result.streamId} must have a generated video playlist; alternative containers cannot replace another RESULT`,
				);
		}
	}
	const associations = new Set<string>();
	let duplicateAssociation = false,
		unverifiedAssociation = false;
	for (const [index, row] of parsed.variants
		.filter((variant) => videoRows.some((video) => video.uri === variant.uri))
		.entries()) {
		const writer = boundWriters.get(`video:${row.uri}`)?.source;
		let audioIdentity: string | undefined = "self-contained";
		let audioCodecs: string[] = [];
		if (row.audio !== undefined) {
			const media = parsed.media.filter(
				(entry) => entry.type === "AUDIO" && entry.groupId === row.audio,
			);
			const audio = media.map((entry) =>
				entry.uri ? boundWriters.get(`audio:${entry.uri}`) : undefined,
			);
			audioIdentity =
				media.length &&
				audio.every(
					(bound) =>
						bound?.source.verdict === "PASS" &&
						bound.source.writerIdentity !== undefined,
				)
					? [...new Set(audio.map((bound) => bound?.source.writerIdentity))]
							.sort()
							.join("|")
					: undefined;
			if (audioIdentity !== undefined)
				audioCodecs = audio.flatMap((bound) =>
					bound ? [bound.track.codec] : [],
				);
		} else if (writer?.verdict === "PASS" && writer.muxingKey !== undefined) {
			const muxing = muxings.find((row) => row.muxingKey === writer.muxingKey);
			if (muxing?.audio) audioCodecs = [muxing.audio.codec];
			else if (selection.tracks.some((track) => track.kind === "audio"))
				report.fail(
					`${id}:default-video-audio:${index}`,
					"manifest",
					"The selected video writer carries no audio and its variant references no selected audio group",
				);
		}
		if (audioCodecs.length) {
			if (row.codecs === undefined)
				report.skip(
					`${id}:default-video-audio:${index}:codecs`,
					"manifest",
					"UNVERIFIED — the generated variant declares no audio codecs",
				);
			else
				report.assert(
					`${id}:default-video-audio:${index}:codecs`,
					"manifest",
					audioCodecs.every((codec) =>
						codecTokens(row.codecs).some((token) =>
							rfcCodecMatches(token, codec),
						),
					),
					`The variant audio codecs must match its selected audio writers (${[...new Set(audioCodecs)].join(", ")}) — ${row.codecs}`,
				);
		}
		if (
			writer?.verdict !== "PASS" ||
			writer.writerIdentity === undefined ||
			audioIdentity === undefined
		) {
			unverifiedAssociation = true;
			continue;
		}
		const identity = `${writer.writerIdentity}\u0000${audioIdentity}`;
		if (associations.has(identity)) duplicateAssociation = true;
		associations.add(identity);
	}
	if (duplicateAssociation)
		report.fail(
			`${id}:default-video-associations`,
			"manifest",
			"A selected video writer and audio-writer association is repeated under multiple variant aliases",
		);
	else if (unverifiedAssociation)
		report.skip(
			`${id}:default-video-associations`,
			"manifest",
			"UNVERIFIED — video or audio-group writer provenance cannot prove distinct variant associations",
		);
	else
		report.pass(
			`${id}:default-video-associations`,
			"manifest",
			"Every video writer and trusted audio-writer association is distinct; separate audio choices remain valid",
		);
	report.assert(
		`${id}:default-audio-unexpected`,
		"manifest",
		remainingAudio.length === 0,
		"Every generated audio playlist must bind to a selected audio writer",
	);
	if (perTitleTracks.length)
		verifyPerTitleVideoFamilies(
			report,
			id,
			[...new Set(perTitleTracks.map((track) => track.codec))],
			manifestVideoFamilies(
				remainingVideo
					.filter((row) => boundWriters.get(`video:${row.uri}`)?.track.perTitle)
					.map((row) => ({
						codecs: parsed.variants.find((variant) => variant.uri === row.uri)
							?.codecs,
					})),
			),
			actual,
		);
	const textTracks = selection.tracks.filter((track) => track.kind === "text");
	const textBindings = new Map<string, Check["verdict"]>();
	for (const track of textTracks)
		for (const row of textRows) {
			const playlist = await child(row.uri);
			const playlistUrl = storageObjectUrl(root, childKeys.get(row.uri) ?? "");
			let verdict: Check["verdict"] = "FAIL";
			if (playlist?.segmentUris?.length && !playlist.mapUri)
				for (const resource of track.textResources ?? []) {
					if (!resource.outputKeys.includes(manifest.outputKey)) continue;
					const match = createFilenameMatcher(resource.filename, {
						policyTokens: true,
						randomTokens: false,
					});
					const observed = playlist.segmentUris.map((reference) => {
						const key = referencedObjectKey(reference, playlistUrl, root);
						return key?.startsWith(resource.directory)
							? match(key.slice(resource.directory.length))
							: "NO_MATCH";
					});
					if (observed.every((result) => result === "MATCH")) {
						verdict = "PASS";
						break;
					}
					if (!observed.includes("NO_MATCH")) verdict = "SKIP";
				}
			textBindings.set(`${track.renditionKey}\u0000${row.uri}`, verdict);
		}
	const text = matchOneToOne({
		expected: textTracks,
		observed: textRows,
		expectedKey: (track) => track.renditionKey,
		observedKey: (row) => row.uri,
		compatible: (track, row) => {
			const verdict = textBindings.get(`${track.renditionKey}\u0000${row.uri}`);
			return verdict !== undefined && verdict !== "FAIL";
		},
		cost: () => 0,
	});
	for (const track of textTracks) {
		const pair = text.pairs.find(
			(row) => row.expected.renditionKey === track.renditionKey,
		);
		const cid = `${id}:default-text:${track.renditionKey}`;
		if (
			!report.assert(
				`${cid}:present`,
				"manifest",
				pair !== undefined,
				`Selected subtitle track ${track.renditionKey} must reference its configured writer`,
			) ||
			!pair
		)
			continue;
		report.add(
			`${cid}:writer`,
			"manifest",
			textBindings.get(`${track.renditionKey}\u0000${pair.observed.uri}`) ??
				"FAIL",
			"Generated subtitle references belong to the selected subtitle writer",
		);
		if (track.language !== undefined)
			report.assert(
				`${cid}:language`,
				"manifest",
				pair.observed.language === track.language,
				`Subtitle language ${track.language} — ${pair.observed.language ?? "absent"}`,
			);
	}
	report.assert(
		`${id}:default-text-unexpected`,
		"manifest",
		text.unmatchedObserved.length === 0,
		"Every generated subtitle playlist must bind to a selected subtitle writer",
	);
}

/**
 * Bind each HLS master row to its planned node, one-to-one.
 * An EXT-X-STREAM-INF row's
 * IDENTITY is its URI plus its AUDIO group — the two values the compiler wrote
 * into the StreamInfo and the master hands back verbatim — and every expected
 * node consumes the row it binds, so `2 expected / 1 observed` leaves one node
 * MISSING and a row bound to nothing is UNEXPECTED. The bound row's remaining
 * attributes — RESOLUTION, BANDWIDTH, CODECS — are then asserted against the
 * plan. An EXT-X-MEDIA row's identity is (GROUP-ID, NAME), RFC 8216's own; its
 * URI is asserted after binding. Check ids are keyed by the EXPECTED node, so
 * the set is a function of the plan: a node the master fails to carry is a
 * FAIL, and a bound row whose attribute the master omits is an explicit SKIP —
 * never a vanished check.
 */
export function bindHlsTopology(
	report: ReportBuilder,
	id: string,
	topology: ManifestRenditionTopology,
	parsed: ParsedHls,
	ctx: TopologyContext,
): void {
	// ---- EXT-X-STREAM-INF rows ------------------------------------------------
	const selection = ctx.hlsAudioGroups
		? selectedHlsAudioGroups(ctx.hlsAudioGroups, parsed)
		: undefined;
	const nodes = selection?.dropStream ? [] : (topology.hlsVariants ?? []);
	const rows = parsed.variants.map((v, index) => ({ ...v, index }));
	type Row = (typeof rows)[number];
	const rowLabel = (o: Row) =>
		`row ${o.index + 1} ${o.uri}${o.audio !== undefined ? ` AUDIO=${JSON.stringify(o.audio)}` : ""}${o.resolution ? ` ${o.resolution}` : ""}${o.bandwidth !== undefined ? ` ${o.bandwidth}bps` : ""}${o.codecs ? ` ${o.codecs}` : ""}`;
	const variants = matchOneToOne({
		expected: nodes,
		observed: rows,
		expectedKey: (e) => e.key,
		// URI + AUDIO + RESOLUTION + CODECS + BANDWIDTH: two rows identical on
		// all five are one row listed twice.
		observedKey: (o) =>
			[
				o.uri,
				o.audio ?? "",
				o.resolution ?? "",
				o.codecs ?? "",
				o.bandwidth ?? "",
			].join("\u0000"),
		compatible: (e, o) =>
			o.uri === e.uri &&
			(selection
				? selection.groups.length
					? o.audio !== undefined && selection.groups.includes(o.audio)
					: o.audio === undefined
				: (o.audio ?? undefined) === (e.audioGroup ?? undefined)),
		cost: (e, o) =>
			normalizedBitrateCost(e.bitrate, o.bandwidth) +
			attributeRankCost([
				...(e.kind === "video"
					? [
							{
								observed: o.resolution,
								matches: resolutionHeight(o.resolution) === e.height,
							},
						]
					: []),
				{
					observed: o.codecs,
					matches: codecTokens(o.codecs).some((token) =>
						rfcCodecMatches(token, e.codec),
					),
				},
			]),
	});
	const boundVariant = new Map(variants.pairs.map((p) => [p.expected.key, p]));
	for (const want of nodes) {
		const cid = `${id}:variant:${want.key}`;
		const pair = boundVariant.get(want.key);
		const audioIdentity = selection
			? selection.groups.length
				? `AUDIO=${JSON.stringify(selection.groups[0])} selected by configured priority`
				: "no AUDIO attribute after audio-group dropping"
			: want.audioGroup !== undefined
				? `AUDIO=${JSON.stringify(want.audioGroup)}`
				: "no AUDIO attribute (self-contained)";
		const identity = `URI ${want.uri} and ${audioIdentity}`;
		const present = report.assert(
			`${cid}:present`,
			"manifest",
			pair !== undefined,
			pair
				? `${want.kind} variant with ${identity} bound to rendition ${want.renditionKey} — ${rowLabel(pair.observed)} (cost ${pair.cost.toFixed(3)})`
				: `no EXT-X-STREAM-INF with ${identity} for rendition ${want.renditionKey} — rows seen: ${rows.map(rowLabel).join("; ") || "none"}`,
		);
		if (!present || pair === undefined) {
			if (want.kind === "video") {
				report.skip(
					`${cid}:resolution`,
					"manifest",
					`no variant bound for ${want.renditionKey}, so its RESOLUTION was not checked`,
				);
			}
			report.skip(
				`${cid}:bandwidth`,
				"manifest",
				`no variant bound for ${want.renditionKey}, so its BANDWIDTH was not checked`,
			);
			report.skip(
				`${cid}:codec`,
				"manifest",
				`no variant bound for ${want.renditionKey}, so its CODECS was not checked`,
			);
			continue;
		}
		const variant = pair.observed;
		if (want.kind === "video") {
			if (variant.resolution === undefined) {
				report.skip(
					`${cid}:resolution`,
					"manifest",
					`the variant declares no RESOLUTION, so ${want.height}p could not be checked`,
				);
			} else {
				const seen = resolutionHeight(variant.resolution);
				report.assert(
					`${cid}:resolution`,
					"manifest",
					seen === want.height,
					`RESOLUTION height ${want.height} — ${variant.resolution}`,
				);
			}
		}
		if (variant.bandwidth === undefined) {
			report.skip(
				`${cid}:bandwidth`,
				"manifest",
				`the variant declares no BANDWIDTH, so ${want.bitrate} bps could not be bound`,
			);
		} else {
			const ratio = variant.bandwidth / want.bitrate;
			report.assert(
				`${cid}:bandwidth`,
				"manifest",
				ratio >= HLS_BANDWIDTH_LOW && ratio <= HLS_BANDWIDTH_HIGH,
				`BANDWIDTH within [${HLS_BANDWIDTH_LOW}×, ${HLS_BANDWIDTH_HIGH}×] of ${want.bitrate} (${want.kind === "video" ? "video + audio + overhead" : "audio + overhead"}) — declared ${variant.bandwidth} (${ratio.toFixed(2)}×)`,
			);
		}
		if (variant.codecs === undefined) {
			report.skip(
				`${cid}:codec`,
				"manifest",
				`the variant declares no CODECS, so codec ${want.codec} could not be bound`,
			);
		} else {
			report.assert(
				`${cid}:codec`,
				"manifest",
				codecTokens(variant.codecs).some((t) => rfcCodecMatches(t, want.codec)),
				`CODECS names ${want.codec} — ${variant.codecs}`,
			);
		}
	}
	report.assert(
		`${id}:variants-duplicate`,
		"manifest",
		variants.duplicates.length === 0,
		variants.duplicates.length === 0
			? `no EXT-X-STREAM-INF row is listed twice (${rows.length} row(s))`
			: `EXT-X-STREAM-INF row(s) listed more than once: ${variants.duplicates
					.map((d) => `${rowLabel(d.rows[0] as Row)} ×${d.rows.length}`)
					.join("; ")} — a duplicated row is one rendition, not two`,
	);
	// A row bound to no node. On a per-title master the encoder's rungs are
	// EXPECTED to be unbound (their URIs are run-time values, C1) — provided
	// each carries a declared video family, or declares no codecs at all.
	const perTitleCandidate = (o: Row) =>
		ctx.perTitle &&
		(o.codecs === undefined ||
			codecTokens(o.codecs).some((t) => {
				const family = videoFamilyOf(t);
				return (
					family !== undefined &&
					topology.declaredVideoCodecFamilies.includes(
						family as (typeof topology.declaredVideoCodecFamilies)[number],
					)
				);
			}));
	// An audio-only master (no expected STREAM-INF nodes at all) still carries
	// its renditions as EXT-X-STREAM-INF entries pointing at the media
	// playlists — a real Bitmovin shape the `audioOnly` count branch above
	// already accommodates. Such a row is the master's own restatement of a
	// planned MEDIA entry, not an extra rendition: tolerated only when nothing
	// video was planned, only at a planned media URI, and only with audio-only
	// (or no) CODECS.
	const mediaUris = new Set(
		topology.audio.flatMap((a) => (a.uri !== undefined ? [a.uri] : [])),
	);
	const implicitAudioRow = (o: Row) =>
		nodes.length === 0 &&
		mediaUris.has(o.uri) &&
		(o.codecs === undefined ||
			codecTokens(o.codecs).every(
				(token) =>
					isAudioToken(token) &&
					topology.audio.some(
						(audio) =>
							audio.uri === o.uri && rfcCodecMatches(token, audio.codec),
					),
			));
	const unexpected = variants.unmatchedObserved.filter(
		(o) => !perTitleCandidate(o) && !implicitAudioRow(o),
	);
	const tolerated = variants.unmatchedObserved.length - unexpected.length;
	report.assert(
		`${id}:variants-unexpected`,
		"manifest",
		unexpected.length === 0,
		unexpected.length === 0
			? `every EXT-X-STREAM-INF row is bound to a planned node (${variants.pairs.length} bound${ctx.perTitle ? `, ${tolerated} encoder-chosen per-title row(s) accepted` : ""}${!ctx.perTitle && tolerated > 0 ? `, ${tolerated} audio-only row(s) at planned media URIs accepted` : ""})`
			: `EXT-X-STREAM-INF row(s) the plan never asked for: ${unexpected.map(rowLabel).join("; ")}${ctx.perTitle ? " — on a per-title master a row is accepted only when its CODECS names a declared video family" : ""}`,
	);
	if (ctx.perTitle) {
		verifyPerTitleVideoFamilies(
			report,
			id,
			topology.declaredVideoCodecFamilies,
			manifestVideoFamilies(variants.unmatchedObserved),
			ctx.perTitleActual,
		);
	}

	// ---- EXT-X-MEDIA AUDIO rows — a separate set, its own identity ----------
	const audioMedia = parsed.media
		.map((m, index) => ({ ...m, index }))
		.filter((m) => m.type === "AUDIO");
	type Media = (typeof audioMedia)[number];
	const mediaLabel = (m: Media) =>
		`GROUP-ID=${JSON.stringify(m.groupId ?? null)} NAME=${JSON.stringify(m.name ?? null)}${m.uri ? ` URI=${m.uri}` : ""}`;
	const bindable = topology.audio.filter(
		(a) => a.name !== undefined && a.groupId !== undefined,
	);
	for (const want of topology.audio) {
		if (want.name === undefined || want.groupId === undefined) {
			// The compiler always names and groups an HLS audio rendition; a
			// topology entry without them cannot be bound, and says so.
			report.skip(
				`${id}:media:${want.renditionKey}:present`,
				"manifest",
				`rendition ${want.renditionKey} carries no audio media NAME/GROUP-ID to bind`,
			);
			report.skip(
				`${id}:media:${want.renditionKey}:uri`,
				"manifest",
				`rendition ${want.renditionKey} carries no audio media NAME/GROUP-ID, so its URI was not checked`,
			);
		}
	}
	const media = matchOneToOne({
		expected: bindable,
		observed: audioMedia,
		expectedKey: (a) => a.renditionKey,
		observedKey: (m) =>
			[m.groupId ?? "", m.name ?? "", m.uri ?? ""].join("\u0000"),
		// (GROUP-ID, NAME) is the entry's identity — RFC 8216 §4.3.4.1.1 makes
		// NAME unique within a group, and `:media-names-unique` proves it from
		// the raw text, because the parser collapses a duplicate.
		compatible: (a, m) => m.groupId === a.groupId && m.name === a.name,
		cost: () => 0,
	});
	const boundMedia = new Map(
		media.pairs.map((p) => [p.expected.renditionKey, p]),
	);
	for (const want of bindable) {
		const cid = `${id}:media:${want.renditionKey}`;
		const pair = boundMedia.get(want.renditionKey);
		const present = report.assert(
			`${cid}:present`,
			"manifest",
			pair !== undefined,
			pair
				? `EXT-X-MEDIA AUDIO ${JSON.stringify(want.name)} in group ${JSON.stringify(want.groupId)} bound to rendition ${want.renditionKey}`
				: `no EXT-X-MEDIA AUDIO named ${JSON.stringify(want.name)} in group ${JSON.stringify(want.groupId)} for rendition ${want.renditionKey} — entries seen: ${audioMedia.map(mediaLabel).join("; ") || "none"}`,
		);
		if (!present || pair === undefined) {
			report.skip(
				`${cid}:uri`,
				"manifest",
				`no audio media bound for ${want.renditionKey}, so its URI was not checked`,
			);
			continue;
		}
		if (want.uri === undefined) {
			report.skip(
				`${cid}:uri`,
				"manifest",
				`the expectation carries no media URI for ${want.renditionKey}, so the entry's URI was not checked`,
			);
		} else if (pair.observed.uri === undefined) {
			report.skip(
				`${cid}:uri`,
				"manifest",
				`the EXT-X-MEDIA entry declares no URI, so ${want.uri} could not be checked`,
			);
		} else {
			report.assert(
				`${cid}:uri`,
				"manifest",
				pair.observed.uri === want.uri,
				`EXT-X-MEDIA URI ${want.uri} — ${pair.observed.uri}`,
			);
		}
	}
	// Audio is never per-title, so an unbound AUDIO entry is never the encoder's.
	report.assert(
		`${id}:media-unexpected`,
		"manifest",
		media.unmatchedObserved.length === 0,
		media.unmatchedObserved.length === 0
			? `every EXT-X-MEDIA AUDIO entry is bound to a planned rendition (${media.pairs.length} bound)`
			: `EXT-X-MEDIA AUDIO entr${media.unmatchedObserved.length === 1 ? "y" : "ies"} the plan never asked for: ${media.unmatchedObserved.map(mediaLabel).join("; ")}`,
	);
}

/**
 * Bind an MPD's codec/representation topology to the plan.
 * Every
 * AdaptationSet's codecs belong to the plan family for its kind (the `case F`
 * two-codecs-in-one-set defect a count cannot see) — the VIDEO family set is
 * the plan's DECLARED one, per-title templates included, so a per-title MPD is
 * never judged against an empty set. Then each expected representation node —
 * a fixed video rendition (by kind + height) or an audio rendition (by kind +
 * codec family) — is bound ONE-TO-ONE to a representation, consuming it, with
 * the bandwidth distance as the cost; the bound representation's codec and
 * bandwidth are asserted afterwards. Ids are keyed by the expected rendition
 * or are per-manifest, so the set is plan-derived.
 */
export function bindDashTopology(
	report: ReportBuilder,
	id: string,
	topology: ManifestRenditionTopology,
	parsed: ParsedDash,
	ctx: TopologyContext,
): void {
	const videoFamilies: string[] = [...topology.declaredVideoCodecFamilies];
	const audioFamilies = [...new Set(topology.audio.map((a) => a.codec))];
	if (parsed.adaptationSets === undefined) {
		report.skip(
			`${id}:adaptationset-codecs`,
			"manifest",
			"the parser exposed no AdaptationSet codecs, so codec↔set topology was not checked",
		);
	} else {
		const offenders: string[] = [];
		for (const set of parsed.adaptationSets) {
			const families =
				set.kind === "video"
					? videoFamilies
					: set.kind === "audio"
						? audioFamilies
						: set.kind === "text"
							? (topology.textCodecs ?? [])
							: set.kind === "image"
								? (topology.imageCodecs ?? [])
								: [];
			// Two bindings in one pass: every codec belongs to a plan family for
			// this set's kind (membership — a video set carrying an audio codec, or
			// a codec no rendition planned), AND the set draws from ONE family
			// (homogeneity — `case F`'s H264+H265 in a single set, which membership
			// alone misses when the plan legitimately has both).
			const seenFamilies = new Set<string>();
			for (const c of set.codecs) {
				const fam = families.find((f) =>
					set.kind === "text" || set.kind === "image"
						? c.toLowerCase().startsWith(f.toLowerCase())
						: rfcCodecMatches(c, f),
				);
				if (fam === undefined) {
					offenders.push(`${set.kind} set carries ${c} (no plan family)`);
				} else {
					seenFamilies.add(fam);
				}
			}
			if (seenFamilies.size > 1) {
				offenders.push(
					`${set.kind} set mixes families ${[...seenFamilies].join("+")}`,
				);
			}
		}
		report.assert(
			`${id}:adaptationset-codecs`,
			"manifest",
			offenders.length === 0,
			offenders.length === 0
				? `every AdaptationSet's codecs match its kind's plan family (video: ${videoFamilies.join("/") || "none"}, audio: ${audioFamilies.join("/") || "none"})`
				: `AdaptationSet codec(s) outside the plan family for their kind: ${offenders.join("; ")} — a set mixing families is the shape a representation count cannot see`,
		);
	}
	// ---- representation nodes, bound one-to-one ------------------------------
	type Node = {
		key: string;
		renditionKey: string;
		kind: "video" | "audio";
		codec: string;
		height?: number;
		width?: number;
		bitrate?: number;
		optional?: true;
	};
	const nodes: Node[] = [
		...topology.video.map<Node>((v) => ({
			key: v.renditionKey,
			renditionKey: v.renditionKey,
			kind: "video",
			codec: v.codec,
			height: v.height,
			width: v.width,
			bitrate: v.bitrate,
			...(v.optional ? { optional: true } : {}),
		})),
		...topology.audio.map<Node>((a) => ({
			key: a.renditionKey,
			renditionKey: a.renditionKey,
			kind: "audio",
			codec: a.codec,
			...(a.bitrate !== undefined ? { bitrate: a.bitrate } : {}),
			...(a.optional ? { optional: true } : {}),
		})),
	];
	const reps = parsed.representations
		.map((r, index) => ({ ...r, index }))
		.filter((r) => r.kind === "video" || r.kind === "audio");
	type Rep = (typeof reps)[number];
	const repLabel = (r: Rep) =>
		`representation ${r.id !== undefined ? JSON.stringify(r.id) : `#${r.index + 1}`} (${r.kind}${r.height !== undefined ? ` ${r.height}p` : ""}${r.bandwidth !== undefined ? ` ${r.bandwidth}bps` : ""}${r.codecs ? ` ${r.codecs}` : ""})`;
	const namesFamily = (r: Rep, codec: string) =>
		codecTokens(r.codecs).some((t) => rfcCodecMatches(t, codec));
	const matched = matchOneToOne({
		expected: nodes,
		isRequired: (node) => !node.optional,
		observed: reps,
		expectedKey: (n) => n.key,
		// Representation id + canonical attributes. A representation the parser
		// could describe by NOTHING (no id, geometry, bandwidth or codecs) has no
		// identity to duplicate: it keeps its source index so a sparse parse is
		// never reported as "the same representation twice".
		observedKey: (r) =>
			r.id === undefined &&
			r.height === undefined &&
			r.bandwidth === undefined &&
			r.codecs === undefined
				? `#${r.index} ${r.kind}`
				: [
						r.id ?? "",
						r.kind,
						r.height ?? "",
						r.bandwidth ?? "",
						r.codecs ?? "",
					].join(" "),
		compatible: (n, r) =>
			n.kind === r.kind &&
			(n.width === undefined || r.width === undefined || n.width === r.width) &&
			(n.kind === "video"
				? n.height === undefined || r.height === n.height
				: r.codecs === undefined || namesFamily(r, n.codec)),
		cost: (n, r) =>
			(n.bitrate === undefined
				? normalizedBitrateCost(0, undefined)
				: normalizedBitrateCost(n.bitrate, r.bandwidth)) +
			(n.kind === "video"
				? attributeRankCost([
						{
							observed: r.codecs,
							matches: namesFamily(r, n.codec),
						},
					])
				: 0),
	});
	const bound = new Map(matched.pairs.map((p) => [p.expected.key, p]));
	for (const want of nodes) {
		const cid = `${id}:rep:${want.key}`;
		const pair = bound.get(want.key);
		const identity =
			want.kind === "video"
				? want.height === undefined
					? `video representation in family ${want.codec}`
					: `video representation at ${want.height}p`
				: `audio representation in family ${want.codec}`;
		let present = false;
		if (want.optional && pair === undefined) {
			report.skip(
				`${cid}:present`,
				"manifest",
				"This rendition is optional because Default selection depends on unavailable metadata",
			);
		} else {
			present = report.assert(
				`${cid}:present`,
				"manifest",
				pair !== undefined,
				pair
					? `${identity} bound to rendition ${want.renditionKey} — ${repLabel(pair.observed)} (cost ${pair.cost.toFixed(3)})`
					: `no ${identity} left for rendition ${want.renditionKey} — ${want.kind} representations seen: ${
							reps
								.filter((r) => r.kind === want.kind)
								.map(repLabel)
								.join(", ") || "none"
						}`,
			);
		}
		if (!present || pair === undefined) {
			if (want.kind === "video") {
				report.skip(
					`${cid}:codec`,
					"manifest",
					`no ${want.height}p representation bound, so its codecs were not checked`,
				);
			}
			report.skip(
				`${cid}:bandwidth`,
				"manifest",
				`no representation bound for ${want.renditionKey}, so its bandwidth was not checked`,
			);
			continue;
		}
		const rep = pair.observed;
		if (want.kind === "video") {
			if (want.height === undefined)
				report.skip(
					`${cid}:height`,
					"manifest",
					"Video resolution is derived from the input; known codec and bitrate constraints remain checked",
				);
			if (want.width !== undefined) {
				if (rep.width === undefined)
					report.skip(
						`${cid}:width`,
						"manifest",
						"The parser exposed no video width; its configured width remains UNVERIFIED",
					);
				else
					report.assert(
						`${cid}:width`,
						"manifest",
						rep.width === want.width,
						`Configured video width is ${want.width}px`,
					);
			}
			if (rep.codecs === undefined) {
				report.skip(
					`${cid}:codec`,
					"manifest",
					`the representation declares no codecs, so codec ${want.codec} could not be bound`,
				);
			} else {
				report.assert(
					`${cid}:codec`,
					"manifest",
					namesFamily(rep, want.codec),
					`representation codecs name ${want.codec} — ${rep.codecs}`,
				);
			}
		}
		if (want.bitrate === undefined) {
			report.skip(
				`${cid}:bandwidth`,
				"manifest",
				`the expectation carries no bitrate for ${want.renditionKey}, so the representation's bandwidth was not checked`,
			);
		} else if (rep.bandwidth === undefined) {
			report.skip(
				`${cid}:bandwidth`,
				"manifest",
				`the representation declares no bandwidth, so ${want.bitrate} bps could not be bound`,
			);
		} else {
			const ratio = rep.bandwidth / want.bitrate;
			const [low, high] =
				want.kind === "video"
					? [BITRATE_LOW, BITRATE_HIGH]
					: [AUDIO_BITRATE_LOW, AUDIO_BITRATE_HIGH];
			report.assert(
				`${cid}:bandwidth`,
				"manifest",
				ratio >= low && ratio <= high,
				`bandwidth within [${low}×, ${high}×] of ${want.bitrate} — declared ${rep.bandwidth} (${ratio.toFixed(2)}×)`,
			);
		}
	}
	report.assert(
		`${id}:representations-duplicate`,
		"manifest",
		matched.duplicates.length === 0,
		matched.duplicates.length === 0
			? `no representation is listed twice (${reps.length} video/audio representation(s))`
			: `representation(s) listed more than once: ${matched.duplicates
					.map((d) => `${repLabel(d.rows[0] as Rep)} ×${d.rows.length}`)
					.join("; ")} — a duplicated representation is one rendition, not two`,
	);
	// A representation bound to no node. On a per-title MPD the encoder's video
	// rungs are EXPECTED to be unbound (C1) — provided each carries a declared
	// family, or declares no codecs at all. Audio is never per-title.
	const perTitleCandidate = (r: Rep) =>
		ctx.perTitle &&
		r.kind === "video" &&
		(r.codecs === undefined ||
			codecTokens(r.codecs).some((t) => {
				const family = videoFamilyOf(t);
				return family !== undefined && videoFamilies.includes(family);
			}));
	const unexpected = matched.unmatchedObserved.filter(
		(r) => !perTitleCandidate(r),
	);
	const tolerated = matched.unmatchedObserved.length - unexpected.length;
	report.assert(
		`${id}:representations-unexpected`,
		"manifest",
		unexpected.length === 0,
		unexpected.length === 0
			? `every video/audio representation is bound to a planned rendition (${matched.pairs.length} bound${ctx.perTitle ? `, ${tolerated} encoder-chosen per-title representation(s) accepted` : ""})`
			: `representation(s) the plan never asked for: ${unexpected.map(repLabel).join("; ")}${ctx.perTitle ? " — on a per-title MPD a video representation is accepted only when its codecs name a declared family" : ""}`,
	);
	if (ctx.perTitle) {
		verifyPerTitleVideoFamilies(
			report,
			id,
			topology.declaredVideoCodecFamilies,
			manifestVideoFamilies(
				matched.unmatchedObserved.filter((r) => r.kind === "video"),
			),
			ctx.perTitleActual,
		);
	}
}

async function listDeclaredManifestMedia(
	deps: EngineDeps,
	expected: ExpectedArtefacts,
	manifest: ExpectedManifest,
): Promise<Map<string, number | undefined>> {
	const mirrored = expected.deliveryMirrorOutputKeys?.includes(
		manifest.outputKey,
	);
	const declared = new Set([
		manifest.dir.prefix,
		...expected.muxings
			.filter((row) => row.outputKey === manifest.outputKey || mirrored)
			.map((row) => row.dir.prefix),
		...expected.drm.flatMap((row) =>
			row.dir && (row.outputKey === manifest.outputKey || mirrored)
				? [row.dir.prefix]
				: [],
		),
		// These references come from the validated plan, never from parsed MPD text.
		...(manifest.dashProgressiveFiles ?? [])
			.filter((file) => !/^https?:/i.test(file))
			.map((file) => resolveReferencedKey(manifest.dir.prefix, file)),
	]);
	const candidates = [...declared];
	const prefixes = candidates.filter(
		(prefix) =>
			!candidates.some((other) => other !== prefix && prefix.startsWith(other)),
	);
	const listing = new Map<string, number | undefined>();
	for (const prefix of prefixes)
		for (const object of await deps.listAll(manifest.outputKey, prefix))
			listing.set(object.key, object.size);
	return listing;
}

async function verifyManifest(
	report: ReportBuilder,
	deps: EngineDeps,
	manifest: ExpectedManifest,
	expected: ExpectedArtefacts,
): Promise<void> {
	const base = `manifest:${manifest.manifestKey}`;
	for (const file of manifest.files) {
		// The FILE is part of the id when a manifest has more than one. A Smooth manifest
		// writes `stream.ism` and `stream.ismc`, and both used to emit `…:exists` and
		// `…:smooth` under identical ids — against `Check.id`'s own contract ("stable id so
		// a report diff is readable across runs"), and a report where two rows share an id
		// cannot be diffed or pointed at (review catch). Single-file manifests keep their
		// original ids, so no existing report shape changes.
		const id =
			manifest.files.length > 1 ? `${base}:${file.replace(/\W+/g, "-")}` : base;
		const key = `${manifest.dir.prefix}${file}`;
		let text: string;
		try {
			text = await deps.readText(manifest.outputKey, key);
		} catch (err) {
			report.fail(
				id,
				"manifest",
				`${manifest.kind} manifest ${key} is not readable: ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
		report.pass(`${id}:exists`, "manifest", `${key} present (${text.length}B)`);

		if (manifest.kind === "HLS") {
			let parsed: ParsedHls;
			try {
				parsed = await deps.parseHls(text);
			} catch (err) {
				report.fail(
					`${id}:parse`,
					"manifest",
					`a real HLS parser rejected ${key}: ${err instanceof Error ? err.message : String(err)}`,
				);
				continue;
			}
			// Empty on every axis ⇒ the parser did not reject it, it found nothing in
			// it. That is a rejection for our purposes.
			const hasContent =
				parsed.variants.length > 0 ||
				parsed.media.length > 0 ||
				(parsed.segments ?? 0) > 0;
			if (
				!report.assert(
					`${id}:parse`,
					"manifest",
					hasContent,
					`a real HLS parser must find a playlist in ${key} — ${parsed.variants.length} variant(s), ${parsed.media.length} media, ${parsed.segments ?? 0} segment(s)`,
				)
			) {
				continue;
			}
			/*
			 * RAW-TEXT checks on the master
			 * — deliberately NOT through the parser. `m3u8-parser` stores
			 * media entries as `mediaGroup[NAME] = rendition`, so two EXT-X-MEDIA
			 * lines with one NAME collapse to one in the parsed structure: the
			 * duplicate-NAME defect the audit reproduced on five real masters was
			 * structurally invisible to a parsed-count check. So the counts and
			 * the uniqueness below come from the lines themselves.
			 */
			const isMasterText =
				/#EXT-X-STREAM-INF/.test(text) || /#EXT-X-MEDIA:/.test(text);
			if (isMasterText) {
				const attr = (line: string, name: string): string | undefined => {
					// `:` as well as `,`: the first attribute follows the tag's colon
					// (`#EXT-X-MEDIA:TYPE=AUDIO,…`), and the first cut of this regex
					// missed exactly that one — every TYPE read as undefined and the
					// healthy control failed its own audio-media count.
					const m = new RegExp(`(?:^|[,:])${name}=("([^"]*)"|[^,]*)`).exec(
						line,
					);
					return m === null ? undefined : (m[2] ?? m[1]);
				};
				const mediaLines = text
					.split("\n")
					.filter((l) => l.startsWith("#EXT-X-MEDIA:"));
				const audioMedia = mediaLines.filter(
					(l) => attr(l, "TYPE") === "AUDIO",
				);
				const audioGroups = new Set(audioMedia.map((l) => attr(l, "GROUP-ID")));
				// NAME unique within (TYPE, GROUP-ID) — RFC 8216 §4.3.4.1.1.
				const seen = new Map<string, number>();
				for (const l of mediaLines) {
					const k = `${attr(l, "TYPE")}\u0000${attr(l, "GROUP-ID")}\u0000${attr(l, "NAME")}`;
					seen.set(k, (seen.get(k) ?? 0) + 1);
				}
				const dupes = [...seen.entries()].filter(([, n]) => n > 1);
				report.assert(
					`${id}:media-names-unique`,
					"manifest",
					dupes.length === 0,
					dupes.length === 0
						? `every EXT-X-MEDIA NAME is unique within its group (${mediaLines.length} entr${mediaLines.length === 1 ? "y" : "ies"})`
						: `duplicate EXT-X-MEDIA NAME within a group: ${dupes
								.map(([k, n]) => `${k.split("\u0000").join("/")} ×${n}`)
								.join(
									", ",
								)} — a player keys renditions by NAME, and so does the parser this verifier used to trust`,
				);
				const unnamed = mediaLines.filter((l) => attr(l, "NAME") === undefined);
				report.assert(
					`${id}:media-named`,
					"manifest",
					unnamed.length === 0,
					`every EXT-X-MEDIA carries a NAME (required by RFC 8216 §4.3.4.1) — ${unnamed.length} without`,
				);
				// The AUDIO attribute on every variant: absent (self-contained) or
				// naming an audio GROUP-ID that exists. `AUDIO=""` was the paid
				// audit's cases 3/4 — an attribute the API doc says MUST match a
				// group, sent empty, on a master the old checks passed.
				const variantLines = text
					.split("\n")
					.filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
				const badAudio = variantLines
					.map((l) => attr(l, "AUDIO"))
					.filter((a): a is string => a !== undefined)
					.filter((a) => a === "" || !audioGroups.has(a));
				report.assert(
					`${id}:variant-audio-groups`,
					"manifest",
					badAudio.length === 0,
					badAudio.length === 0
						? `every variant's AUDIO attribute names an existing group or is absent (${variantLines.length} variant(s), groups: ${[...audioGroups].join(", ") || "none"})`
						: `variant AUDIO attribute(s) that name no audio group: ${badAudio.map((a) => JSON.stringify(a)).join(", ")} — an empty or dangling GROUP-ID plays silent`,
				);
				// Counted from the LINES, not the parser: the parser collapses.
				// Per-title too (review-325 I2): audio is never per-title, so the
				// audio-media count is exact on every master.
				if (!manifest.hlsDefault)
					report.assert(
						`${id}:audio-media-count`,
						"manifest",
						audioMedia.length === manifest.audioEntries,
						`${manifest.audioEntries} audio media entr${manifest.audioEntries === 1 ? "y" : "ies"} — ${audioMedia.length} (counted from EXT-X-MEDIA lines)`,
					);
			}
			// An audio-only master (3 fixtures: `audio-only-aac-fmp4-hls-dash` and the two
			// Atmos ones) has `videoEntries: 0` and carries its renditions as
			// EXT-X-STREAM-INF entries anyway, so counting variants against videoEntries
			// fails a correct artefact. Review catch, and it failed BOTH ways: whichever
			// branch the parser took, one of `:variants` and `:endlist` was guaranteed to
			// fire on a healthy file.
			const audioOnly = manifest.videoEntries === 0;
			if (manifest.hlsDefault) {
				// Provider-selected identities are bound after the ordinary child byte/decoding checks.
			} else if (audioOnly) {
				report.assert(
					`${id}:variants`,
					"manifest",
					parsed.variants.length > 0 || parsed.media.length > 0,
					`audio-only master must still declare renditions — ${parsed.variants.length} variant(s), ${parsed.media.length} media`,
				);
			} else if (manifest.perTitle) {
				// Per-title: the plan's `videoEntries` is a TEMPLATE count, and the encoder
				// chooses the real ladder. Asserting equality here failed a CORRECT per-title
				// encode — a reviewer measured `7 video variant(s) — 3` against a manifest
				// honestly describing the three rungs that were produced. The muxing side
				// already reasoned this way (`expected.ts` even emits a note saying so); the
				// manifest side had not, so "per-title cannot go green" was fixed for muxings
				// and still true for manifests.
				//
				/**
				 * What is knowable is the FLOOR. The ceiling was wrong here too.
				 *
				 * This block used to assert "never MORE than the template count — per-title
				 * selects from the ladder the templates describe, it does not invent rungs
				 * beyond them". The artefacts refute it, exactly as they refuted the same claim
				 * on the muxing side: `pertitle-av1-fmp4-dash-on-aws` declares 2 per-title
				 * muxings and its manifest honestly enumerates 4 video rungs, because the plan's
				 * own `forcedRenditionAboveHighestFixedRepresentation` and `minBitrate` produce
				 * two of them (the arithmetic is in `verifyPerTitleRungs`).
				 *
				 * So the same split: at least one variant is a FAIL if missing, and more
				 * variants than templates is a WARN that names why it can legitimately happen.
				 */
				report.assert(
					`${id}:variants`,
					"manifest",
					parsed.variants.length > 0,
					`a per-title master declares at least one variant — the encoder chooses the ladder — ${parsed.variants.length}`,
				);
				if (parsed.variants.length > manifest.videoEntries) {
					report.warn(
						`${id}:variants-above-templates`,
						"manifest",
						`${parsed.variants.length} variants from ${manifest.videoEntries} per-title template(s) — more than the templates alone explain, which the plan's perTitle config can legitimately produce (forcedRenditionAboveHighestFixedRepresentation, a minBitrate floor rung, autoRepresentations)`,
					);
				}
			} else {
				const selection = manifest.hlsAudioGroups
					? selectedHlsAudioGroups(manifest.hlsAudioGroups, parsed)
					: undefined;
				const videoEntries = selection?.dropStream ? 0 : manifest.videoEntries;
				report.assert(
					`${id}:variants`,
					"manifest",
					parsed.variants.length === videoEntries,
					`${videoEntries} video variant(s) — ${parsed.variants.length}`,
				);
			}
			if (manifest.hlsMasterVersion) {
				const want = Number(manifest.hlsMasterVersion.replace(/^HLS_V/, ""));
				report.assert(
					`${id}:version`,
					"manifest",
					parsed.version === want,
					`EXT-X-VERSION ${want} — ${parsed.version ?? "absent"}`,
				);
			}
			// A VOD MEDIA playlist must be closed or a player waits forever. A MASTER
			// carries no ENDLIST, so the check applies only when this file is not one
			// (variants present ⇒ master).
			// …and a master is identified by declaring renditions of ANY kind, not by
			// having video variants — otherwise an audio-only master is mistaken for a
			// media playlist and required to carry an ENDLIST it never has.
			const isMaster = parsed.variants.length > 0 || parsed.media.length > 0;
			report.checks.push(
				...(await collectHlsReferenceChecks(deps, id, manifest, parsed)),
			);
			if (!isMaster) {
				report.assert(
					`${id}:endlist`,
					"manifest",
					/#EXT-X-ENDLIST/.test(text),
					"a VOD media playlist must end with #EXT-X-ENDLIST",
				);
			}
			/*
			 * THE CHILD WALK . The engine used to read the master
			 * only; every media playlist — the files a player actually fetches —
			 * went unread, which is how `EXT-X-VERSION:4` beside `EXT-X-MAP` and
			 * a master whose children were all empty passed. Every URI the master
			 * references is read, must parse, must close (VOD), must carry at
			 * least one segment, must carry EXT-X-MAP when the leg is fMP4, and
			 * must carry the pinned media version when the plan pinned one.
			 */
			// Per-title masters walk too (review-325 I2): the child URIs come
			// from the PARSED master at verify time, so the ladder's size is
			// never needed in advance — only the exact-count checks are.
			if (isMaster) {
				const listing = await listDeclaredManifestMedia(
					deps,
					expected,
					manifest,
				);
				const uris = [
					...parsed.variants.map((v) => v.uri),
					...parsed.media.flatMap((m) => (m.uri ? [m.uri] : [])),
				].filter((u) => u !== "" && !/^https?:/.test(u));
				report.assert(
					`${id}:children-referenced`,
					"manifest",
					uris.length > 0,
					`the master references ${uris.length} child playlist(s)`,
				);
				for (const uri of uris) {
					const cid = `${id}:child:${uri.replace(/\W+/g, "-")}`;
					const storageRoot = new URL("https://objects.invalid/");
					const childKey = referencedObjectKey(
						uri,
						storageObjectUrl(storageRoot, key),
						storageRoot,
					);
					if (childKey === undefined) {
						report.fail(
							cid,
							"manifest",
							"The child playlist URI is malformed or outside the manifest storage root",
						);
						continue;
					}
					let child: string;
					try {
						child = await deps.readText(manifest.outputKey, childKey);
					} catch (err) {
						report.fail(
							cid,
							"manifest",
							`child playlist ${childKey} is not readable: ${err instanceof Error ? err.message : String(err)}`,
						);
						continue;
					}
					const segmentCount = (child.match(/#EXTINF:/g) ?? []).length;
					report.assert(
						`${cid}:segments`,
						"manifest",
						segmentCount > 0,
						`${childKey} lists ${segmentCount} segment(s)`,
					);
					report.assert(
						`${cid}:endlist`,
						"manifest",
						/#EXT-X-ENDLIST/.test(child),
						`${childKey} must end with #EXT-X-ENDLIST (VOD)`,
					);
					// Closure of THIS child's references .
					const childParsed = await deps.parseHls(child).catch(() => undefined);
					if (
						manifest.hlsAdditionalMedia?.some(
							(media) => media.uri === uri && media.vttUrl !== undefined,
						)
					) {
						report.skip(
							`${cid}:media-closure`,
							"manifest",
							"External WebVTT references are checked separately; remote bytes were not fetched",
						);
						report.skip(
							`${cid}:media-decodes`,
							"manifest",
							"External WebVTT bytes were not fetched",
						);
					} else if (childParsed?.segmentUris === undefined) {
						report.skip(
							`${cid}:reference-bytes`,
							"manifest",
							"The parser exposed no media references, so their byte ranges cannot be checked",
						);
						report.skip(
							`${cid}:media-closure`,
							"manifest",
							"the parser exposed no segment URIs for this child — its referenced bytes cannot be checked",
						);
						report.skip(
							`${cid}:media-decodes`,
							"manifest",
							"nothing to assemble — no segment URIs were exposed",
						);
					} else {
						const relative = (u: string) => !/^https?:/.test(u);
						const playlistUrl = storageObjectUrl(storageRoot, childKey);
						const parsedReferences = childParsed.mediaSegments?.flatMap(
							(segment) => [
								...(segment.map ? [{ ...segment.map, init: true }] : []),
								{ ...segment, init: false },
							],
						) ?? [
							...(childParsed.mapUri
								? [{ uri: childParsed.mapUri, init: true }]
								: []),
							...childParsed.segmentUris.map((uri) => ({ uri, init: false })),
						];
						const objects: HlsVideoReferences["objects"] = [];
						let unresolved = false;
						for (const reference of parsedReferences) {
							const key = referencedObjectKey(
								reference.uri,
								playlistUrl,
								storageRoot,
							);
							if (key === undefined) unresolved = true;
							else
								objects.push({
									key,
									reference: reference.uri,
									init: reference.init,
									...("byteRange" in reference && reference.byteRange
										? { range: reference.byteRange }
										: {}),
								});
						}
						const byteCheck = unresolved
							? {
									id: `${cid}:reference-bytes`,
									area: "manifest" as const,
									verdict: "FAIL" as const,
									detail:
										"A child media URI is malformed or outside the manifest storage root",
								}
							: checkHlsReferenceObjects(
									`${cid}:reference-bytes`,
									objects,
									[...listing].map(([key, size]) => ({
										key,
										...(size !== undefined ? { size } : {}),
									})),
								);
						report.checks.push(byteCheck);
						const hasMap =
							childParsed.mapUri !== undefined && relative(childParsed.mapUri);
						const references = [
							...(hasMap && childParsed.mapUri ? [childParsed.mapUri] : []),
							...childParsed.segmentUris.filter(relative),
						];
						const keys = references.map((reference) =>
							referencedObjectKey(reference, playlistUrl, storageRoot),
						);
						if (keys.some((object) => object === undefined)) {
							report.fail(
								`${cid}:media-closure`,
								"manifest",
								"A child media URI is malformed or outside the manifest storage root",
							);
							report.skip(
								`${cid}:media-decodes`,
								"manifest",
								"Unresolved media references cannot be assembled",
							);
						} else {
							const resolved = keys.filter(
								(object): object is string => object !== undefined,
							);
							const mapKey = hasMap ? resolved.shift() : undefined;
							await verifyMediaClosure(
								report,
								deps,
								manifest.outputKey,
								listing,
								cid,
								{
									...(mapKey ? { mapKey } : {}),
									segmentKeys: resolved,
								},
							);
						}
					}
					const isVideoChild = parsed.variants.some((v) => v.uri === uri);
					if (
						isVideoChild &&
						(manifest.hlsVideoLeg === "FMP4" || manifest.hlsVideoLeg === "CMAF")
					) {
						report.assert(
							`${cid}:map`,
							"manifest",
							/#EXT-X-MAP:/.test(child),
							`${childKey} is an fMP4 media playlist and must carry EXT-X-MAP (the init segment)`,
						);
					}
					if (manifest.hlsMediaVersion) {
						const want = Number(manifest.hlsMediaVersion.replace(/^HLS_V/, ""));
						const got = /#EXT-X-VERSION:(\d+)/.exec(child);
						report.assert(
							`${cid}:version`,
							"manifest",
							got !== null && Number(got[1]) === want,
							`${childKey} EXT-X-VERSION ${want} — ${got?.[1] ?? "absent"}`,
						);
					}
					if (/#EXT-X-MAP:/.test(child)) {
						const got = /#EXT-X-VERSION:(\d+)/.exec(child);
						const v = got ? Number(got[1]) : 0;
						if (v > 0 && v < 6) {
							report.warn(
								`${cid}:map-version`,
								"manifest",
								`${childKey} carries EXT-X-MAP at EXT-X-VERSION:${v} — RFC 8216 §7 places EXT-X-MAP at version 6 (players tolerate it; strict validators do not)`,
							);
						}
					}
				}
			}
			// Bind each child to its planned rendition (row 272). Run whether or not
			// the file parsed AS a master: if it did not, its variants/media are
			// empty and each planned rendition's `:present` FAILs — the right verdict
			// for a manifest that never enumerated them.
			if (manifest.hlsDefault) {
				await bindDefaultHlsTopology(
					report,
					id,
					manifest,
					parsed,
					deps,
					expected.muxings,
				);
			} else if (manifest.manifestRenditions) {
				bindHlsTopology(report, id, manifest.manifestRenditions, parsed, {
					perTitle: manifest.perTitle,
					...(manifest.hlsAudioGroups
						? { hlsAudioGroups: manifest.hlsAudioGroups }
						: {}),
					...(deps.perTitleActual
						? { perTitleActual: deps.perTitleActual }
						: {}),
				});
			}
		}

		if (manifest.kind === "DASH") {
			let parsed: ParsedDash;
			try {
				parsed = await deps.parseDash(text);
			} catch (err) {
				report.fail(
					`${id}:parse`,
					"manifest",
					`a real DASH parser rejected ${key}: ${err instanceof Error ? err.message : String(err)}`,
				);
				continue;
			}
			report.pass(
				`${id}:parse`,
				"manifest",
				`accepted by mpd-parser: ${parsed.representations.length} representation(s), ${parsed.periods} period(s)`,
			);
			// Same per-title reasoning as HLS above: `videoEntries` is a TEMPLATE count and
			// the encoder picks the ladder, so equality failed a correct encode
			// (`8 representation(s) — 4` against an honest MPD). Audio is NOT per-title, so
			// its count still holds exactly and stays the floor.
			/*
			 * Per KIND, not per total . Paid case 8 shipped an MPD with
			 * two audio representations and zero video beside four encoded WebM
			 * ladders; a total-only check can be satisfied by the wrong mix, and
			 * "4 video + 0 audio" passes "expected 4" as readily as "2 + 2".
			 */
			if (manifest.dashPeriods) {
				verifyDefaultDashPeriods(report, id, manifest, parsed, deps);
			} else {
				const videoReps = parsed.representations.filter(
					(r) => r.kind === "video",
				).length;
				const audioReps = parsed.representations.filter(
					(r) => r.kind === "audio",
				).length;
				const textReps = parsed.representations.filter(
					(r) => r.kind === "text",
				).length;
				const unknownReps = parsed.representations.filter(
					(r) => r.kind === "unknown",
				).length;
				// Per-title (review-325 I2): the template count is a FLOOR, as the
				// pre-existing total check already reasons — at least one video
				// representation, or paid case 8's audio-only MPD passes again.
				report.assert(
					`${id}:video-representations`,
					"manifest",
					manifest.perTitle
						? videoReps > 0
						: videoReps === manifest.videoEntries,
					manifest.perTitle
						? `per-title: at least one video representation — ${videoReps}`
						: `${manifest.videoEntries} video representation(s) — ${videoReps}`,
				);
				report.assert(
					`${id}:audio-representations`,
					"manifest",
					audioReps === manifest.audioEntries,
					`${manifest.audioEntries} audio representation(s) — ${audioReps}`,
				);
				report.assert(
					`${id}:text-representations`,
					"manifest",
					textReps === (manifest.textEntries ?? 0),
					`${manifest.textEntries ?? 0} text representation(s) — ${textReps}`,
				);
				if (manifest.imageEntries !== undefined)
					report.assert(
						`${id}:image-representations`,
						"manifest",
						parsed.representations.filter((row) => row.kind === "image")
							.length === manifest.imageEntries,
						`${manifest.imageEntries} image representation(s)`,
					);
				if (unknownReps > 0) {
					report.warn(
						`${id}:unclassified-representations`,
						"manifest",
						`${unknownReps} representation(s) declare neither contentType, mimeType, nor geometry — not counted toward either kind`,
					);
				}
			}
			await verifyDashFileReferences(report, deps, id, manifest, parsed, key);
			// Closure of every resolved playlist's references : the
			// parser expands the template/timeline/list into the objects a player
			// requests; without that expansion nothing can be checked, and the
			// report says so rather than passing.
			if (parsed.playlists && parsed.playlists.length > 0) {
				const listing = await listDeclaredManifestMedia(
					deps,
					expected,
					manifest,
				);
				const mpdDir = key.slice(0, key.lastIndexOf("/") + 1);
				const relative = (u: string) => !/^https?:/.test(u);
				const playlistIds = parsed.playlists.map((playlist, index) =>
					(playlist.id ?? `${playlist.kind}-${index}`).replace(/\W+/g, "-"),
				);
				const counts = new Map<string, number>();
				for (const value of playlistIds)
					counts.set(value, (counts.get(value) ?? 0) + 1);
				for (const [index, playlist] of parsed.playlists.entries()) {
					const name = playlistIds[index] as string;
					const pid = `${id}:playlist:${name}${(counts.get(name) ?? 0) > 1 ? `:period-${playlist.periodIndex ?? playlist.periodIndices?.join("-") ?? "unknown"}:entry-${index}` : ""}`;
					await verifyMediaClosure(
						report,
						deps,
						manifest.outputKey,
						listing,
						pid,
						{
							...(playlist.mapUri && relative(playlist.mapUri)
								? { mapKey: resolveReferencedKey(mpdDir, playlist.mapUri) }
								: {}),
							segmentKeys: playlist.segmentUris
								.filter(relative)
								.map((u) => resolveReferencedKey(mpdDir, u)),
						},
					);
				}
			} else {
				report.skip(
					`${id}:media-closure`,
					"manifest",
					"the parser exposed no resolved playlists — the referenced bytes cannot be checked",
				);
			}
			const textEntries = manifest.textEntries ?? 0;
			const imageEntries = manifest.imageEntries ?? 0;
			const wantTotal =
				manifest.videoEntries +
				manifest.audioEntries +
				textEntries +
				imageEntries;
			if (manifest.dashPeriods) {
				// Default counts and topology are checked against each declared period above.
			} else if (manifest.perTitle) {
				// Floor FAILS, ceiling WARNS — see the HLS branch above and
				// `verifyPerTitleRungs`. A real MPD enumerated 5 representations against a
				// ceiling of 3 and was right.
				const floor = Math.max(
					1,
					manifest.audioEntries + textEntries + imageEntries + 1,
				);
				if (parsed.representations.length > wantTotal) {
					report.warn(
						`${id}:representations-above-templates`,
						"manifest",
						`${parsed.representations.length} representations from ${manifest.audioEntries} audio + ${textEntries} text + ${manifest.videoEntries} per-title video template(s) — more than the templates alone explain, which the plan's perTitle config can legitimately produce`,
					);
				}
				report.assert(
					`${id}:representations`,
					"manifest",
					parsed.representations.length >= floor,
					`a per-title MPD declares at least ${floor} representations (${manifest.audioEntries} audio + ${textEntries} text + at least 1 encoder-chosen video) — ${parsed.representations.length}`,
				);
			} else {
				report.assert(
					`${id}:representations`,
					"manifest",
					parsed.representations.length === wantTotal,
					`${wantTotal} representation(s) — ${parsed.representations.length}`,
				);
			}
			// The dash-segment-timeline fixture exists for exactly this: TEMPLATE and
			// TIMELINE are different addressing modes and a plan pins one per manifest.
			if (manifest.dashRepresentationType && !manifest.dashOnDemand) {
				const want = manifest.dashRepresentationType;
				const wrong = parsed.representations.filter(
					(r) =>
						// IMSC references a complete TTML file through BaseURL;
						// segmented subtitles still obey the manifest's addressing mode.
						!(r.kind === "text" && r.addressing === "BASE") &&
						r.kind !== "image" &&
						!(
							r.addressing === "BASE" &&
							r.baseUrl &&
							manifest.dashProgressiveFiles?.includes(
								resolveReferencedKey(
									key.slice(0, key.lastIndexOf("/") + 1),
									r.baseUrl,
								),
							)
						) &&
						r.addressing !== want &&
						r.addressing !== "UNKNOWN",
				);
				report.assert(
					`${id}:addressing`,
					"manifest",
					wrong.length === 0,
					`every segmented representation addressed by ${want} — ${wrong.length} use(s) something else (${[...new Set(wrong.map((r) => r.addressing))].join(", ") || "none"})`,
				);
			}
			if (manifest.dashOnDemand) {
				const media = parsed.representations.filter(
					(row) => row.kind !== "image",
				);
				const base = media.filter((r) => r.addressing === "BASE");
				report.assert(
					`${id}:ondemand`,
					"manifest",
					base.length === media.length,
					`ON_DEMAND means SegmentBase for every media representation — ${base.length}/${media.length}`,
				);
			}
			// Bind codec↔AdaptationSet and each video representation to the plan
			// (row 272). Always run when the plan declares a topology, so a missing
			// representation FAILs rather than vanishing.
			if (manifest.manifestRenditions && !manifest.dashPeriods) {
				bindDashTopology(report, id, manifest.manifestRenditions, parsed, {
					perTitle: manifest.perTitle,
					...(deps.perTitleActual
						? { perTitleActual: deps.perTitleActual }
						: {}),
				});
			}
		}

		if (manifest.kind === "SMOOTH") {
			const wellFormed = /<SmoothStreamingMedia/i.test(text);
			report.assert(
				`${id}:smooth`,
				"manifest",
				wellFormed,
				`${key} must be a SmoothStreamingMedia document`,
			);
			// The check must not disappear on the EMPTIEST input. `if (levels > 0)` meant a
			// `<SmoothStreamingMedia></SmoothStreamingMedia>` with zero QualityLevels emitted
			// no check at all and the manifest passed — the same "a parser accepted it ≠ it
			// is a playlist" defect the HLS path already fixed, left unfixed for Smooth
			// (review catch).
			//
			// Per-title is the one case where the plan's count is not the truth: the encoder
			// chooses the rungs (C1/C4), so there the assertion is presence, not equality.
			const levels = (text.match(/<QualityLevel/gi) ?? []).length;
			const want = manifest.videoEntries + manifest.audioEntries;
			report.assert(
				`${id}:quality-levels`,
				"manifest",
				manifest.perTitle ? levels > 0 : levels === want,
				manifest.perTitle
					? `a per-title Smooth manifest must declare at least one QualityLevel (the encoder chooses how many) — ${levels}`
					: `${want} QualityLevel element(s) — ${levels}`,
			);
		}
	}
}

/** A generated representation must reference its captured RESULT, not an alias of another rung. */
function verifyDefaultDashPerTitleCoverage(
	report: ReportBuilder,
	id: string,
	manifest: ExpectedManifest,
	parsed: ParsedDash,
	periodIndex: number,
	deps: EngineDeps,
	selected: ReturnType<typeof scopedPerTitleResults>,
): void {
	if (selected.status !== "complete") return;
	const population = deps.perTitlePopulations;
	const outputId = deps.providerOutputIds?.[manifest.outputKey];
	const covered = new Set<string>();
	let unresolved = !outputId || !parsed.playlists?.length;
	if (population?.status === "complete" && outputId) {
		const root = new URL("https://manifest-storage.invalid/");
		const mpdUrl = storageObjectUrl(
			root,
			`${manifest.dir.prefix}${manifest.files[0] ?? "stream.mpd"}`,
		);
		for (const playlist of parsed.playlists ?? []) {
			if (playlist.kind !== "video") continue;
			const periods =
				playlist.periodIndices ??
				(playlist.periodIndex === undefined ? [] : [playlist.periodIndex]);
			if (parsed.periods > 1 && !periods.length) {
				unresolved = true;
				continue;
			}
			if (periods.length && !periods.includes(periodIndex)) continue;
			const refs = [
				...(playlist.mapUri ? [playlist.mapUri] : []),
				...playlist.segmentUris,
			];
			const keys = refs.map((uri) => referencedObjectKey(uri, mpdUrl, root));
			if (
				!playlist.segmentUris.length ||
				keys.some((key) => key === undefined)
			) {
				unresolved = true;
				continue;
			}
			const matches = selected.results.filter((result) =>
				population.deliveryMuxings.some(
					(muxing) =>
						muxing.streamId === result.streamId &&
						muxing.templateRendition === result.templateRendition &&
						(manifest.dashOnDemand
							? ["MP4", "PROGRESSIVE_WEBM"]
							: ["FMP4", "CMAF", "WEBM"]
						).includes(muxing.muxingType.toUpperCase()) &&
						muxing.legs.some((leg) => {
							if (leg.outputId !== outputId || leg.streamId !== result.streamId)
								return false;
							const directory = leg.resolvedPath.replace(/^\/+|\/+$/g, "");
							return (
								directory.length > 0 &&
								keys.every((key) => key?.startsWith(`${directory}/`))
							);
						}),
				),
			);
			if (matches.length === 1 && matches[0]) covered.add(matches[0].streamId);
			else if (matches.length > 1 || periods.length > 1) unresolved = true;
		}
	}
	for (const result of selected.results) {
		const cid = `${id}:pertitle-result:${result.streamId}:present`;
		if (!covered.has(result.streamId) && unresolved)
			report.skip(
				cid,
				"manifest",
				`UNVERIFIED — resolved period/media identities cannot establish whether RESULT ${result.streamId} is present`,
			);
		else
			report.assert(
				cid,
				"manifest",
				covered.has(result.streamId),
				`Selected RESULT ${result.streamId} must be referenced in this period; alternative representations cannot replace another RESULT`,
			);
	}
}

function verifyDefaultDashPeriods(
	report: ReportBuilder,
	id: string,
	manifest: ExpectedManifest,
	parsed: ParsedDash,
	deps: EngineDeps,
): void {
	const periods = manifest.dashPeriods ?? [];
	report.assert(
		`${id}:period-count`,
		"manifest",
		parsed.periods === periods.length,
		`${periods.length} configured period(s) — ${parsed.periods}`,
	);
	const identified =
		parsed.periods === 1 ||
		parsed.representations.every((row) => row.periodIndex !== undefined);
	for (const [index, period] of periods.entries()) {
		const pid = `${id}:period:${index}`;
		if (!identified) {
			report.skip(
				`${pid}:selection-metadata`,
				"manifest",
				"The parser did not expose period identity; per-period selection cannot be verified",
			);
			continue;
		}
		const representations = parsed.representations.filter(
			(row) => (row.periodIndex ?? 0) === index,
		);
		const selected = scopedPerTitleResults(
			deps.perTitlePopulations,
			period.perTitleSelection,
		);
		const population = deps.perTitlePopulations;
		if (
			population?.status === "complete" &&
			population.results.every(
				(result) => result.templateRendition !== undefined,
			)
		)
			for (const template of (period.perTitleSelection ?? []).filter(
				(row) => !row.optional && !row.conditional,
			))
				report.assert(
					`${pid}:pertitle-required:${template.renditionKey}`,
					"manifest",
					population.results.some(
						(result) => result.templateRendition === template.renditionKey,
					),
					`Selected fixed Per-Title template ${template.renditionKey} must produce a captured RESULT`,
				);
		for (const kind of ["video", "audio", "text"] as const) {
			const seen = representations.filter((row) => row.kind === kind).length;
			const { min: configuredMinimum, max } = period.counts[kind];
			const min =
				kind === "video" && selected.status === "complete"
					? Math.max(
							configuredMinimum,
							selected.results.length +
								period.topology.video.filter((row) => !row.optional).length,
						)
					: configuredMinimum;
			report.assert(
				`${pid}:${kind}-representations`,
				"manifest",
				seen >= min && (max === undefined || seen <= max),
				`${kind} representation count in [${min}, ${max ?? "runtime-defined"}] — ${seen}`,
			);
		}
		verifyDefaultDashPerTitleCoverage(
			report,
			pid,
			manifest,
			parsed,
			index,
			deps,
			selected,
		);
		report.assert(
			`${pid}:representation-kinds`,
			"manifest",
			representations.every(
				(row) => row.kind !== "unknown" && row.kind !== "image",
			),
			"Every Default representation belongs to a selected video, audio or subtitle family",
		);
		if (period.unverified.length)
			report.skip(
				`${pid}:selection-metadata`,
				"manifest",
				`Default selection is partially unverified: ${period.unverified.join("; ")}`,
			);
		bindDashTopology(
			report,
			pid,
			period.topology,
			{
				...parsed,
				representations,
				adaptationSets: parsed.adaptationSets?.filter(
					(row) => (row.periodIndex ?? 0) === index,
				),
			},
			{
				perTitle: period.perTitle,
				...(period.perTitle
					? {
							perTitleActual: scopedPerTitleVideoFamilies(
								deps.perTitlePopulations,
								period.perTitleSelection,
							),
						}
					: {}),
			},
		);
	}
	if (!identified) {
		for (const kind of ["video", "audio", "text"] as const) {
			const seen = parsed.representations.filter(
				(row) => row.kind === kind,
			).length;
			const min = periods.reduce(
				(sum, period) => sum + period.counts[kind].min,
				0,
			);
			const max = periods.some(
				(period) => period.counts[kind].max === undefined,
			)
				? undefined
				: periods.reduce(
						(sum, period) => sum + (period.counts[kind].max ?? 0),
						0,
					);
			report.assert(
				`${id}:${kind}-representations`,
				"manifest",
				seen >= min && (max === undefined || seen <= max),
				`Combined ${kind} count in [${min}, ${max ?? "runtime-defined"}] — ${seen}; period assignment remains unverified`,
			);
		}
	}
}

async function verifyDashFileReferences(
	report: ReportBuilder,
	deps: EngineDeps,
	id: string,
	manifest: ExpectedManifest,
	parsed: ParsedDash,
	key: string,
): Promise<void> {
	const available = [...parsed.representations];
	for (const [index, subtitle] of (
		manifest.dashExternalSubtitles ?? []
	).entries()) {
		const sid = `${id}:external-subtitle:${index}`;
		const match = available.findIndex(
			(row) =>
				row.kind === "text" &&
				row.baseUrl === subtitle.url &&
				(row.language === undefined || row.language === subtitle.language),
		);
		const representation =
			match >= 0 ? available.splice(match, 1)[0] : undefined;
		report.assert(
			`${sid}:reference`,
			"manifest",
			representation !== undefined,
			"External subtitle representation must reference its configured URL and language",
		);
		if (representation?.language === undefined)
			report.skip(
				`${sid}:language`,
				"manifest",
				"The parser exposed no language for the configured external subtitle",
			);
		else
			report.assert(
				`${sid}:language`,
				"manifest",
				representation.language === subtitle.language,
				`External subtitle language is ${subtitle.language}`,
			);
		report.skip(
			`${sid}:content`,
			"manifest",
			"External subtitle bytes were not fetched; URL binding does not prove remote availability or WebVTT validity",
		);
	}
	const directory = key.slice(0, key.lastIndexOf("/") + 1);
	for (const [index, file] of (manifest.dashProgressiveFiles ?? []).entries()) {
		const match = available.findIndex(
			(row) =>
				row.addressing === "BASE" &&
				row.baseUrl !== undefined &&
				resolveReferencedKey(directory, row.baseUrl) === file,
		);
		report.assert(
			`${id}:progressive-file:${index}`,
			"manifest",
			match >= 0,
			"Progressive representation must reference its configured complete media file",
		);
		if (match >= 0) available.splice(match, 1);
	}
	for (const [index, sprite] of (manifest.dashSprites ?? []).entries()) {
		const sid = `${id}:sprite:${index}`;
		const pattern = patternToRegExp(`${sprite.dir.pattern}${sprite.filename}`);
		const references = (row: ParsedDash["representations"][number]) =>
			row.imageUris?.length ? row.imageUris : row.baseUrl ? [row.baseUrl] : [];
		const match = available.findIndex(
			(row) =>
				row.kind === "image" &&
				references(row).length > 0 &&
				references(row).every(
					(uri) =>
						!/^[a-z][a-z\d+.-]*:/i.test(uri) &&
						pattern.test(resolveReferencedKey(directory, uri)),
				),
		);
		const image = match >= 0 ? available.splice(match, 1)[0] : undefined;
		if (
			!image &&
			available.some(
				(row) => row.kind === "image" && references(row).length === 0,
			)
		) {
			report.skip(
				`${sid}:reference`,
				"manifest",
				"The image representation was observed, but its generated image references were not exposed by the parser",
			);
			continue;
		}
		report.assert(
			`${sid}:reference`,
			"manifest",
			image !== undefined,
			"Sprite representation must reference the configured image path and filename",
		);
		if (!image) continue;
		const keys = [
			...new Set(
				references(image).map((uri) => resolveReferencedKey(directory, uri)),
			),
		];
		const listing = new Map(
			(await deps.listAll(sprite.outputKey, sprite.dir.prefix)).map((row) => [
				row.key,
				row,
			]),
		);
		report.assert(
			`${sid}:file`,
			"manifest",
			keys.every((key) => listing.has(key)),
			`Every sprite image referenced by the MPD must exist in its declared output (${keys.length} referenced)`,
		);
		if (keys.some((key) => listing.get(key)?.size === undefined))
			report.skip(
				`${sid}:bytes`,
				"manifest",
				"The storage listing exposed no size for one or more referenced sprite images",
			);
		else
			report.assert(
				`${sid}:bytes`,
				"manifest",
				keys.every((key) => (listing.get(key)?.size ?? 0) > 0),
				"Every referenced sprite image must contain bytes",
			);
	}
}

async function verifyDrm(
	report: ReportBuilder,
	deps: EngineDeps,
	expected: ExpectedArtefacts,
	drm: ExpectedDrm,
): Promise<void> {
	const id = `drm:${drm.drmKey}`;
	if (!drm.dir || !drm.outputKey) {
		report.skip(id, "drm", "the DRM row names no destination of its own");
		return;
	}
	const muxing = expected.muxings.find((m) =>
		m.viaDrmKeys?.includes(drm.drmKey),
	);
	const initName = muxing?.initSegment;
	if (!initName) {
		// TS has no init segment, and its encryption is signalled in the HLS media
		// playlist (`#EXT-X-KEY`) rather than in ISO-BMFF boxes — so a box scan is the
		// wrong instrument, not merely unavailable. Every FAIRPLAY row in the corpus
		// lands here, which means FairPlay is currently UNVERIFIED (§9b, review catch);
		// this SKIP says so rather than implying the check ran.
		report.skip(
			id,
			"drm",
			`${muxing?.container ?? "this container"} carries no init segment — its encryption is signalled in the playlist, not in ISO-BMFF boxes, so a box scan cannot verify it (FairPlay/TS is unverified)`,
		);
		return;
	}
	if (muxing?.container === "WEBM_SEGMENTED") {
		// `webmMuxingSchema` sets `initSegmentName: "init.hdr"`, so this used to proceed
		// and hand an EBML file to the MP4 box walker, which found no `pssh` and FAILED a
		// correct encode. WebM encryption lives in EBML ContentEncryption elements.
		report.skip(
			id,
			"drm",
			"WebM encryption lives in EBML ContentEncryption elements, not in ISO-BMFF boxes — the MP4 box walker cannot verify it",
		);
		return;
	}
	const listed = await deps.listAll(drm.outputKey, drm.dir.prefix);
	const init = listed.find((o) => o.key.endsWith(initName));
	if (
		!report.assert(
			`${id}:init`,
			"drm",
			init !== undefined,
			`encrypted init segment ${initName} under ${drm.dir.pattern} — ${init?.key ?? "absent"}`,
		)
	) {
		return;
	}
	let boxes: BoxFacts;
	try {
		// Bounded read: the boxes we need sit at the head of an init segment.
		const path = await deps.fetchObject(
			drm.outputKey,
			(init as ObjectEntry).key,
		);
		boxes = await deps.scanBoxes(path);
	} catch (err) {
		report.fail(
			`${id}:boxes`,
			"drm",
			`could not scan boxes: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	const seen = boxes.psshSystemIds.map((x) =>
		x.replace(/-/g, "").toLowerCase(),
	);
	if (drm.systemIds && drm.systemIds.length > 0) {
		// WHICH system, not merely how many. Counting boxes passed an init segment
		// encrypted for PlayReady against a plan configuring Widevine only — a wrong
		// artefact that reads as a working one, which is the worst kind (review catch).
		const missing = drm.systemIds.filter((want) => !seen.includes(want));
		report.assert(
			`${id}:pssh`,
			"drm",
			missing.length === 0,
			`pssh for every configured system ${drm.systemIds.join(", ")} — found ${seen.join(", ") || "none"}${missing.length > 0 ? `, missing ${missing.join(", ")}` : ""}`,
		);
	} else {
		report.assert(
			`${id}:pssh`,
			"drm",
			seen.length > 0,
			`at least one pssh box — found ${seen.length} (${seen.join(", ") || "none"})`,
		);
	}
	if (drm.schemeType) {
		report.assert(
			`${id}:schm`,
			"drm",
			boxes.schemeType === drm.schemeType,
			`schm scheme ${drm.schemeType} — ${boxes.schemeType ?? "absent"}`,
		);
	}
	if (drm.ivSizeBytes) {
		report.assert(
			`${id}:iv`,
			"drm",
			boxes.ivSizeBytes === drm.ivSizeBytes,
			`C9: default_IV_size ${drm.ivSizeBytes} — ${boxes.ivSizeBytes ?? "absent"}`,
		);
	}
	if (drm.kid) {
		report.assert(
			`${id}:kid`,
			"drm",
			boxes.defaultKid === drm.kid,
			`default_KID ${drm.kid} — ${boxes.defaultKid ?? "absent"}`,
		);
	}
}

function sameStringSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const a = [...new Set(left)].sort();
	const b = [...new Set(right)].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Verify each captured provider delivery leg once, at its resolved path. */
async function verifyPerTitleDeliveryPopulation(
	report: ReportBuilder,
	deps: EngineDeps,
	expected: ExpectedArtefacts,
): Promise<void> {
	const population = deps.perTitlePopulations;
	if (population === undefined) {
		return;
	}
	const binding = bindPerTitleDelivery(
		expected,
		population,
		deps.providerOutputIds ?? {},
	);
	if (binding.status === "unverified") {
		report.skip(
			"pertitle:population",
			"muxing",
			`UNVERIFIED per-title RESULT population: ${binding.reason}`,
		);
		return;
	}

	for (const template of binding.templates) {
		const id = `pertitle:template:${template.templateRendition}`;
		if (template.outcome === "missing") {
			report.fail(
				id,
				"muxing",
				`fixed template ${template.templateRendition} has no attributed provider RESULT`,
			);
		} else if (template.outcome === "unverified") {
			report.skip(
				id,
				"muxing",
				`UNVERIFIED flexible template ${template.templateRendition}: one or more provider RESULTs remain unattributed, so pruning cannot be asserted`,
			);
		} else {
			report.pass(
				id,
				"muxing",
				template.outcome === "notGenerated"
					? `flexible template ${template.templateRendition}: notGenerated (the provider legitimately pruned it)`
					: `${template.templateRendition}: attributed provider RESULT generated`,
			);
		}
	}
	for (const [index, issue] of binding.issues.entries()) {
		report.add(
			`pertitle:issue:${issue.code}:${index}`,
			"muxing",
			issue.verdict,
			issue.detail,
		);
	}

	const ids = binding.bindings.map(({ id }) => id);
	report.assert(
		"pertitle:delivery:check-ids-unique",
		"muxing",
		new Set(ids).size === ids.length,
		`delivery check identities are unique — ${new Set(ids).size}/${ids.length}`,
	);
	report.assert(
		"pertitle:delivery:reuse",
		"muxing",
		binding.reusedLegIds.length === 0,
		binding.reusedLegIds.length === 0
			? "artefact reuse 0: no provider material leg satisfies two templates"
			: `provider material legs reused: ${binding.reusedLegIds.join(", ")}`,
	);
	// Every issue blocks a full-population closure: an unattributed RESULT has
	// material legs that cannot enter the template-bound checked set. Restricting
	// this to path/muxing issues let the attributed subset close while a same-run
	// RESULT remained outside it.
	const closureIssueRows = binding.issues;
	const nonVacuous =
		binding.eligibleLegIds.length > 0 && binding.checkedLegIds.length > 0;
	const closure =
		nonVacuous &&
		sameStringSet(binding.eligibleLegIds, binding.checkedLegIds) &&
		closureIssueRows.length === 0;
	if (
		closureIssueRows.some((issue) => issue.verdict === "SKIP") &&
		!closureIssueRows.some((issue) => issue.verdict === "FAIL")
	) {
		report.skip(
			"pertitle:delivery:closure",
			"muxing",
			`UNVERIFIED output-leg closure — ${closureIssueRows.map((issue) => issue.detail).join("; ")}`,
		);
	} else {
		report.assert(
			"pertitle:delivery:closure",
			"muxing",
			closure,
			nonVacuous
				? `eligible provider output-leg set ${closure ? "equals" : "does not equal"} checked set — eligible [${binding.eligibleLegIds.join(", ")}], checked [${binding.checkedLegIds.join(", ")}]`
				: "provider output-leg closure is empty — no eligible material leg was checked",
		);
	}

	// Never emit the same delivery check id twice, even when corrupt evidence
	// itself carries a duplicate. The duplicate is already a FAIL above.
	const uniqueBindings = new Map<string, PerTitleDeliveryBinding>();
	for (const row of binding.bindings) {
		if (!uniqueBindings.has(row.id)) {
			uniqueBindings.set(row.id, row);
		}
	}
	for (const row of uniqueBindings.values()) {
		report.pass(
			`pertitle:delivery:${row.id}`,
			"muxing",
			`provider material leg ${row.actual.outputId}:${row.actual.resolvedPath} is bound once to ${row.expectedMuxing.muxingKey}`,
		);
		const { muxing, checks } = perTitleMediaExpectation(row);
		for (const check of checks) {
			report.add(check.id, "rendition", check.verdict, check.detail);
		}
		try {
			await verifyMuxing(report, deps, expected, muxing);
		} catch (error) {
			report.fail(
				`muxing:${muxing.muxingKey}:read`,
				"muxing",
				`could not inspect provider material leg ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (row.expectedDrm) {
			const drmKey = `${muxing.muxingKey}:drm`;
			const drm: ExpectedDrm = {
				...row.expectedDrm,
				drmKey,
				muxingKeys: [muxing.muxingKey],
				outputKey: row.outputKey,
				dir: muxing.dir,
			};
			try {
				await verifyDrm(
					report,
					deps,
					{ ...expected, muxings: [muxing], drm: [drm] },
					drm,
				);
			} catch (error) {
				report.fail(
					`drm:${drmKey}:read`,
					"drm",
					`could not inspect provider DRM leg ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

function resultStreamCounts(population: {
	results: Array<{ streamId: string }>;
}): Map<string, number> {
	const counts = new Map<string, number>();
	for (const result of population.results) {
		counts.set(result.streamId, (counts.get(result.streamId) ?? 0) + 1);
	}
	return counts;
}

/** Verify one decodable QC score unit per provider RESULT, not per output mirror. */
async function verifyPerTitleQcPopulation(
	report: ReportBuilder,
	deps: EngineDeps,
	expected: ExpectedArtefacts,
): Promise<void> {
	const population = deps.perTitlePopulations;
	const qc = expected.qc;
	if (population === undefined || qc === undefined) {
		return;
	}
	const perTitleKeys = new Set(
		expected.muxings
			.filter((muxing) => muxing.perTitle)
			.map((muxing) => muxing.renditionKey),
	);
	if (![...perTitleKeys].some((key) => qc.mirrorRenditionKeys.includes(key))) {
		return;
	}
	if (population.status !== "complete") {
		report.skip(
			"qc:pertitle:population",
			"qc",
			`UNVERIFIED per-title QC population: ${population.reason}`,
		);
		return;
	}

	const resultCounts = resultStreamCounts(population);
	const resultIdentityKeys: string[] = [];
	const populationIssues: string[] = [];
	if (population.results.length === 0) {
		populationIssues.push("provider RESULT population is empty");
	}
	for (const [streamId, count] of resultCounts) {
		if (count !== 1) {
			populationIssues.push(
				`provider RESULT ${streamId} occurs ${count} times`,
			);
		}
	}
	for (const result of population.results) {
		if (resultCounts.get(result.streamId) !== 1) {
			continue;
		}
		if (result.templateRendition === undefined) {
			populationIssues.push(
				`provider RESULT ${result.streamId} is unattributed`,
			);
			continue;
		}
		if (!perTitleKeys.has(result.templateRendition)) {
			populationIssues.push(
				`provider RESULT ${result.streamId} names unknown template ${result.templateRendition}`,
			);
			continue;
		}
		resultIdentityKeys.push(`${result.templateRendition}:${result.streamId}`);
	}
	const eligibleResults = population.results.filter(
		(result) =>
			resultCounts.get(result.streamId) === 1 &&
			result.templateRendition !== undefined &&
			perTitleKeys.has(result.templateRendition),
	);
	const qcByStream = new Map<string, PerTitleActualQcUnit[]>();
	for (const unit of population.qc) {
		qcByStream.set(unit.streamId, [
			...(qcByStream.get(unit.streamId) ?? []),
			unit,
		]);
	}
	const qcIdentityKeys: string[] = [];
	for (const [streamId, units] of qcByStream) {
		if (units.length !== 1) {
			populationIssues.push(
				`provider RESULT ${streamId} has ${units.length} QC population rows`,
			);
			continue;
		}
		const unit = units[0] as PerTitleActualQcUnit;
		if (unit.templateRendition === undefined) {
			populationIssues.push(`QC unit for RESULT ${streamId} is unattributed`);
			continue;
		}
		if (!perTitleKeys.has(unit.templateRendition)) {
			populationIssues.push(
				`QC unit for RESULT ${streamId} names unknown template ${unit.templateRendition}`,
			);
			continue;
		}
		qcIdentityKeys.push(`${unit.templateRendition}:${streamId}`);
	}
	const resultSetClosed =
		populationIssues.length === 0 &&
		resultIdentityKeys.length > 0 &&
		sameStringSet(resultIdentityKeys, qcIdentityKeys) &&
		resultIdentityKeys.length === qcIdentityKeys.length;
	const expectedUnits: string[] = [];
	const checkedUnits: string[] = [];
	for (const result of eligibleResults) {
		const template = result.templateRendition as string;
		const units = qcByStream.get(result.streamId) ?? [];
		if (units.length !== 1) {
			report.fail(
				`qc:pertitle:result:${template}:${result.streamId}`,
				"qc",
				`RESULT ${result.streamId} must contribute exactly one QC score unit — found ${units.length}`,
			);
			continue;
		}
		const unit = units[0] as PerTitleActualQcUnit;
		const unitKey = `${template}:${unit.variant}`;
		expectedUnits.push(unitKey);
		const mirror = qc.mirrors.find(
			(candidate) => candidate.renditionKey === template,
		);
		if (!mirror) {
			report.fail(
				`qc:pertitle:unit:${template}:${result.streamId}`,
				"qc",
				`RESULT ${result.streamId} is attributed to ${template}, which has no planned QC mirror`,
			);
			continue;
		}
		const allowedOutputKeys = [
			mirror.outputKey,
			...(expected.deliveryMirrorOutputKeys ?? []),
		];
		const allowed = new Map(
			allowedOutputKeys.flatMap((outputKey) => {
				const providerId = deps.providerOutputIds?.[outputKey];
				return providerId ? [[providerId, outputKey] as const] : [];
			}),
		);
		if (allowed.size === 0) {
			report.skip(
				`qc:pertitle:unit:${template}:${result.streamId}`,
				"qc",
				`UNVERIFIED: no provider output id is recorded for QC outputs ${allowedOutputKeys.join(", ")}`,
			);
			continue;
		}
		const candidates = unit.mirrors.filter((candidate) =>
			allowed.has(candidate.outputId),
		);
		const primaryId = deps.providerOutputIds?.[mirror.outputKey];
		const selected =
			candidates.find((candidate) => candidate.outputId === primaryId) ??
			candidates[0];
		if (!selected) {
			report.fail(
				`qc:pertitle:unit:${template}:${result.streamId}`,
				"qc",
				`RESULT ${result.streamId} has no decodable QC mirror on provider output(s) ${[...allowed.keys()].join(", ")}`,
			);
			continue;
		}
		const id = `qc:pertitle:unit:${template}:${result.streamId}:${unit.variant}`;
		const outputKey = allowed.get(selected.outputId) as string;
		const metadataOk =
			selected.filename === mirror.filename &&
			patternToRegExp(mirror.dir.pattern).test(selected.resolvedPath);
		report.assert(
			id,
			"qc",
			metadataOk,
			`QC score unit ${unitKey}: ${selected.outputId}:${selected.resolvedPath}${selected.filename ?? "(filename absent)"}; expected ${mirror.dir.pattern}${mirror.filename}`,
		);
		const duplicateCandidates = unit.mirrors.filter(
			(candidate) =>
				candidate.outputId === selected.outputId &&
				candidate.resolvedPath === selected.resolvedPath &&
				candidate.filename === selected.filename,
		);
		const candidateUnique = duplicateCandidates.length === 1;
		if (!candidateUnique) {
			report.fail(
				`${id}:duplicate`,
				"qc",
				`the selected QC mirror candidate appears ${duplicateCandidates.length} times`,
			);
		}
		const listed = await deps.listAll(outputKey, selected.resolvedPath);
		const key = `${selected.resolvedPath}${selected.filename ?? mirror.filename}`;
		const hit = listed.find((object) => object.key === key);
		if (
			!report.assert(
				`${id}:present`,
				"qc",
				hit !== undefined,
				`${key} — ${hit ? "present" : "absent"}`,
			) ||
			!hit
		) {
			continue;
		}
		const bytesOk = hit.size !== undefined && hit.size > 0;
		if (hit.size === undefined) {
			report.skip(
				`${id}:bytes`,
				"qc",
				`the listing reported no size for ${key}`,
			);
		} else {
			report.assert(
				`${id}:bytes`,
				"qc",
				hit.size > 0,
				`QC mirror must carry bytes — ${hit.size}`,
			);
		}
		try {
			const local = await deps.fetchConcatenated(outputKey, [key]);
			const probe = await deps.probe(local);
			const videoOk = (probe.height ?? 0) > 0;
			report.assert(
				`${id}:video`,
				"qc",
				videoOk,
				`the QC score unit must carry video — height ${probe.height ?? "none"}`,
			);
			if (metadataOk && candidateUnique && bytesOk && videoOk) {
				checkedUnits.push(unitKey);
			}
		} catch (error) {
			report.fail(
				`${id}:video`,
				"qc",
				`could not probe ${key}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const qcUnitKeys = population.qc
		.filter(
			(unit) =>
				resultCounts.get(unit.streamId) === 1 &&
				unit.templateRendition !== undefined &&
				perTitleKeys.has(unit.templateRendition),
		)
		.map((unit) => `${unit.templateRendition}:${unit.variant}`);
	report.assert(
		"qc:pertitle:result-set",
		"qc",
		resultSetClosed &&
			resultIdentityKeys.length === resultCounts.size &&
			sameStringSet(expectedUnits, qcUnitKeys) &&
			expectedUnits.length === qcUnitKeys.length,
		`provider RESULT/QC identity set equality — RESULT [${resultIdentityKeys.sort().join(", ")}], QC [${qcIdentityKeys.sort().join(", ")}]; score units RESULT [${expectedUnits.sort().join(", ")}], QC [${qcUnitKeys.sort().join(", ")}]${populationIssues.length ? `; ${populationIssues.join("; ")}` : ""}`,
	);
	report.assert(
		"qc:pertitle:closure",
		"qc",
		resultSetClosed &&
			expectedUnits.length > 0 &&
			sameStringSet(expectedUnits, checkedUnits) &&
			expectedUnits.length === checkedUnits.length,
		`QC expected/result set equality — expected [${expectedUnits.sort().join(", ")}], checked [${checkedUnits.sort().join(", ")}]`,
	);
}

/** The engine's entry point. */
export async function verifyArtefacts(
	expected: ExpectedArtefacts,
	deps: EngineDeps,
): Promise<VerificationReport> {
	const report = new ReportBuilder();
	const usesActualPerTitlePopulation = deps.perTitlePopulations !== undefined;
	await verifyPerTitleDeliveryPopulation(report, deps, expected);

	for (const muxing of expected.muxings) {
		if (usesActualPerTitlePopulation && muxing.perTitle) {
			continue;
		}
		await verifyMuxing(report, deps, expected, muxing);
	}
	for (const manifest of expected.manifests) {
		await verifyManifest(report, deps, manifest, expected);
	}
	for (const drm of expected.drm) {
		if (
			usesActualPerTitlePopulation &&
			expected.muxings.some(
				(muxing) =>
					muxing.perTitle && drm.muxingKeys.includes(muxing.muxingKey),
			)
		) {
			continue;
		}
		await verifyDrm(report, deps, expected, drm);
	}

	for (const thumb of expected.thumbnails) {
		const listed = await deps.listAll(thumb.outputKey, thumb.dir.prefix);
		const rx = patternToRegExp(thumb.pattern);
		const hits = listed.filter((o) => rx.test(o.key.split("/").pop() ?? ""));
		report.assert(
			`thumbnails:${thumb.thumbnailKey}`,
			"thumbnails",
			hits.length === thumb.count,
			`${thumb.count} thumbnail(s) matching ${thumb.pattern} — found ${hits.length}`,
		);
	}

	for (const sprite of expected.sprites) {
		const listed = await deps.listAll(sprite.outputKey, sprite.dir.prefix);
		const images = listed.filter((o) => /\.(jpe?g|png)$/i.test(o.key));
		report.assert(
			`sprites:${sprite.spriteKey}:images`,
			"sprites",
			images.length > 0,
			`at least one sprite image under ${sprite.dir.pattern} — found ${images.length}`,
		);
		if (sprite.vttName) {
			const vtt = listed.find((o) => o.key.endsWith(sprite.vttName as string));
			report.assert(
				`sprites:${sprite.spriteKey}:vtt`,
				"sprites",
				vtt !== undefined,
				`sprite index ${sprite.vttName} — ${vtt?.key ?? "absent"}`,
			);
		}
	}

	/**
	 * ---- QC mirrors -------------------------------------------------------------
	 *
	 * The mirror MP4 the compiler creates for every video rendition, which NOTHING verified.
	 * `expected.qc` carried `mirrorRenditionKeys` and `mirrorDirSuffix` and the engine never
	 * read either field, so a `qc.only` plan verified nothing at all — and worse, it FAILed,
	 * because the expectation demanded delivery segments the compiler deliberately never emits.
	 * A real run reported `vmaf-only-h264` as `PASS 0 · FAIL 2` on an encoding that had written
	 * exactly what it should: `output/vmaf-only-h264/video/540p/qc/v540.mp4`.
	 *
	 * The mirror is a progressive MP4, so it is probed as a single self-contained file — no init
	 * to assemble.
	 */
	await verifyPerTitleQcPopulation(report, deps, expected);
	const perTitleRenditionKeys = new Set(
		expected.muxings
			.filter((muxing) => muxing.perTitle)
			.map((muxing) => muxing.renditionKey),
	);
	for (const mirror of expected.qc?.mirrors ?? []) {
		if (
			usesActualPerTitlePopulation &&
			perTitleRenditionKeys.has(mirror.renditionKey)
		) {
			continue;
		}
		const listed = await deps.listAll(mirror.outputKey, mirror.dir.prefix);
		const hit = listed.find((o) => o.key.endsWith(mirror.filename));
		const present = report.assert(
			`qc:mirror:${mirror.renditionKey}`,
			"muxing",
			hit !== undefined,
			`QC mirror ${mirror.dir.pattern}${mirror.filename} — ${hit?.key ?? "absent"}`,
		);
		if (!present || hit === undefined) {
			continue;
		}
		// It must carry BYTES. A zero-length mirror scores no VMAF and would otherwise read as
		// a healthy QC run — the same false green `:segment-bytes` exists for.
		if (hit.size === undefined) {
			report.skip(
				`qc:mirror:${mirror.renditionKey}:bytes`,
				"muxing",
				`the listing reported no size for ${hit.key}, so its content could not be checked`,
			);
		} else {
			report.assert(
				`qc:mirror:${mirror.renditionKey}:bytes`,
				"muxing",
				hit.size > 0,
				`QC mirror must carry bytes — ${hit.size}`,
			);
		}
		try {
			const path = await deps.fetchConcatenated(mirror.outputKey, [hit.key]);
			const probe = await deps.probe(path);
			report.assert(
				`qc:mirror:${mirror.renditionKey}:video`,
				"rendition",
				(probe.height ?? 0) > 0,
				`the QC mirror must carry a video stream — height ${probe.height ?? "none"}`,
			);
		} catch (err) {
			report.fail(
				`qc:mirror:${mirror.renditionKey}:video`,
				"rendition",
				`could not probe the QC mirror ${hit.key}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * ---- hygiene: nothing but this run's artefacts may be under the prefixes ---
	 *
	 * This is the check that would have caught a shared output prefix holding
	 * another run's manifests and 50+ stale segments .
	 *
	 * THE RULE, stated here because it is the rule the report gates on and it has
	 * been wrong once . An object under this plan's prefixes is
	 * FOREIGN when — and only when — one of two things is true of WHERE or WHEN it
	 * was written:
	 *
	 *   it predates the run   `lastModified` earlier than the job row's own
	 *                         creation: pre-existing debris, whatever it is called.
	 *   it is out of place    the key sits in no directory this plan can write
	 *                         into (`makeForeignKeyFilter` builds that set from the
	 *                         expectation's muxing / DRM / manifest / thumbnail /
	 *                         sprite / QC directories, placeholders intact).
	 *
	 * Never "the expectation does not name this file". A per-title run NAMES ITS
	 * OWN ARTEFACTS — the manifest generator resolves `video_{avgBitrate}.m3u8`
	 * from the rungs the encoder chose — so a name-based population is missing
	 * exactly the files the encoder produced, and this check reported six of them
	 * as somebody else's on the billed re-audit run `pertitle-h264-fmp4-ts-dash-
	 * hls-on-aws` (481 PASS, this one FAIL). Calling a run's own bytes foreign is
	 * the same class of false verdict as calling a missing rung present.
	 *
	 * The detail NAMES the offenders. It reported a bare count, and a count is the
	 * one thing that cannot be argued with or diagnosed: the paid run's "6" cost a
	 * separate investigation to turn into "the six per-title variant playlists".
	 */
	if (deps.foreignKeyFilter) {
		const prefixes = new Set(
			[
				...expected.muxings.map((m) => `${m.outputKey}\0${m.dir.prefix}`),
				...expected.manifests.map((m) => `${m.outputKey}\0${m.dir.prefix}`),
			].filter((p) => !p.startsWith("\0")),
		);
		const foreign = new Set<string>();
		for (const combined of prefixes) {
			const [outputKey, prefix] = combined.split("\0") as [string, string];
			for (const o of await deps.listAll(outputKey, prefix)) {
				if (deps.foreignKeyFilter(o.key, o)) {
					foreign.add(o.key);
				}
			}
		}
		// FAIL, not WARN: design §8 makes foreign objects in the prefix a phase-A exit
		// failure, and this check only runs when `--strict-prefix` was passed — a flag
		// whose whole purpose is to make contamination fatal. A WARN here is what let the
		// stale-artefact incident read as a healthy run with a note (review catch).
		const named = [...foreign].sort().slice(0, FOREIGN_KEYS_NAMED);
		report.add(
			"hygiene:foreign-objects",
			"hygiene",
			foreign.size === 0 ? "PASS" : "FAIL",
			`objects under this plan's prefixes that this run did not write (written before the job, or in a directory the plan never writes to) — ${foreign.size}${
				named.length > 0
					? `: ${named.join(", ")}${foreign.size > named.length ? `, and ${foreign.size - named.length} more` : ""}`
					: ""
			}`,
		);
	}

	return report.build(expected.planName);
}
