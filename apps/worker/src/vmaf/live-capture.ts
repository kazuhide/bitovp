import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LiveCaptureTarget } from "@bitovp/core";
import {
	type BrowserCredential,
	createBrowserForCredential,
	type ObjectStorageBrowser,
	type StorageObject,
} from "@bitovp/storage";
import {
	expandRandomFilenameTokens,
	initSegmentCandidates,
} from "../bitmovin/filename-template";
import type { ResolvedCredential } from "../orchestrator/executor";

/**
 * Live segment capture (P4-PR6b). Reconstructs the "distorted" clip for a
 * pseudo-live VMAF run from the live encoder's OUTPUT segments — there is no
 * `qc/<key>.mp4` mirror for live, only the HLS/DASH segments the encoder keeps
 * writing. The capture window is the most-recent `windowSeconds` of segments
 * (the DVR/timeshift tail), discovered by listing the rendition's segment
 * prefix and filtering by object `lastModified`.
 *
 * STORAGE DEPENDENCY. This needs `listObjects` (recursive, paginated — the
 * default browser list uses a "/" delimiter and returns folders, so we list
 * RECURSIVELY here by paging Contents under the prefix) plus `getObject`. Both
 * exist on every browser the factory returns — the S3 family, GCS AND Azure;
 * other providers fail loud. That sentence used to read "S3-family + GCS (the
 * only providers the feeder + VMAF download already require)", which was an
 * accurate description of the world on the day it was written: this file
 * landed 2026-06-18 and `createAzureBrowser` did not exist until 2026-08-06.
 * Seven weeks made it stale, and it read as a capability limit rather than a
 * date — it is why AZURE was left out of the gate this file sits behind
 * . The browser is injected
 * via `makeBrowser` so the worker test can fake the whole listing.
 *
 * CONCAT STRATEGY mirrors the container:
 *  - fMP4: the init segment (`init.mp4`) followed by the ordered `.m4s` media
 *    fragments, BYTE-concatenated into one `.mp4` — that is the fMP4 contract
 *    (a player does exactly this). The first cut handed init + fragments to
 *    ffmpeg's concat DEMUXER as a list, which opens every entry as a
 *    standalone container: a bare `.m4s` has no `moov`, so each fragment fails
 *    with "trun track id unknown, no tfhd was found" and the clip decodes to
 *    ZERO frames. That is the paid audit's Live A/E result (893eb66 §7.3,
 *    "signalstats no packets", "decoded zero frames", results 0) while every
 *    segment was individually probe-able; reproduced locally on 2026-08-28
 *    against a 75-frame testsrc (concat demuxer: cannot open segment_0.m4s;
 *    byte-concat: 75/75 frames). .
 *  - TS: MPEG-TS segments are self-framing and legally byte-concatenate, so we
 *    stream them into a single .ts in order (no init).
 * The worker then probes/decodes the concatenated clip for signatures + libvmaf.
 */

/** A discovered segment: storage key + parsed sequence number + mtime. */
export type DiscoveredSegment = {
	key: string;
	/** %number% value parsed from the name (for deterministic ordering). */
	number: number;
	lastModified?: string;
};

/**
 * How the captured window was chosen . "window" is the real DVR
 * tail `[now − windowSeconds, now]` by mtime; the two tail modes are the
 * fallbacks the old code took silently — named here so a result can say
 * which frames it scored and why.
 */
export type CaptureSelectionMode =
	| "window"
	| "tail-no-mtimes"
	| "tail-empty-window";

export type CaptureSelection = {
	mode: CaptureSelectionMode;
	/** The bounds applied (ISO-8601), present in "window" mode. */
	from?: string;
	to?: string;
	/** True when the selected segments' numbers are consecutive. */
	contiguous: boolean;
	segmentCount: number;
	/** In-window segments left out because a gap separated them from the newest run. */
	droppedForGap: number;
	/**
	 * Listed segments whose mtime lies AFTER the sealed `now` — a storage clock
	 * running ahead of the worker shifts the window older by that skew; this
	 * count makes it visible (0 in the tail modes).
	 */
	droppedAfterNow: number;
};

