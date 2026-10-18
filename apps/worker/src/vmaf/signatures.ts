import { redactSecrets } from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";

/**
 * Per-frame video signature extraction (P4-PR6b) — the REAL bridge between a
 * decoded clip and the pure PR6a alignment engine (`alignLoopedSignatures`),
 * which takes one discriminative scalar per frame and knows nothing about
 * ffmpeg. This module runs ffmpeg's `signalstats` filter and turns its
 * per-frame metadata into that scalar array.
 *
 * METHOD — luma by default, edge-ENRICHED as a fallback. The PR6a author flagged
 * that a single mean-luma scalar can be too FLAT to discriminate frames on real
 * content (a slow, low-contrast scene yields nearly the same YAVG for hundreds
 * of frames, so cross-correlation has no peak to lock onto). `signalstats`
 * exposes, per frame and for free in one pass:
 *   - YAVG: average luma (the brightness LEVEL), and
 *   - YDIF: the mean absolute luma DIFFERENCE from the previous frame (a
 *     temporal-activity / motion-energy term — high on cuts and motion, ~0 on
 *     a static frame).
 *
 * The DEFAULT signature is mean luma (YAVG). Measured against the real
 * ffmpeg/libvmaf path (the acceptance harness), luma is both discriminative AND
 * encode-stable: even a low-variance clip (luma σ≈0.5) aligned at 0.997
 * confidence, because compression preserves average luma faithfully. Naively
 * blending YDIF in is WRONG and was measured to BACKFIRE on exactly that clip —
 * YDIF is NOT encode-stable (compression alters inter-frame differences more
 * than average luma), so the distorted side's YDIF decorrelates from the
 * source's and crushed confidence to 0.0 where plain luma scored 0.997.
 *
 * So enrichment is a FALLBACK, not the default: `enrich: true` returns
 * `YAVG + edgeWeight·YDIF` for the genuinely flat-luma case where luma alone
 * has no peak. The live processor aligns on luma first and only re-extracts +
 * re-aligns with enrichment if the luma confidence is poor — an
 * alignment-quality-driven choice (where the information actually is), not a
 * content-statistic guess that can be fooled.
 *
 * PURITY / TESTABILITY. All ffmpeg interaction goes through the injected
 * ProcessRunner (the feeder's boundary — CI has no ffmpeg), so the parser is
 * unit-tested against canned `metadata=print` output and the argv is asserted
 * without a real binary. The only side effect is the ffmpeg run itself.
 */

/** Default weight on the YDIF term when enrichment is requested (flat-luma fallback). */
export const DEFAULT_EDGE_WEIGHT = 2;

export type SignatureOptions = {
	/**
	 * Conform the decoded frame rate before sampling so the signature index is a
	 * true frame index at a known fps (the loop offset is measured in frames).
	 * Omitted ⇒ the clip's native rate.
	 */
	fps?: number;
	/**
	 * Blend the YDIF temporal-activity term into the signature
	 * (`YAVG + edgeWeight·YDIF`) — the flat-luma FALLBACK. Default (false) is
	 * mean luma alone, which is discriminative AND encode-stable for typical
	 * content (see module doc); enrich only when luma fails to align.
	 */
	enrich?: boolean;
	/** Weight on the YDIF term when `enrich` is set. Default DEFAULT_EDGE_WEIGHT. */
	edgeWeight?: number;
	/**
	 * Stop after N frames (`-frames:v`). Used by the VOD alignment probe, which
	 * only needs the head — a lead-in offset shows in the first seconds, and a
	 * 3-hour reference must not be decoded in full twice just to find it.
	 * Omitted ⇒ the whole clip, as the live aligner needs.
	 */
	frames?: number;
};

/**
 * Builds the ffmpeg argv (WITHOUT the binary) that decodes `path` and prints
 * per-frame `signalstats` metadata to stdout. `metadata=print:file=-` writes
 * `frame:<n> ... \n lavfi.signalstats.YAVG=<v>` blocks to stdout; `-f null -`
 * discards the video itself. `-v error` keeps ffmpeg's own banner/progress off
 * stdout so only the metadata lines remain.
 */
export function buildSignatureCommand(
	path: string,
	options: SignatureOptions = {},
): string[] {
	const chain: string[] = [];
	if (options.fps !== undefined) {
		chain.push(`fps=${options.fps}`);
	}
	chain.push("signalstats");
	// metadata=print emits the per-frame key/value pairs; file=- → stdout.
	chain.push("metadata=print:file=-");
	return [
		"-hide_banner",
		"-nostdin",
		"-v",
		"error",
		"-i",
		path,
		"-vf",
		chain.join(","),
		// After -vf so the count is of FILTERED frames: with an fps conform in the
		// chain, limiting the input would sample a different span on each side.
		...(options.frames !== undefined
			? ["-frames:v", String(options.frames)]
			: []),
		"-an",
		"-f",
		"null",
		"-",
	];
}