/** What `selectWindowSegments` answers: the segments and how they were chosen. */
export type WindowSelection = {
	segments: DiscoveredSegment[];
	selection: CaptureSelection;
};

/** The longest run of consecutive numbers ending at the LAST segment. */
function newestContiguousRun(sorted: DiscoveredSegment[]): DiscoveredSegment[] {
	let start = sorted.length - 1;
	while (
		start > 0 &&
		(sorted[start - 1] as DiscoveredSegment).number ===
			(sorted[start] as DiscoveredSegment).number - 1
	) {
		start -= 1;
	}
	return sorted.slice(Math.max(0, start));
}

function isContiguous(sorted: DiscoveredSegment[]): boolean {
	for (let i = 1; i < sorted.length; i++) {
		if (
			(sorted[i] as DiscoveredSegment).number !==
			(sorted[i - 1] as DiscoveredSegment).number + 1
		) {
			return false;
		}
	}
	return true;
}

export type CaptureBrowserFactory = (
	credential: ResolvedCredential,
) => ObjectStorageBrowser;

/** Default browser factory — the same mapping the VMAF download uses. */
export const defaultCaptureBrowserFactory: CaptureBrowserFactory = (
	credential,
) =>
	createBrowserForCredential({
		provider: credential.provider as BrowserCredential["provider"],
		config: credential.config,
		secret: credential.secret,
	});

/**
 * Builds a RegExp + capture for a `%number%`-templated segment name so a
 * listed object can be recognised and its sequence number parsed. The template
 * is otherwise treated literally (its non-%number% chars are escaped). e.g.
 * "segment_%number%.m4s" → /^segment_(\d+)\.m4s$/.
 */
export function segmentNamePattern(segmentNaming: string): RegExp {
	const escaped = segmentNaming
		.split("%number%")
		.map((part) =>
			expandRandomFilenameTokens(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		)
		.join("(\\d+)");
	return new RegExp(`^${escaped}$`);
}

/** Basename of a storage key (the part after the last "/"). */
function baseName(key: string): string {
	const slash = key.lastIndexOf("/");
	return slash >= 0 ? key.slice(slash + 1) : key;
}

/**
 * Recursively lists every object under `prefix` (no delimiter — the default
 * browser list collapses folders; for capture we want the leaf segment
 * objects). Paginates with the cursor (C6: limit ≤ 100, always paginate).
 */
export async function listAllUnderPrefix(
	browser: ObjectStorageBrowser,
	bucket: string,
	prefix: string,
): Promise<StorageObject[]> {
	/**
	 * SCOPE the prefix to a directory before listing .
	 *
	 * `segmentPrefix` is the muxing destination path verbatim, so it does not
	 * end in "/". Without a delimiter that makes it a plain string prefix, and
	 * `out/v1080` then also matches `out/v1080p/...` — a DIFFERENT rendition of
	 * the same ladder. `selectWindowSegments` cannot separate them: it matches
	 * basenames against `segmentNaming`, and every rung shares one template. So
	 * two renditions' segments interleave into one concatenated clip and are
	 * scored as one.
	 *
	 * That is worse than the bug this function just fixed. Before the recursion
	 * flag the same topology failed LOUDLY ("no segments"); after it, and
	 * without this line, it returns a wrong VMAF number and says nothing — the
	 * exact trade this repo refused on  (routing a kind through so
	 * the failure changes shape rather than going away). Review caught it in
	 * the same round that confirmed the recursion fix.
	 *
	 * An empty prefix stays empty: "" means the whole container, and turning it
	 * into "/" would silently scope to a root directory that does not exist.
	 * `destinationSchema.path` has no `min(1)`, so "" is reachable.
	 */
	const scoped = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
	const all: StorageObject[] = [];
	let cursor: string | undefined;
	// Guard against a pathological unbounded listing (a huge DVR window); the
	// most-recent window is what we keep anyway, but we must terminate.
	//
	// 2000 × 100 = 200k objects, comfortably above a DVR tail (3h at 6s ≈ 1800
	// segments per rendition). The hazard is not the number, it is the SILENCE:
	// keys come back lexicographically, so hitting the cap drops the LAST ones
	// — which for time-ordered segment names are the most recent, i.e. exactly
	// the tail this function exists to find.  recorded that a
	// truncated listing should say so rather than return a quietly short list;
	//  (paid audit MODERATE-15) decides what the caller does with a
	// partial window: nothing. A window this function could not finish
	// listing is not a window, and a VMAF over a guessed tail is the false
	// green this pipeline exists to refuse — so the cap THROWS, by name.
	const MAX_PAGES = 2000;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await browser.listObjects({
			bucket,
			prefix: scoped,
			cursor,
			limit: 100,
			// REQUIRED, and its absence made this function return nothing at all
			// against any real browser . Both drivers apply a "/"
			// delimiter unless asked not to — `s3.ts:110` sets
			// `Delimiter: input.recursive ? undefined : "/"`, `azure.ts:96`
			// branches to `listBlobsFlat` only when it is set. `segmentPrefix` is
			// the muxing destination path with NO trailing slash
			// (`live-targets.ts:116` takes `destination.path` verbatim), so every
			// `<prefix>/seg-N.ts` collapsed into a CommonPrefix and `objects` came
			// back EMPTY. The docblock above already said "no delimiter"; the call
			// did not implement it.
			//
			// Invisible because the test double ignored its input entirely and
			// replayed canned pages, and because its one prefix ("a/") carried a
			// trailing slash the real caller never has.
			recursive: true,
		});
		all.push(...res.objects);
		if (!res.nextCursor) {
			return all;
		}
		cursor = res.nextCursor;
	}
	throw new Error(
		`live capture listing under "${scoped}" was truncated at ${MAX_PAGES * 100} objects — the window would be a partial guess, so this rendition is not scored (narrow the prefix or clean the DVR tail; ledger #213)`,
	);
}

/**
 * Discovers the segments to capture for ONE rendition: lists the prefix,
 * keeps the objects whose basename matches the segment template, parses each
 * one's sequence number, then selects the MOST-RECENT window. Selection is by
 * `lastModified` when present (the true DVR tail), falling back to the highest
 * sequence numbers when storage omits mtimes (e.g. some S3-compatible stores).
 *
 * `windowSeconds` × an assumed segment cadence is NOT used to count segments;
 * instead the window is taken as [now − windowSeconds, now] over lastModified
 * — BOTH bounds (: an object written after the sealed `now` is not
 * part of the sealed window), and only the newest CONTIGUOUS run by sequence
 * number (a gap means a missing segment, and a clip concatenated across it
 * would score a jump the encoder never emitted). With no mtimes we
 * approximate by keeping the last `fallbackCount` segments. Every path names
 * itself in `selection` so the result can say what it scored.
 */
export function selectWindowSegments(
	objects: StorageObject[],
	target: LiveCaptureTarget,
	opts: { windowSeconds: number; now: number; fallbackCount: number },
): WindowSelection {
	const pattern = segmentNamePattern(target.segmentNaming);
	const matched: DiscoveredSegment[] = [];
	for (const obj of objects) {
		const m = pattern.exec(baseName(obj.key));
		if (!m) {
			continue;
		}
		const number = Number.parseInt(m[1] as string, 10);
		if (!Number.isFinite(number)) {
			continue;
		}
		matched.push({ key: obj.key, number, lastModified: obj.lastModified });
	}
	// Order by sequence number (the playback order) — stable regardless of how
	// the store returned the list.
	matched.sort((a, b) => a.number - b.number);

	const haveMtimes = matched.some((s) => s.lastModified);
	if (haveMtimes) {
		const cutoff = opts.now - opts.windowSeconds * 1000;
		const mtimeOf = (s: { lastModified?: string }): number =>
			s.lastModified ? Date.parse(s.lastModified) : Number.NaN;
		const recent = matched.filter((s) => {
			const t = mtimeOf(s);
			return Number.isFinite(t) && t >= cutoff && t <= opts.now;
		});
		const droppedAfterNow = matched.filter((s) => {
			const t = mtimeOf(s);
			return Number.isFinite(t) && t > opts.now;
		}).length;
		// If the window caught nothing (clock skew / a paused encoder), fall back
		// to the tail so a capture still has frames to align.
		if (recent.length > 0) {
			const run = newestContiguousRun(recent);
			return {
				segments: run,
				selection: {
					mode: "window",
					from: new Date(cutoff).toISOString(),
					to: new Date(opts.now).toISOString(),
					contiguous: true,
					segmentCount: run.length,
					droppedForGap: recent.length - run.length,
					droppedAfterNow,
				},
			};
		}
	}
	const tail = matched.slice(Math.max(0, matched.length - opts.fallbackCount));
	return {
		segments: tail,
		selection: {
			mode: haveMtimes ? "tail-empty-window" : "tail-no-mtimes",
			contiguous: isContiguous(tail),
			segmentCount: tail.length,
			droppedForGap: 0,
			droppedAfterNow: 0,
		},
	};
}