/** One frame's parsed signalstats fields (only the ones we use). */
export type FrameStats = { yavg?: number; ydif?: number };

/**
 * Parses ffmpeg `metadata=print` stdout into per-frame YAVG/YDIF. Output looks
 * like (one block per frame):
 *
 *   frame:0    pts:0       pts_time:0
 *   lavfi.signalstats.YAVG=58.123
 *   lavfi.signalstats.YDIF=0.000
 *   frame:1    pts:512     pts_time:0.04
 *   lavfi.signalstats.YAVG=58.140
 *   ...
 *
 * A `frame:` line starts a new frame; subsequent `lavfi.signalstats.<K>=<v>`
 * lines fill it. Robust to extra metadata keys (ignored) and to a stream that
 * starts mid-block. Returns frames in emission order.
 */
export function parseSignalstats(stdout: string): FrameStats[] {
	const frames: FrameStats[] = [];
	let current: FrameStats | undefined;
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith("frame:")) {
			current = {};
			frames.push(current);
			continue;
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const key = line.slice(0, eq);
		const value = Number.parseFloat(line.slice(eq + 1));
		if (!Number.isFinite(value)) {
			continue;
		}
		// A value line before any `frame:` header (mid-block start) opens a frame.
		if (!current) {
			current = {};
			frames.push(current);
		}
		if (key.endsWith(".YAVG")) {
			current.yavg = value;
		} else if (key.endsWith(".YDIF")) {
			current.ydif = value;
		}
	}
	// Drop trailing frames that never received a YAVG (e.g. a truncated final
	// block) — they carry no usable signal.
	return frames.filter((f) => f.yavg !== undefined);
}

/**
 * Collapses parsed per-frame stats into the single discriminative scalar the
 * alignment engine consumes.
 *
 * Default: mean luma (YAVG) — discriminative AND encode-stable for typical
 * content. `enrich`: `YAVG + edgeWeight·YDIF`, the flat-luma fallback the
 * processor uses only when luma alone fails to align (see module doc). A
 * missing YDIF (first frame, or a build without it) contributes 0.
 */
export function statsToSignature(
	frames: FrameStats[],
	options: SignatureOptions = {},
): number[] {
	if (!options.enrich) {
		return frames.map((f) => f.yavg ?? 0);
	}
	const weight = options.edgeWeight ?? DEFAULT_EDGE_WEIGHT;
	return frames.map((f) => (f.yavg ?? 0) + weight * (f.ydif ?? 0));
}

/**
 * Extracts the raw per-frame signalstats from a video file by running ffmpeg
 * `signalstats` through the injected runner and parsing its metadata. Throws on
 * a non-zero ffmpeg exit (the caller fails the job) or on an empty result (no
 * frames decoded ⇒ nothing to align). Returning the RAW stats (not the
 * collapsed scalar) lets the caller re-blend (luma → enriched fallback) without
 * re-running ffmpeg.
 */
export async function extractStats(args: {
	runner: ProcessRunner;
	ffmpegPath: string;
	path: string;
	options?: SignatureOptions;
}): Promise<FrameStats[]> {
	const argv = buildSignatureCommand(args.path, args.options);
	const run = await args.runner.run(args.ffmpegPath, argv);
	if (run.code !== 0) {
		const tail =
			run.stderr
				.trim()
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.at(-1) ?? "no output";
		// Redact defensively: today the argv is a local file path (no secret),
		// but a future caller passing a URL-bearing input must not leak it.
		throw new Error(
			`signalstats extraction failed (code ${run.code}): ${redactSecrets(tail)}`,
		);
	}
	const frames = parseSignalstats(run.stdout);
	if (frames.length === 0) {
		throw new Error(
			"signalstats extraction produced no frames (the clip decoded to zero usable frames)",
		);
	}
	return frames;
}

/**
 * Convenience: {@link extractStats} collapsed to the signature scalar array
 * (luma by default, enriched when `options.enrich`). Used where the raw stats
 * are not needed (e.g. the acceptance harness).
 */
export async function extractSignature(args: {
	runner: ProcessRunner;
	ffmpegPath: string;
	path: string;
	options?: SignatureOptions;
}): Promise<number[]> {
	return statsToSignature(await extractStats(args), args.options);
}