/**
 * Downloads a single object to a local path, streaming via getObject. Mirrors
 * the VMAF download's failure discipline (destroy both ends + remove the
 * partial). Throws when the provider cannot stream.
 */
async function downloadObject(
	browser: ObjectStorageBrowser,
	bucket: string,
	key: string,
	destPath: string,
): Promise<void> {
	if (!browser.getObject) {
		throw new Error(
			"live capture needs a download-capable storage credential (the S3 family, GCS or Azure — `vmafSourceFor` in core holds the authoritative set) for the output segments",
		);
	}
	const stream = await browser.getObject({ bucket, key });
	const sink = createWriteStream(destPath);
	try {
		await pipeline(stream, sink);
	} catch (err) {
		(stream as { destroy?(error?: Error): void }).destroy?.();
		sink.destroy();
		await rm(destPath, { force: true }).catch(() => {});
		throw err;
	}
}

/** Result of capturing one rendition's window. */
export type CapturedClip = {
	/**
	 * Local path to ONE playable clip: init + fragments byte-concatenated
	 * (`.mp4`) or the TS segments byte-concatenated (`.ts`). A plain `-i` for
	 * ffmpeg either way — never a concat-demuxer list .
	 */
	clipPath: string;
	container: "FMP4" | "TS";
	/** Ordered local segment paths (init first for fMP4); for cleanup. */
	localPaths: string[];
	/** How many media segments (excludes the init) made it into the clip. */
	segmentCount: number;
	/**
	 * Ordered STORAGE keys byte-concatenated into the clip — the fMP4 init first
	 * when there is one, then the media segments in sequence order. The distorted
	 * side's provenance (paid re-audit eb7c983 HIGH-1): a live score is over N
	 * objects assembled at read time, so "which object" is a list, not a key.
	 */
	keys: string[];
	/**
	 * SHA-256 of the ASSEMBLED clip — the exact bytes ffmpeg decodes, not a
	 * per-segment digest. Taken from the concatenation as it is written, so it
	 * costs no second pass over the file.
	 */
	sha256: string;
	/** Byte length of the assembled clip. */
	bytes: number;
	/** How the window was chosen  — recorded on the result. */
	selection: CaptureSelection;
};

export type CaptureDeps = {
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	makeBrowser?: CaptureBrowserFactory;
};

/**
 * Captures ONE rendition's recent window: lists + selects segments, downloads
 * the init (fMP4) and the media segments into `jobDir`, and byte-concatenates
 * them — init first, then the fragments in order — into one clip ffmpeg reads
 * with a plain `-i`. The same append for both containers; see the module
 * comment for why fMP4 must NOT go through the concat demuxer .
 *
 * Returns the prepared clip handle plus the segment count. Throws when the
 * window is empty (no segments under the prefix — the encoder may not have
 * written yet, or the prefix is wrong).
 */
export async function captureRenditionWindow(args: {
	deps: CaptureDeps;
	credential: ResolvedCredential;
	bucket: string;
	target: LiveCaptureTarget;
	jobDir: string;
	windowSeconds: number;
	now: number;
	fallbackCount: number;
}): Promise<CapturedClip> {
	const makeBrowser = args.deps.makeBrowser ?? defaultCaptureBrowserFactory;
	const browser = makeBrowser(args.credential);
	try {
		const objects = await listAllUnderPrefix(
			browser,
			args.bucket,
			args.target.segmentPrefix,
		);
		const { segments, selection } = selectWindowSegments(objects, args.target, {
			windowSeconds: args.windowSeconds,
			now: args.now,
			fallbackCount: args.fallbackCount,
		});
		if (segments.length === 0) {
			throw new Error(
				`live capture found no segments under "${args.target.segmentPrefix}" for rendition ${args.target.renditionKey}`,
			);
		}

		const localPaths: string[] = [];
		const prefix = `cap-${args.target.renditionKey}`;
		// Core normalizes CMAF to the same init-plus-fragment capture format.
		const fmp4 = args.target.kind === "FMP4";
		const ext = fmp4 ? "m4s" : "ts";

		// Download in order: the init first (fMP4 only), then the media segments.
		// `parts` is the byte order of the clip — init, fragment 1, fragment 2 …
		// `keys` is the SAME order in STORAGE terms: what the result row records.
		const parts: string[] = [];
		const keys: string[] = [];
		if (
			fmp4 &&
			(args.target.initSegmentName || args.target.initSegmentNameTemplate)
		) {
			const initCandidates = args.target.initSegmentNameTemplate
				? initSegmentCandidates(
						objects.map((object) => object.key),
						undefined,
						args.target.initSegmentNameTemplate,
					)
				: [
						joinKey(
							args.target.segmentPrefix,
							args.target.initSegmentName as string,
						),
					];
			if (initCandidates.length !== 1) {
				throw new Error(
					`live capture ${args.target.kind} init segment requires exactly one match; found ${initCandidates.length}`,
				);
			}
			const initKey = initCandidates[0] as string;
			const initLocal = join(args.jobDir, `${prefix}-init.mp4`);
			await downloadObject(browser, args.bucket, initKey, initLocal);
			localPaths.push(initLocal);
			parts.push(initLocal);
			keys.push(initKey);
		}
		let i = 0;
		for (const seg of segments) {
			const local = join(args.jobDir, `${prefix}-${i}.${ext}`);
			await downloadObject(browser, args.bucket, seg.key, local);
			localPaths.push(local);
			parts.push(local);
			keys.push(seg.key);
			i++;
		}

		// ONE clip, bytes appended in order — the fMP4 contract and the TS one.
		const clipPath = join(args.jobDir, `${prefix}.${fmp4 ? "mp4" : "ts"}`);
		const sink = createWriteStream(clipPath);
		localPaths.push(clipPath);
		/**
		 * The clip's digest rides one concatenation pipeline: a second pass over a
		 * two-minute multi-rendition capture would double the disk read for a value
		 * the bytes are already streaming past. Hashing the ASSEMBLED clip — not
		 * each segment — is deliberate: the clip is what ffmpeg decodes and what
		 * the score is of, and a per-segment list could not detect a mis-ordered
		 * or half-written concatenation.
		 */
		const hash = createHash("sha256");
		let bytes = 0;
		const tap = new Transform({
			transform(chunk, _enc, done) {
				hash.update(chunk);
				bytes += chunk.length;
				done(null, chunk);
			},
		});
		// Reusing one sink across per-part pipelines retains their listeners.
		// A single pipeline preserves byte order/backpressure and owns completion.
		await pipeline(
			async function* ({ signal }: { signal?: AbortSignal } = {}) {
				for (const part of parts) {
					// Downstream failure must also abort the currently open file read.
					yield* createReadStream(part, { signal });
				}
			},
			tap,
			sink,
		);
		return {
			clipPath,
			container: fmp4 ? "FMP4" : "TS",
			localPaths,
			segmentCount: segments.length,
			keys,
			sha256: hash.digest("hex"),
			bytes,
			selection,
		};
	} finally {
		browser.dispose?.();
	}
}

/** Joins a prefix and a name with exactly one slash. */
function joinKey(prefix: string, name: string): string {
	return prefix.endsWith("/") ? `${prefix}${name}` : `${prefix}/${name}`;
}
