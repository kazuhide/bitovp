import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	type AlignmentResult,
	alignLoopedSegments,
	buildVmafCommand,
	effectiveLivePlanForRun,
	enumerateLiveCaptureTargets,
	estimatePeriodFrames,
	type LiveCaptureTarget,
	type LiveChannelPlan,
	type LoopProfile,
	type LoopTimeline,
	liveChannelPlanSchema,
	loopProfileSchema,
	maskedOutputFrames,
	type PooledMetrics,
	parseVmafJson,
	poolFrames,
	redactSecrets,
	type SegmentAlignmentResult,
	sourceMaskOf,
	timelineFromProfile,
	vmafJobSchema,
	vmafSourceFor,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { type DigestedTransfer, pipeWithDigest } from "@bitovp/storage";
import {
	buildNormalizeCommand,
	loopProfileFromProbe,
	normalizedSpoolPath,
	parseProbeJson,
	probeArgs,
	sourceVideoSpan,
} from "../feeder/command";
import type { ProcessRunner } from "../feeder/supervisor";
import type { EmitProductEvent } from "../notify/emitter";
import type { ResolvedCredential } from "../orchestrator/executor";
import { ResetRowDeleted, whileRowExists } from "../reset/row-liveness";
import type { DownloadProvenance } from "./download";
import { type Geometry, geometryFromProbe } from "./geometry";
import {
	type CaptureDeps,
	type CaptureSelection,
	captureRenditionWindow,
	defaultCaptureBrowserFactory,
} from "./live-capture";
import { probeContainerLoop } from "./loop-probe";
import { isUnresolvableModel, unresolvableModelMessage } from "./model-error";
import {
	extractStats,
	type FrameStats,
	parseSignalstats,
	statsToSignature,
} from "./signatures";

/**
 * Live (pseudo-live) VMAF runner (P4-PR6b) — the real pipeline that wires the
 * PR6a alignment engine to ffmpeg/libvmaf. Mirrors the VOD processor's
 * lifecycle (atomic PENDING→RUNNING claim, FINISHED/ERROR with redacted
 * stderr, per-rendition VmafResult), but instead of a `qc/<key>.mp4` mirror it:
 *
 *   1. CAPTURE  — enumerate the most-recent `windowSeconds` of OUTPUT segments
 *      per video rendition (live-capture, the selection is recorded), download
 *      + concat them into a distorted clip; download the feeder's SOURCE MP4
 *      once and REPRODUCE its push (`-stream_loop … -c copy -f mpegts`, row
 *      #256): the ring, the loop timeline (period measured on the decode,
 *      container probe as the fallback) and the hole mask come from that
 *      decode, because the encoder saw the push, not the file.
 *   2. SIGNATURE — extract a per-frame signature from the distorted clip and
 *      the pushed decode via ffmpeg signalstats (signatures.ts).
 *   3. ALIGN    — per encoder segment over the full period
 *      (`alignLoopedSegments`): each segment gets its own ring offset and
 *      confidence, masked frames never score, the window offset is the ring
 *      median of the confident segments; a weak alignment records a WARNING
 *      (never fails — a bogus alignment is surfaced, not trusted).
 *   4. REFERENCE — cut reference PIECES from the ring, one per run of
 *      equal-offset segments, split at the ring wrap so no piece reads across
 *      a loop transition, and join them (concat demuxer, copy).
 *   5. SCORE    — run libvmaf(distorted, reference), pool only the included,
 *      unmasked frames (`poolFrames`), and store a VmafResult with the
 *      per-frame array (gzip) AND the live alignment metadata (timeline,
 *      segments, reference runs, masked/excluded counts, capture selection,
 *      drift) in pooled.live.
 *
 * The job's `params` carry `{ liveChannelId, windowSeconds }`. The live
 * metadata is stored in the existing JSON columns (params + pooled) — NO
 * migration. Secret discipline matches the VOD processor: credentials resolved
 * at use, ffmpeg stderr redacted before it enters any error string.
 */

/** Below this alignment confidence the result carries a low-confidence warning. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * How many plays of the source the push reproduction copies . The
 * decode must hold two things: the ring, `ringStart + period ≤ 2·period`, and
 * the period estimator's window, `2·(probeFrames + 2·fps)` (its search slack
 * is ±2·fps). Play 1 decodes to `period − hole` frames (the fps conform starts
 * at the first frame); every later play adds a full period, which may be up to
 * 2·fps shorter than the probe says before the estimator gives up — so size
 * for `(plays − 1) · shortest ≥ 2·(probeFrames + 2·fps)`. No read ever passes
 * `ringStart + period` (pieces never cross the ring wrap), so the capture
 * window's length plays no part. Cost: bytes = plays × the mezzanine on the
 * worker disk, decoded ONCE through signalstats; the  shape (10 s
 * source) and a 5-minute mezzanine both come to 4 plays.
 */
/**
 * The period estimator's search radius around the container probe (frames):
 * ±2 s. `pushedPlaysFor` sizes the push reproduction for exactly this window,
 * so the two must never drift apart — both read it from here.
 */
export function periodSearchRadius(fps: number): number {
	return Math.round(2 * fps);
}

export function pushedPlaysFor(probeFrames: number, fps: number): number {
	const slack = periodSearchRadius(fps);
	const shortest = Math.max(probeFrames - slack, Math.ceil(probeFrames / 2), 1);
	return 1 + Math.ceil((2 * (probeFrames + slack)) / shortest);
}

/**
 * Assumed signature fps. The capture window, the ring, the segment offsets and
 * the reference pieces all count in FRAMES, so a single fps fixes the frame
 * grid for both sides. We conform the distorted AND source signatures (and the
 * aligned-reference build) to this rate so the loop period F and the offset are
 * expressed in the same unit. 30 is the live-encoder default; the value is
 * recorded in the result metadata so a non-30 feed is auditable.
 */
export const SIGNATURE_FPS = 30;

/**
 * Fallback segment count when storage omits object mtimes (so the
 * window-by-lastModified selection cannot run): keep this many trailing
 * segments. ~20 × 6s segments ≈ a 2-minute window at the default cadence.
 */
const FALLBACK_SEGMENT_COUNT = 20;

export type LiveVmafProcessorDeps = {
	/** Product-event emit ; never throws. */
	emitEvent?: EmitProductEvent;
	prisma: AppPrismaClient;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	runner: ProcessRunner;
	ffmpegPath: string;
	ffprobePath: string;
	/** Working directory root; a per-job subdir is created under it. */
	workDir: string;
	/**
	 * The feeder's spool root . When this process also runs
	 * the feeder, `<spoolDir>/<feederSessionId>.loop.mp4` is the exact loop the
	 * encoder ingested and is used as the reference; otherwise the loop is
	 * rebuilt from the source with the profile's pins.
	 */
	spoolDir?: string;
	now(): string;
	/** Injectable storage browser factory (tests fake the segment listing). */
	makeBrowser?: CaptureDeps["makeBrowser"];
	/** libvmaf worker threads (n_threads); omitted ⇒ libvmaf default. */
	threads?: number;
	/**
	 * Frame subsample stride (libvmaf n_subsample); omitted ⇒ full precision.
	 * When > 1, only every Nth frame is scored — faster, sparser per-frame
	 * series, less-reliable min (the pooled mean is barely affected).
	 */
	subsample?: number;
	/** Signature fps override (default SIGNATURE_FPS). */
	signatureFps?: number;
	/**
	 * Resolves a model NAME to a bundled model-JSON path (VMAF_MODEL_DIR) so the
	 * "VMAF v1" models load via `model=path=`; undefined ⇒ built-in `version=`.
	 * Mirrors the VOD processor (processor.ts).
	 */
	resolveModelPath?: (model: string) => string | undefined;
};

export type LiveVmafResult = {
	acknowledged: true;
	vmafJobId: string;
	status: string;
	results: number;
};

/** Params persisted on a LIVE VmafJob row. */
type LiveVmafParams = {
	liveChannelId?: string;
	windowSeconds?: number;
	/**
	 * The run this capture was created FOR (review-284 m4): pinned by the
	 * capture route so a re-air between queue and processing cannot swap
	 * the subtree under the job. Absent on legacy jobs → latest-run read.
	 */
	liveChannelRunId?: string;
};

/** Which signature variant won the alignment (luma default, enriched fallback). */
export type SignatureMode = "luma" | "enriched";

/**
 * The wall-clock capture window a live VMAF job seals ONCE at start and reads
 * EVERY rendition over . The
 * distorted tail is `[from, to]`; `to` is the single capture "now" — it does
 * NOT drift per rendition, so a multi-rendition set is compared over the same
 * interval / the same scene. Recorded verbatim on every result (pooled.live)
 * AND its provenance so the set is auditable as one window.
 *
 * This is the SHARED-WINDOW half of the live-VMAF work; the reference-alignment
 * caveat (loop boundary / leading black zeroing frames) tracked by row 256 is a
 * separate concern and is untouched here.
 */
export type CaptureWindow = {
	/** Deterministic id of the whole comparable set (job id + bounds). */
	captureWindowId: string;
	/** Inclusive lower bound of the DVR tail, ISO-8601. */
	from: string;
	/** Upper bound = the single capture "now", ISO-8601. */
	to: string;
};

/**
 * Derives the job's single capture window from ONE `now` reading taken at job
 * start. `from` = `to − windowSeconds`; the id is a stable hash of the job +
 * bounds so two renditions over the same window share an id and any drift
 * yields a different one. Pure + deterministic so it is unit-testable and so
 * the seal below has a canonical value to compare against.
 */
export function windowFromNow(
	vmafJobId: string,
	nowIso: string,
	windowSeconds: number,
): CaptureWindow {
	const toMs = Date.parse(nowIso);
	const fromMs = toMs - windowSeconds * 1000;
	const from = new Date(fromMs).toISOString();
	const to = new Date(toMs).toISOString();
	const captureWindowId = createHash("sha256")
		.update(`${vmafJobId}|${from}|${to}`)
		.digest("hex")
		.slice(0, 16);
	return { captureWindowId, from, to };
}

/** Two windows are the same comparable set iff all three fields agree. */
function sameCaptureWindow(a: CaptureWindow, b: CaptureWindow): boolean {
	return (
		a.captureWindowId === b.captureWindowId &&
		a.from === b.from &&
		a.to === b.to
	);
}

/** One rendition's sealed capture identity, collected during the run. */
export type SealedRendition = {
	renditionKey: string;
	window: CaptureWindow;
};

/**
 * The comparable-set seal :
 * returns the renditionKeys whose recorded window does NOT match the job's
 * single sealed window. An empty array means the set is comparable; a non-empty
 * one means the run must fail CLOSED rather than record a silently-mixed
 * multi-window set as a FINISHED comparable set.
 */
export function captureWindowMismatches(
	sealed: SealedRendition[],
	jobWindow: CaptureWindow,
): string[] {
	return sealed
		.filter((s) => !sameCaptureWindow(s.window, jobWindow))
		.map((s) => s.renditionKey);
}

/** One scored segment, as recorded on the result . */
export type LiveSegmentRecord = {
	index: number;
	frameStart: number;
	frameEnd: number;
	offset: number;
	confidence: number;
	comparableFrames: number;
	/** Frames with a reference at the window offset — the number that explains an exclusion. */
	comparableAtWindowOffset: number;
	included: boolean;
};

/**
 * What the reference was cut from : the feeder's own
 * normalized loop read from the spool, the same loop rebuilt from the source
 * with the profile's pins, or — for a session that pushed before the feeder
 * normalized — the raw source's push reproduced.
 */
export type ReferenceSource =
	| "spool-loop"
	| "renormalized-source"
	| "raw-source";

/** The live-alignment block we fold into the result's pooled JSON. */
export type LiveMetadata = {
	mode: "LIVE";
	/** : 2 = loop-timeline period, per-segment full-period alignment, masked pooling. */
	alignmentVersion: 2;
	referenceSource: ReferenceSource;
	offset: number;
	confidence: number;
	lowConfidence: boolean;
	fps: number;
	/** "luma" unless the enriched fallback aligned better (flat-luma content). */
	signatureMode: SignatureMode;
	/** The loop period F — the pushed CONTAINER timeline's, not the video frame count. */
	sourceFrames: number;
	distortedFrames: number;
	/** Always null since alignmentVersion 2: the anchor is gone, the search is the full period. */
	coarseOffset: null;
	drift: AlignmentResult["drift"];
	loopMap: AlignmentResult["loopMap"];
	/** Where the period and the holes came from. */
	timeline: LoopTimeline;
	segments: LiveSegmentRecord[];
	/**
	 * The reference was built piecewise: one piece per run of consecutive
	 * segments that share an offset (a loop transition a frame long or short
	 * — measured on a real push — moves the offset by one between loops; one
	 * global offset would misalign every loop but one).
	 */
	referenceRuns: { frameStart: number; frameEnd: number; offset: number }[];
	/** Output frames that map onto a loop hole (no reference) — never scored. */
	masked: { frames: number; share: number };
	/** Segments (and their frames) left out for low confidence. */
	excluded: { segments: number[]; frames: number };
	/** True when no segment aligned and every unmasked frame was pooled under the window's best offset. */
	pooledWithoutAlignment: boolean;
	/** Frames that reached the pooled metrics. */
	includedFrames: number;
	/** Output frames libvmaf never scored (subsampling stride, or a short decode — warned). */
	unscoredFrames: number;
	/** Autocorrelation cross-check of the period from the output alone; null when undecidable. */
	measuredPeriodFrames: number | null;
	captureSelection: CaptureSelection;
	/**
	 * The job's single sealed capture window
 — identical across every rendition of the job, recorded so the report
	 * proves the set was compared over one interval.
	 */
	captureWindow: CaptureWindow;
	/** Set when confidence < threshold or another non-fatal capture caveat. */
	warning?: string;
};

// LiveVmafJobRow / FeederSessionRow deleted: they existed only to be `as`-cast
// onto their queries, and that construction is what removed the compiler from
// the loop in `vmaf/processor.ts`. Prisma's inferred types serve every
// consumer here, so the aliases bought nothing and only suppressed.

/** Distorted input argv fragment — `-i <clip>`, one assembled file whichever container the capture found. */
type DistortedInput = string[];

/** Last non-empty stderr line, redacted — the ffmpeg failure reason. */
function stderrTail(stderr: string): string {
	const line =
		stderr
			.trim()
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.at(-1) ?? "no output";
	return redactSecrets(line);
}

/** renditionRef stored on the VmafResult row (identity for the report). */
function renditionRef(target: LiveCaptureTarget): Record<string, unknown> {
	return {
		renditionKey: target.renditionKey,
		codec: target.codec,
		height: target.height,
		bitrate: target.bitrate,
	};
}

/**
 * Aligns source→distorted on the LUMA signature first, and only falls back to
 * the EDGE-enriched signature when luma confidence is below threshold —
 * re-blending the already-extracted raw stats (no extra ffmpeg run). The luma
 * signal is encode-stable and discriminative for typical content (measured at
 * 0.997 confidence in the acceptance harness even on a low-variance clip), so it
 * is the default; enrichment is the genuinely-flat-luma rescue. Whichever scores
 * the higher confidence wins, and the chosen mode is reported in the metadata.
 */
export function alignWithFallback(
	sourceStats: FrameStats[],
	distortedStatsArr: FrameStats[],
	options: {
		segmentFrames: number;
		mask: readonly boolean[];
		includeThreshold: number;
	},
): { alignment: SegmentAlignmentResult; signatureMode: SignatureMode } {
	// : per encoder segment over the FULL period — no feeder anchor.
	const lumaAlignment = alignLoopedSegments(
		statsToSignature(sourceStats, {}),
		statsToSignature(distortedStatsArr, {}),
		options,
	);
	if (lumaAlignment.confidence >= options.includeThreshold) {
		return { alignment: lumaAlignment, signatureMode: "luma" };
	}
	// Luma was weak — try the edge-enriched signature for flat-luma content.
	const enrichedAlignment = alignLoopedSegments(
		statsToSignature(sourceStats, { enrich: true }),
		statsToSignature(distortedStatsArr, { enrich: true }),
		options,
	);
	return enrichedAlignment.confidence > lumaAlignment.confidence
		? { alignment: enrichedAlignment, signatureMode: "enriched" }
		: { alignment: lumaAlignment, signatureMode: "luma" };
}

/**
 * Streams one object to a local path (shared by reference + source download),
 * returning the SHA-256 and byte count of what passed. The digest rides the
 * transfer (`pipeWithDigest`) rather than re-reading the file, for the reason
 * that primitive documents: a mezzanine is large and the bytes are already
 * moving.
 */
async function streamToFile(
	stream: NodeJS.ReadableStream,
	destPath: string,
): Promise<DigestedTransfer> {
	const sink = createWriteStream(destPath);
	try {
		return await pipeWithDigest(stream, sink);
	} catch (err) {
		(stream as { destroy?(error?: Error): void }).destroy?.();
		sink.destroy();
		await rm(destPath, { force: true }).catch(() => {});
		throw err;
	}
}

/** One piece of the aligned reference: output frames `[frameStart, frameEnd)` at `offset`. */
export type ReferenceRun = {
	frameStart: number;
	frameEnd: number;
	offset: number;
};

/**
 * Groups the aligned segments into runs of equal offset . An
 * excluded segment adopts the offset of the run before it (or the window's)
 * so the reference still has one frame per output frame; its frames are
 * kept out of pooling by the caller anyway.
 */
export function referenceRunsOf(
	segments: readonly {
		frameStart: number;
		frameEnd: number;
		offset: number;
		included: boolean;
	}[],
	windowOffset: number,
): ReferenceRun[] {
	const runs: ReferenceRun[] = [];
	for (const seg of segments) {
		const last = runs[runs.length - 1];
		const offset = seg.included ? seg.offset : (last?.offset ?? windowOffset);
		if (last && last.offset === offset && last.frameEnd === seg.frameStart) {
			last.frameEnd = seg.frameEnd;
		} else {
			runs.push({
				frameStart: seg.frameStart,
				frameEnd: seg.frameEnd,
				offset,
			});
		}
	}
	return runs;
}

/** One cut of the reference: output frames `[frameStart, frameEnd)` read from ring index `ringIndex` onward. */
export type ReferencePiece = {
	frameStart: number;
	frameEnd: number;
	ringIndex: number;
};

/**
 * Splits the runs at every ring wrap so no piece is read ACROSS a loop
 * transition of the decoded push : the transitions of a real push
 * differ by a frame from loop to loop (measured 31 then 32 duplicated frames
 * for a 300.7-frame period), so a piece that continued past the ring's end
 * would take the decode's NEXT transition for the output's. Every piece is
 * cut from the one canonical loop instead; the output's own transition
 * variation lands in the (masked) hole frames and in the per-segment offsets.
 */
export function referencePiecesOf(
	runs: readonly ReferenceRun[],
	periodFrames: number,
): ReferencePiece[] {
	const pieces: ReferencePiece[] = [];
	for (const run of runs) {
		let start = run.frameStart;
		while (start < run.frameEnd) {
			const ringIndex =
				(((start + run.offset) % periodFrames) + periodFrames) % periodFrames;
			const length = Math.min(run.frameEnd - start, periodFrames - ringIndex);
			pieces.push({ frameStart: start, frameEnd: start + length, ringIndex });
			start += length;
		}
	}
	return pieces;
}

/** Per output frame: true where the frame's run maps it onto a loop hole. */
export function maskedByRuns(
	timeline: LoopTimeline,
	runs: readonly ReferenceRun[],
	windowFrames: number,
): boolean[] {
	const out = new Array<boolean>(windowFrames).fill(false);
	for (const run of runs) {
		const piece = maskedOutputFrames(
			timeline,
			run.offset + run.frameStart,
			run.frameEnd - run.frameStart,
		);
		for (let i = run.frameStart; i < run.frameEnd && i < windowFrames; i++) {
			out[i] = piece[i - run.frameStart] as boolean;
		}
	}
	return out;
}

export function createLiveVmafProcessor(deps: LiveVmafProcessorDeps) {
	return {
		async process(jobData: unknown): Promise<LiveVmafResult> {
			const { vmafJobId } = vmafJobSchema.parse(jobData);
			try {
				return await whileRowExists(
					async () =>
						Boolean(
							await deps.prisma.vmafJob.findUnique({
								where: { id: vmafJobId },
								select: { id: true },
							}),
						),
					async (signal) => {
						const originalBrowser =
							deps.makeBrowser ?? defaultCaptureBrowserFactory;
						const makeBrowser: CaptureDeps["makeBrowser"] = (credential) => {
							const original = originalBrowser(credential);
							const browser = Object.assign(
								Object.create(Object.getPrototypeOf(original)),
								original,
							) as ReturnType<typeof originalBrowser>;
							const getObject = browser.getObject?.bind(browser);
							if (getObject)
								browser.getObject = async (args) => {
									signal.throwIfAborted();
									const stream = await getObject(args);
									const abort = () =>
										(stream as { destroy?(error?: Error): void }).destroy?.(
											new ResetRowDeleted(),
										);
									if (signal.aborted) {
										(stream as { destroy?(): void }).destroy?.();
										signal.throwIfAborted();
									}
									signal.addEventListener("abort", abort, { once: true });
									stream.once("close", () =>
										signal.removeEventListener("abort", abort),
									);
									stream.once("end", () =>
										signal.removeEventListener("abort", abort),
									);
									return stream;
								};
							return browser;
						};
						return createLiveVmafProcessorRun(
							{
								...deps,
								makeBrowser,
								runner: {
									...deps.runner,
									run: async (bin, argv) => {
										signal.throwIfAborted();
										const result = await deps.runner.run(bin, argv, { signal });
										signal.throwIfAborted();
										return result;
									},
								},
							},
							signal,
						).process(jobData);
					},
				);
			} catch (error) {
				if (error instanceof ResetRowDeleted)
					return {
						acknowledged: true,
						vmafJobId,
						status: "MISSING",
						results: 0,
					};
				throw error;
			}
		},
	};
}

function createLiveVmafProcessorRun(
	deps: LiveVmafProcessorDeps,
	signal: AbortSignal,
) {
	const defaultFps = deps.signatureFps ?? SIGNATURE_FPS;
	const makeBrowser = deps.makeBrowser ?? defaultCaptureBrowserFactory;

	/** Results remain authoritative; a progress outage must not discard a score. */
	async function writeProgress(
		vmafJobId: string,
		totalUnits: number,
		doneUnits: number,
	) {
		try {
			await deps.prisma.vmafJob.update({
				where: { id: vmafJobId },
				data: { totalUnits, doneUnits },
			});
		} catch {
			console.warn(
				JSON.stringify({
					event: "live_vmaf_progress_write_failed",
					entryPoint: "live_vmaf_processor",
					vmafJobId,
				}),
			);
		}
	}

	async function markTerminal(
		vmafJobId: string,
		status: "FINISHED" | "ERROR",
		resultCount: number,
		error?: string,
	): Promise<LiveVmafResult> {
		await deps.prisma.vmafJob.update({
			where: { id: vmafJobId },
			data: {
				status,
				doneUnits: resultCount,
				error: error === undefined ? null : redactSecrets(error),
			},
		});
		// : the live-vmaf terminal choke point (same shape as the
		// VOD processor's). Best-effort emitter — cannot fail the run.
		await deps.emitEvent?.(
			status === "FINISHED"
				? { kind: "VMAF_FINISHED", vmafJobId, path: `/qc/${vmafJobId}` }
				: {
						kind: "VMAF_ERROR",
						vmafJobId,
						error: redactSecrets(error ?? "vmaf failed"),
						path: `/qc/${vmafJobId}`,
					},
		);
		return { acknowledged: true, vmafJobId, status, results: resultCount };
	}

	/**
	 * Downloads the feeder source MP4 (reference) via the capture browser and
	 * returns its provenance: bucket/key plus a streaming SHA-256 of the bytes
	 * that arrived

	 *
	 * `pinned: false`, always, and that is the honest value rather than a
	 * placeholder: this read is unconditional (`getObject` with no `expect`), so
	 * a same-size replacement of the looping source between capture and scoring
	 * is not detected here. Pinning the live legs is slice 3, which
	 * is still open; recording the digest is what makes that slice checkable.
	 */
	async function downloadSourceMp4(
		credential: ResolvedCredential,
		bucket: string,
		key: string,
		destPath: string,
	): Promise<DownloadProvenance> {
		const browser = makeBrowser(credential);
		try {
			if (!browser.getObject) {
				throw new Error(
					"live VMAF reference download needs a download-capable credential (S3 family or GCS)",
				);
			}
			const transfer = await streamToFile(
				await browser.getObject({ bucket, key }),
				destPath,
			);
			return {
				bucket,
				key,
				pinned: false,
				sha256: transfer.sha256,
				bytes: transfer.bytes,
			};
		} finally {
			browser.dispose?.();
		}
	}

	/**
	 * The reference geometry the distorted side is conformed to: ffprobe the
	 * downloaded source ONCE per job (the VOD runner's `referenceFor` does the
	 * same thing, cached per unique source). `buildAlignedReference` applies no
	 * `scale`, so the aligned reference libvmaf actually reads carries exactly
	 * these dimensions.
	 */
	async function probeSourceGeometry(sourcePath: string): Promise<Geometry> {
		const probe = await deps.runner.run(deps.ffprobePath, [
			"-v",
			"error",
			"-print_format",
			"json",
			"-show_streams",
			sourcePath,
		]);
		if (probe.code !== 0) {
			throw new Error(
				`ffprobe failed on the live reference source (code ${probe.code}): ${stderrTail(probe.stderr)}`,
			);
		}
		return geometryFromProbe(probe.stdout);
	}

	/**
	 * Extracts the raw per-frame signalstats from a distorted INPUT spec — a
	 * plain `-i <clip>` since  (the concat-demuxer pair it used to be
	 * decoded every fMP4 capture to zero frames). Kept as an argv fragment so the
	 * signalstats and libvmaf passes share one spelling. Raw stats (not the
	 * collapsed scalar) so the luma→enriched fallback can re-blend without
	 * re-running ffmpeg.
	 */
	async function distortedStats(
		input: DistortedInput,
		fps: number,
	): Promise<FrameStats[]> {
		const argv = [
			"-hide_banner",
			"-nostdin",
			"-v",
			"error",
			...input,
			"-vf",
			`fps=${fps},signalstats,metadata=print:file=-`,
			"-an",
			"-f",
			"null",
			"-",
		];
		const run = await deps.runner.run(deps.ffmpegPath, argv);
		if (run.code !== 0) {
			throw new Error(
				`distorted signalstats extraction failed (code ${run.code}): ${stderrTail(run.stderr)}`,
			);
		}
		return parseSignalstats(run.stdout);
	}

	/** The feeder's copy loop, reproduced: `-stream_loop (plays−1) -i source -c copy -f mpegts`. */
	async function pushSourceLoop(
		sourcePath: string,
		plays: number,
		destPath: string,
		options: { ignoreEditList?: boolean } = {},
	): Promise<void> {
		const run = await deps.runner.run(deps.ffmpegPath, [
			"-hide_banner",
			"-nostdin",
			"-v",
			"error",
			// The feeder pushes its normalized loop with the mp4 edit list ignored
			// (feeder/command.ts): the AAC delay frame's negative pts would
			// otherwise stretch every play by one audio frame. Same argv here.
			...(options.ignoreEditList ? ["-ignore_editlist", "1"] : []),
			"-stream_loop",
			String(Math.max(0, plays - 1)),
			"-i",
			sourcePath,
			"-c",
			"copy",
			"-f",
			"mpegts",
			destPath,
		]);
		if (run.code !== 0) {
			throw new Error(
				`reproducing the feeder's push failed (code ${run.code}): ${stderrTail(run.stderr)}`,
			);
		}
	}

	async function buildAlignedReference(
		pushedPath: string,
		startFrame: number,
		windowFrames: number,
		destPath: string,
		fps: number,
	): Promise<void> {
		// : the reference is cut from the PUSHED stream (the feeder's
		// own copy loop) decoded the way the live encoder decodes it — fps
		// conform, nothing else — so every loop transition, however long, is
		// the encoder's. `startFrame` is a decode index: ring start + offset.
		const argv = [
			"-hide_banner",
			"-nostdin",
			"-v",
			"error",
			"-i",
			pushedPath,
			"-vf",
			// fps first so `n` counts conformed frames; select drops the first
			// `startFrame`; setpts re-bases the timeline to a clean 0..W sequence.
			`fps=${fps},select='gte(n\\,${startFrame})',setpts=N/FRAME_RATE/TB`,
			"-frames:v",
			String(windowFrames),
			"-an",
			destPath,
		];
		const run = await deps.runner.run(deps.ffmpegPath, argv);
		if (run.code !== 0) {
			throw new Error(
				`aligned-reference build failed (code ${run.code}): ${stderrTail(run.stderr)}`,
			);
		}
	}

	/** Scores ONE rendition end-to-end; throws on any ffmpeg failure. */
	async function scoreTarget(args: {
		vmafJobId: string;
		plan: LiveChannelPlan;
		model: string;
		target: LiveCaptureTarget;
		sourceStats: FrameStats[];
		/**
		 * The ALIGNED REFERENCE's frame geometry, probed off the source once per
		 * job. `buildAlignedReference` copies the source's W×H (its filter chain
		 * carries no `scale`) and re-times to `fps`, so the source's dimensions ARE
		 * the reference's — which is what the distorted side has to be conformed to.
		 */
		referenceGeometry: Geometry;
		/** The source object this reference was built from (null when the spool loop was used). */
		sourceProvenance: DownloadProvenance | null;
		/** Where the reference came from . */
		referenceSource: ReferenceSource;
		/** The signature grid for this job: the feeder profile's fps, else the default. */
		fps: number;
		/** Job-level warnings (the reference build) carried into every rendition's record. */
		inheritedWarnings: readonly string[];
		/** : the pushed loop timeline (period + holes) and its source mask. */
		timeline: LoopTimeline;
		sourceMask: readonly boolean[];
		/** The feeder's copy loop of the source, decoded like the encoder decodes it. */
		pushedPath: string;
		/** Decode index where the ring (loop 2, hole first) begins in `pushedPath`. */
		ringStart: number;
		captureDeps: CaptureDeps;
		windowSeconds: number;
		/**
		 * The job's single sealed capture window
. Every rendition of the job is captured over — and records
		 * THIS window; the endpoint is never re-read from `deps.now` here, which
		 * is what used to let it drift between renditions of one set.
		 */
		captureWindow: CaptureWindow;
		jobDir: string;
	}): Promise<CaptureWindow> {
		const { target, jobDir, fps } = args;
		const output = args.plan.outputs.find((o) => o.key === target.outputKey);
		if (!output) {
			throw new Error(`live plan output "${target.outputKey}" not found`);
		}
		/**
		 * The message here used to say "S3-family" while the predicate said
		 * `kind !== "S3"` — and the family is what the capture actually needs
		 * . Akamai Object Storage is
		 * `GENERIC_S3` with V4 signing (C10), so a RUNNING AOS channel could
		 * not have its quality measured in-product at all.
		 *
		 * The primitive was never the blocker: `live-capture.ts` lists through
		 * the provider-agnostic `browser.listObjects` and even falls back to
		 * sequence numbers "when storage omits mtimes (e.g. some S3-compatible
		 * stores)" — written FOR this family. And the reference download a few
		 * hundred lines up already accepts it, by asking the browser whether it
		 * can `getObject` rather than asking the output what kind it is. Two
		 * checks in one file disagreeing about the same capability.
		 *
		 * Now both ask the shared rule. The capability check on the browser
		 * stays as the backstop for a provider whose browser lacks a method.
		 */
		const source = vmafSourceFor(output);
		if (!source.streamable) {
			throw new Error(
				`live VMAF capture cannot use output "${target.outputKey}" (${output.kind}): ${source.reason}`,
			);
		}
		const credential = await deps.resolveCredential(source.credentialId);

		// The job's ONE sealed window — used for BOTH the capture endpoint and the
		// recorded provenance so every rendition is over the SAME wall-clock
		// interval. Re-reading `deps.now` here per target is exactly the drift
		// this fixes .
		const window = args.captureWindow;

		// ── capture: download + concat the recent output segments ───────────────
		const clip = await captureRenditionWindow({
			deps: args.captureDeps,
			credential,
			// From the shared rule, not from the union member: AZURE names it
			// `container`, and the old `kind === "S3"` narrowing is what used
			// to make `output.bucket` type-check here.
			bucket: source.bucket,
			target,
			jobDir,
			windowSeconds: args.windowSeconds,
			// The sealed endpoint, NOT a fresh `deps.now` — the selection cutoff
			// `now − windowSeconds` then reproduces the sealed `from` exactly.
			now: Date.parse(window.to),
			fallbackCount: FALLBACK_SEGMENT_COUNT,
		});

		// One playable clip for either container  — never a
		// concat-demuxer list, which cannot open a bare fMP4 fragment.
		const distortedInput: DistortedInput = ["-i", clip.clipPath];

		const logPath = join(jobDir, `vmaf-${target.renditionKey}.json`);
		const alignedRefPath = join(jobDir, `aligned-${target.renditionKey}.mp4`);
		const cleanup = [...clip.localPaths, logPath, alignedRefPath];
		try {
			// ── signatures: distorted raw stats (concat) + source raw stats ───────
			const distortedRaw = await distortedStats(distortedInput, fps);
			if (distortedRaw.length === 0) {
				throw new Error(
					`captured clip for rendition ${target.renditionKey} decoded to zero frames`,
				);
			}

			// ── align: per encoder segment over the full period  ───────
			const timeline = args.timeline;
			const segmentFrames = Math.max(
				1,
				Math.round(target.segmentLengthSec * fps),
			);
			const { alignment, signatureMode } = alignWithFallback(
				args.sourceStats,
				distortedRaw,
				{
					segmentFrames,
					mask: args.sourceMask,
					includeThreshold: LOW_CONFIDENCE_THRESHOLD,
				},
			);
			const distortedFrames = distortedRaw.length;
			const sourceFrames = timeline.frames;
			// A window is trusted only with a confident, AGREEING majority: a
			// noise-free two-vs-two window reads exactly 0.5 (rev427 round 4), and
			// a slow drift and a bimodal window read alike on `confidence` — only
			// the drift spread tells them apart, so the warning names it.
			const agreeingMajority =
				alignment.includedSegments > 0 &&
				alignment.agreeingSegments * 2 > alignment.includedSegments;
			const lowConfidence =
				alignment.confidence < LOW_CONFIDENCE_THRESHOLD || !agreeingMajority;
			const warnings: string[] = [...args.inheritedWarnings];
			if (lowConfidence) {
				const spread = alignment.drift.maxDriftFrames;
				warnings.push(
					spread >= Math.floor(timeline.frames / 4)
						? `The window holds two alignments ${spread} frames apart (${alignment.agreeingSegments} of ${alignment.includedSegments} segments agree with the window offset) — each run was scored against its own offset, but the window as a whole is not trusted.`
						: `Low alignment confidence (${alignment.confidence.toFixed(2)}, ${alignment.agreeingSegments} of ${alignment.includedSegments} segments within a frame of the window offset, drift ${spread} frames) — the VMAF scores may be misaligned by more than ±1 frame.`,
				);
			}
			// The second instrument: the period read off the OUTPUT alone must
			// agree with the timeline (a multiple is the same period).
			const measuredPeriodFrames = estimatePeriodFrames(
				statsToSignature(distortedRaw, {}),
				timeline.frames,
				periodSearchRadius(fps),
			);
			if (measuredPeriodFrames !== null) {
				const residue = measuredPeriodFrames % timeline.frames;
				if (Math.min(residue, timeline.frames - residue) > 1) {
					warnings.push(
						`The output repeats every ${measuredPeriodFrames} frames but the pushed reference repeats every ${timeline.frames} — the reference period may be wrong (row #256).`,
					);
				}
			}

			// ── aligned reference: one piece per run of equal-offset segments ─────
			// Output frame i of a run at `offset` shows ring[(i + offset) mod F];
			// the piece for `[frameStart, frameEnd)` therefore starts at ring index
			// `offset + frameStart` and runs for the run's length.
			const referenceRuns = referenceRunsOf(
				alignment.segments,
				alignment.offset,
			);
			const referencePieces = referencePiecesOf(referenceRuns, timeline.frames);
			const pieces: string[] = [];
			for (const [k, piece] of referencePieces.entries()) {
				const piecePath =
					referencePieces.length === 1
						? alignedRefPath
						: join(jobDir, `aligned-${target.renditionKey}-${k}.mp4`);
				await buildAlignedReference(
					args.pushedPath,
					args.ringStart + piece.ringIndex,
					piece.frameEnd - piece.frameStart,
					piecePath,
					fps,
				);
				pieces.push(piecePath);
			}
			if (pieces.length > 1) {
				cleanup.push(...pieces);
				const listPath = join(jobDir, `aligned-${target.renditionKey}.txt`);
				cleanup.push(listPath);
				await writeFile(
					listPath,
					`${pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")}\n`,
				);
				const joinRun = await deps.runner.run(deps.ffmpegPath, [
					"-hide_banner",
					"-nostdin",
					"-v",
					"error",
					"-f",
					"concat",
					"-safe",
					"0",
					"-i",
					listPath,
					"-c",
					"copy",
					alignedRefPath,
				]);
				if (joinRun.code !== 0) {
					throw new Error(
						`aligned-reference join failed (code ${joinRun.code}): ${stderrTail(joinRun.stderr)}`,
					);
				}
			}

			// ── score: libvmaf(distorted, alignedReference) ───────────────────────
			const modelPath = deps.resolveModelPath?.(args.model);
			const baseArgv = buildVmafCommand({
				referencePath: alignedRefPath,
				distortedPath: DISTORTED_PLACEHOLDER,
				model: args.model,
				...(modelPath ? { modelPath } : {}),
				logPath,
				/**
				 * CONFORM THE DISTORTED SIDE, exactly as the VOD path does

				 *
				 * libvmaf needs identical W×H and frame rate on its two pads, and
				 * `buildVmafCommand` only emits the scale/fps nodes when these options
				 * are present. Without them the live runner compared a 720/540/360p
				 * capture against a 1080p aligned reference and ffmpeg refused: on the
				 * paid run only the ONE rendition whose geometry happened to match the
				 * source produced a score (jobs `abb76adf` / `05476522`, 1080p only),
				 * and multi-rendition live VMAF — the point of the feature — never
				 * worked at all.
				 *
				 * `fpsConform` is the SIGNATURE fps, not the source's probed rate:
				 * `buildAlignedReference` writes the reference through `fps=${fps}`, so
				 * that is the reference's actual cadence, and it is also the grid the
				 * alignment offset is counted in.
				 */
				scaleToReference: {
					width: args.referenceGeometry.width,
					height: args.referenceGeometry.height,
				},
				fpsConform: fps,
				...(deps.threads !== undefined ? { threads: deps.threads } : {}),
				...(deps.subsample !== undefined ? { subsample: deps.subsample } : {}),
			});
			const argv = spliceDistortedInput(baseArgv, distortedInput);
			const run = await deps.runner.run(deps.ffmpegPath, argv);
			if (run.code !== 0) {
				// Same actionable guidance as the VOD path for an unresolvable
				// model (e.g. a VMAF v1 model on a worker without VMAF_MODEL_DIR).
				if (isUnresolvableModel(run.stderr)) {
					throw new Error(unresolvableModelMessage(args.model, modelPath));
				}
				throw new Error(
					`libvmaf failed for live rendition ${target.renditionKey} (code ${run.code}): ${stderrTail(run.stderr)}`,
				);
			}
			const parsed = parseVmafJson(JSON.parse(await readFile(logPath, "utf8")));
			if (parsed.frames.length === 0) {
				throw new Error(
					`libvmaf produced no frame scores for live rendition ${target.renditionKey}`,
				);
			}
			// ── pool only the frames that have a reference and an aligned segment ─
			const masked = maskedByRuns(timeline, referenceRuns, distortedFrames);
			const maskedCount = masked.filter(Boolean).length;
			const excludedSegments = alignment.segments
				.filter((seg) => !seg.included)
				.map((seg) => seg.index);
			const noSegmentIncluded = alignment.includedSegments === 0;
			if (noSegmentIncluded) {
				// Nothing aligned confidently: score every unmasked frame and say
				// so — a bogus alignment is surfaced, never trusted .
				warnings.push(
					"No segment aligned with confidence; every unmasked frame was pooled under the window's best offset.",
				);
			}
			const include = new Array<boolean>(distortedFrames).fill(false);
			for (const seg of alignment.segments) {
				if (!seg.included && !noSegmentIncluded) {
					continue;
				}
				for (let i = seg.frameStart; i < seg.frameEnd; i++) {
					include[i] = !masked[i];
				}
			}
			// Grid identity (rev427 re-review Q3): `include` is over the distorted
			// signature grid, `frameNum` over libvmaf's own decode of the same
			// clip through the same fps conform. A run that scored fewer frames
			// than the grid (by more than the subsample stride) is said out loud.
			const stride = Math.max(1, deps.subsample ?? 1);
			const lastScored = parsed.frames.reduce(
				(acc, frame) => Math.max(acc, frame.frameNum),
				-1,
			);
			if (lastScored < distortedFrames - stride) {
				warnings.push(
					`libvmaf scored frames up to ${lastScored} of a ${distortedFrames}-frame window — ${distortedFrames - 1 - lastScored} frames at the tail were not scored.`,
				);
			}
			const pooledFrames = poolFrames(parsed.frames, include);
			const pooled = pooledFrames.pooled as PooledMetrics & {
				live?: LiveMetadata;
			};
			const live: LiveMetadata = {
				mode: "LIVE",
				alignmentVersion: 2,
				referenceSource: args.referenceSource,
				offset: alignment.offset,
				confidence: alignment.confidence,
				lowConfidence,
				fps,
				signatureMode,
				sourceFrames,
				distortedFrames,
				coarseOffset: null,
				drift: alignment.drift,
				loopMap: alignment.loopMap,
				timeline,
				referenceRuns,
				segments: alignment.segments.map((seg) => ({
					index: seg.index,
					frameStart: seg.frameStart,
					frameEnd: seg.frameEnd,
					offset: seg.offset,
					confidence: seg.confidence,
					comparableFrames: seg.comparableFrames,
					comparableAtWindowOffset: seg.comparableAtWindowOffset,
					included: seg.included,
				})),
				masked: {
					frames: maskedCount,
					share: distortedFrames === 0 ? 0 : maskedCount / distortedFrames,
				},
				// Under the no-segment fallback nothing is kept out, so nothing is
				// listed as excluded; the per-segment `included` flags and
				// `pooledWithoutAlignment` say that no segment aligned.
				excluded: noSegmentIncluded
					? { segments: [], frames: 0 }
					: {
							segments: excludedSegments,
							frames: distortedFrames - alignment.includedFrames,
						},
				pooledWithoutAlignment: noSegmentIncluded,
				includedFrames: pooledFrames.includedFrames,
				unscoredFrames: pooledFrames.unscoredFrames,
				measuredPeriodFrames,
				captureSelection: clip.selection,
				// The job's single sealed window, identical on every rendition (row
				// #273) — the report proves the set was compared over one interval.
				captureWindow: window,
				...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
			};
			pooled.live = live;

			const framesGzip = gzipSync(Buffer.from(JSON.stringify(parsed.frames)));
			await deps.prisma.vmafResult.create({
				data: {
					vmafJobId: args.vmafJobId,
					renditionRef: renditionRef(target) as Prisma.InputJsonValue,
					pooled: pooled as unknown as Prisma.InputJsonValue,
					framesGzip,
					/**
					 * WHICH bytes this row compared
. VOD rows have
					 * carried this since the download path started digesting; live rows
					 * carried `null`, so a live score could not be tied to any object at
					 * all — and a live capture is the case where it matters most,
					 * because the distorted side is N segments assembled at read time
					 * and the reference is a looping source that can be replaced under a
					 * running channel.
					 *
					 * Same `{ reference, distorted }` shape as VOD. Both sides are
					 * `pinned: false` and honest about it: neither the feeder-source
					 * download nor the segment capture demands a version identity
					 * (`getObject` without `expect` — slice 3 is the row
					 * that closes that, and it is still open). The SHA-256s are the only
					 * identity here, and they are of the bytes ffmpeg actually read.
					 */
					provenance: {
						/**
						 * WHICH window this row was captured over
. Identical across every
						 * rendition of the job, so a multi-rendition set is provably one
						 * comparable window rather than a per-target drift.
						 */
						captureWindow: window,
						reference: args.sourceProvenance,
						referenceSource: args.referenceSource,
						distorted: {
							bucket: source.bucket,
							keys: clip.keys,
							segmentCount: clip.segmentCount,
							container: clip.container,
							pinned: false,
							sha256: clip.sha256,
							bytes: clip.bytes,
							captureSelection: clip.selection,
						},
					} as unknown as Prisma.InputJsonValue,
				},
			});
			// Echo the window this rendition actually recorded so the caller can
			// SEAL the set — the fail-closed check compares every rendition's
			// recorded window against the job's single window .
			return window;
		} finally {
			for (const p of cleanup) {
				await rm(p, { force: true }).catch(() => {});
			}
		}
	}

	async function run(vmafJobId: string): Promise<LiveVmafResult> {
		// No `as LiveVmafJobRow | null`. That construction — a hand-written row
		// type `as`-cast onto a Prisma query — is what removed the compiler
		// from the loop in `vmaf/processor.ts`, where it left an entire
		// `select` unguarded. There is no `select` here today, so it hid
		// nothing; measured, though, adding one UNDER the cast gives tsc 0
		// while the same select without it gives 3 errors, so the cast was
		// pre-emptively disabling the check for whoever narrows this query
		// next (review-final).
		const row = await deps.prisma.vmafJob.findUnique({
			where: { id: vmafJobId },
		});
		if (!row) {
			console.warn(`[vmaf-live] job ${vmafJobId} not found — skipping`);
			return { acknowledged: true, vmafJobId, status: "MISSING", results: 0 };
		}
		const { count } = await deps.prisma.vmafJob.updateMany({
			where: { id: vmafJobId, status: "PENDING" },
			data: { status: "RUNNING", error: null },
		});
		if (count === 0) {
			return { acknowledged: true, vmafJobId, status: row.status, results: 0 };
		}

		let resultCount = 0;
		const jobDir = join(deps.workDir, vmafJobId);
		try {
			const params = (row.params ?? {}) as LiveVmafParams;
			if (!params.liveChannelId) {
				throw new Error("live VMAF job carries no liveChannelId in params");
			}
			const windowSeconds = params.windowSeconds ?? 120;

			/**
			 * Record the subsample stride here too. The live path APPLIES `n_subsample`
			 * (below, in the libvmaf options) exactly as the VOD path does, so a live
			 * report can be subsampled — and without this it would render as full
			 * precision, which is the opposite of what the QC screens now promise. The
			 * VOD half of this shipped first and this gap is the same defect in the
			 * other path.
			 *
			 * MERGED, never rebuilt: this row's `params` carries `liveChannelId`, and
			 * `/api/live-channels/[id]` QUERIES on it as a JSON path
			 * (`params: { path: ["liveChannelId"], equals: id }`), so clobbering the
			 * object would silently empty the channel page's VMAF list rather than
			 * merely losing a badge. Best-effort — report metadata must never fail a
			 * scoring run.
			 */
			if (deps.subsample !== undefined && deps.subsample > 1) {
				await deps.prisma.vmafJob
					.update({
						where: { id: vmafJobId },
						data: {
							params: {
								...(params as unknown as Prisma.InputJsonObject),
								subsample: deps.subsample,
							},
						},
					})
					.catch((err: unknown) => {
						console.error(
							"[worker:vmaf] could not record live subsample stride:",
							err,
						);
					});
			}

			const channel = await deps.prisma.liveChannel.findUnique({
				where: { id: params.liveChannelId },
			});
			if (!channel) {
				throw new Error("live channel no longer exists");
			}
			// : the capture must list the paths the CURRENT run
			// writes — a re-aired run's own subtree, or the plan's paths for
			// seq 1 / pre-#155 runs. A prefix this build cannot re-derive
			// means guessed paths, and "no segments found" hours later; the
			// named error here is the honest version of that failure.
			const parsedPlan = liveChannelPlanSchema.parse(channel.plan);
			// The run whose subtree the capture lists: the one PINNED at job
			// creation (review-284 m4 — a re-air between queue and processing
			// must not swap the paths under the job), falling back to the
			// newest run only for legacy jobs that predate the pin.
			const captureRun = params.liveChannelRunId
				? await deps.prisma.liveChannelRun.findUnique({
						where: { id: params.liveChannelRunId },
						select: { id: true, seq: true, outputPrefix: true },
					})
				: await deps.prisma.liveChannelRun.findFirst({
						where: { liveChannelId: params.liveChannelId },
						orderBy: { seq: "desc" },
						select: { id: true, seq: true, outputPrefix: true },
					});
			if (params.liveChannelRunId && !captureRun) {
				throw new Error(
					"the run this capture was created for no longer exists — its segments are gone with it",
				);
			}
			const plan = captureRun
				? effectiveLivePlanForRun(parsedPlan, captureRun)
				: parsedPlan;
			if (!plan) {
				throw new Error(
					"the run's recorded output prefix does not match this build's rebase derivation — cannot locate the run's segments",
				);
			}

			// The reference + loop boundaries come from the channel's attached
			// feeder session (the source MP4 + the loop-boundary anchor). A LIVE
			// VMAF capture is only meaningful for a pseudo-live (feeder-backed)
			// channel — a real external feed has no known looping source.
			// Same reasoning as the vmafJob query above: no `as …Row` cast, so
			// a `select` added here later is checked rather than asserted away.
			const feeder = await deps.prisma.feederSession.findFirst({
				where: {
					liveChannelId: params.liveChannelId,
					// A DOWNLOADING session has pushed nothing yet (it is fetching or
					// normalizing); the segments in the window came from the newest
					// session that did push.
					status: { in: ["PUSHING", "STOPPED"] },
				},
				orderBy: { createdAt: "desc" },
			});
			if (!feeder) {
				throw new Error(
					"live channel has no attached feeder session — VMAF capture needs the looping source MP4 as the reference",
				);
			}

			const targets = enumerateLiveCaptureTargets(plan);
			await writeProgress(vmafJobId, targets.length, 0);
			if (targets.length === 0) {
				return await markTerminal(vmafJobId, "FINISHED", 0);
			}

			await mkdir(jobDir, { recursive: true });

			// ── the reference: what the encoder actually ingested ─────────────────
			//  follow-up: a feeder that normalized its source pushes
			// `<sessionId>.loop.mp4` (feeder/command.ts) and records its profile;
			// the reference is THAT loop — the spool copy when this process also
			// runs the feeder, else the same loop rebuilt from the same source
			// with the profile's pins. A session that pushed before the feeder
			// normalized (no profile) keeps the raw-source reproduction below.
			const profileParsed = loopProfileSchema.safeParse(feeder.loopProfile);
			const profile: LoopProfile | null = profileParsed.success
				? profileParsed.data
				: null;
			const fps = profile?.fps ?? defaultFps;
			const inheritedWarnings: string[] = [];
			const sourcePath = join(jobDir, "source.mp4");
			let sourceProvenance: DownloadProvenance | null = null;
			let referenceSource: ReferenceSource;
			let referencePath: string;
			if (profile) {
				const loopPath = join(jobDir, "loop.mp4");
				const spooled = deps.spoolDir
					? normalizedSpoolPath(deps.spoolDir, feeder.id)
					: null;
				let spoolCopied = false;
				if (spooled && existsSync(spooled)) {
					try {
						await copyFile(spooled, loopPath);
						spoolCopied = true;
					} catch (err) {
						// The feeder's own `finally` removes the loop when the session
						// ends; losing that race is not an error, the rebuild below is.
						if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
							throw err;
						}
					}
				}
				if (spoolCopied) {
					referenceSource = "spool-loop";
				} else {
					const sourceCredential = await deps.resolveCredential(
						feeder.sourceCredentialId,
					);
					sourceProvenance = await downloadSourceMp4(
						sourceCredential,
						feeder.sourceBucket,
						feeder.sourceKey,
						sourcePath,
					);
					if (sourceProvenance.sha256 !== profile.sourceSha256) {
						throw new Error(
							`the source object's bytes (sha256 ${sourceProvenance.sha256.slice(0, 12)}…) are not the ones the feeder normalized (${profile.sourceSha256.slice(0, 12)}…) — the object changed since the push, so its loop cannot be rebuilt (row #256)`,
						);
					}
					const sourceProbe = await deps.runner.run(
						deps.ffprobePath,
						probeArgs(sourcePath),
					);
					if (sourceProbe.code !== 0) {
						throw new Error(
							`ffprobe of the source failed (code ${sourceProbe.code}): ${stderrTail(sourceProbe.stderr)}`,
						);
					}
					const span = sourceVideoSpan(parseProbeJson(sourceProbe.stdout));
					const rebuild = await deps.runner.run(
						deps.ffmpegPath,
						buildNormalizeCommand({
							sourcePath,
							destPath: loopPath,
							fps: profile.fps,
							protocol:
								feeder.protocol === "SRT_CALLER" ? "SRT_CALLER" : "RTMP",
							...(profile.normalise ? { normalise: profile.normalise } : {}),
							videoStartSec: span.videoStartSec,
							videoDurationSec: span.videoDurationSec,
						}),
					);
					if (rebuild.code !== 0) {
						throw new Error(
							`rebuilding the feeder's normalized loop failed (code ${rebuild.code}): ${stderrTail(rebuild.stderr)}`,
						);
					}
					referenceSource = "renormalized-source";
				}
				// The loop's own probe must reproduce the profile the feeder pushed.
				const loopProbe = await deps.runner.run(
					deps.ffprobePath,
					probeArgs(loopPath),
				);
				if (loopProbe.code !== 0) {
					throw new Error(
						`ffprobe of the reference loop failed (code ${loopProbe.code}): ${stderrTail(loopProbe.stderr)}`,
					);
				}
				const rebuilt = loopProfileFromProbe(
					parseProbeJson(loopProbe.stdout),
					profile.fps,
					profile.sourceSha256,
					profile.recordedAt,
				);
				if (rebuilt.frames !== profile.frames) {
					throw new Error(
						`the reference loop has ${rebuilt.frames} frames but the feeder pushed ${profile.frames} (${referenceSource}) — the reference cannot be trusted (row #256)`,
					);
				}
				// The audio end co-determines the copy-loop period (feeder/command.ts):
				// a rebuild whose AAC framing ends later would stretch every play.
				if (
					Math.abs(rebuilt.audioEndSec - profile.audioEndSec) >=
					1 / profile.fps
				) {
					throw new Error(
						`the reference loop's audio ends at ${rebuilt.audioEndSec.toFixed(4)} s but the feeder's ended at ${profile.audioEndSec.toFixed(4)} s (${referenceSource}) — the copy-loop period would differ (row #256)`,
					);
				}
				referencePath = loopPath;
			} else {
				const sourceCredential = await deps.resolveCredential(
					feeder.sourceCredentialId,
				);
				sourceProvenance = await downloadSourceMp4(
					sourceCredential,
					feeder.sourceBucket,
					feeder.sourceKey,
					sourcePath,
				);
				referenceSource = "raw-source";
				referencePath = sourcePath;
			}
			// The geometry every rendition's distorted clip is scaled to — probed
			// once, here, for the same reason the stats below are extracted once.
			const referenceGeometry = await probeSourceGeometry(referencePath);
			// : the reference is the feeder's OWN push. `-stream_loop …
			// -c copy` repeats the container with whatever transition the
			// container's timestamps produce (measured: 300.7 frames per loop for
			// a raw source whose video starts 1 s in — not the video's 270, not
			// even the container's 300; exactly F for a normalized loop), and the
			// live encoder sees exactly that. So the push is reproduced here and
			// decoded the way the encoder decodes it; the ring, the mask and the
			// reference are all cut from that decode. Exact for copy mode over
			// SRT (`-c copy -f mpegts`); RTMP's flv mux and the transcode modes
			// keep the same `-stream_loop` period, and a ±1-frame transition
			// difference is absorbed by the mask and the per-segment offsets.
			let probeFrames: number;
			let videoFrames: number;
			if (profile) {
				probeFrames = profile.frames;
				videoFrames = profile.frames;
			} else {
				const probe = await probeContainerLoop({
					runner: deps.runner,
					ffprobePath: deps.ffprobePath,
					path: referencePath,
				});
				probeFrames = Math.max(1, Math.round(probe.durationSec * fps));
				videoFrames = Math.max(0, Math.round(probe.videoDurationSec * fps));
			}
			// Enough plays for the ring and the period estimator's window — the
			// invariant and the cost are on `pushedPlaysFor`.
			const pushedPlays = pushedPlaysFor(probeFrames, fps);
			const pushedPath = join(jobDir, "pushed.ts");
			await pushSourceLoop(referencePath, pushedPlays, pushedPath, {
				ignoreEditList: profile !== null,
			});
			const decodedStats = await extractStats({
				runner: deps.runner,
				ffmpegPath: deps.ffmpegPath,
				path: pushedPath,
				options: { fps },
			});
			// The period the ENCODER sees, read off the decode itself; the probe's
			// container span (or the feeder profile) is the anchor of the search.
			const measured = estimatePeriodFrames(
				statsToSignature(decodedStats, {}),
				probeFrames,
				periodSearchRadius(fps),
			);
			let periodFrames: number;
			let timeline: LoopTimeline;
			if (profile) {
				// The profile is what the encoder ingested; the decode is the
				// cross-check. A disagreement means the reproduction differs from
				// the push and is said, never silently overruled.
				periodFrames = profile.frames;
				timeline = timelineFromProfile(profile);
				if (measured !== null && measured !== profile.frames) {
					inheritedWarnings.push(
						`The reproduced push measured a ${measured}-frame period but the feeder's loop profile says ${profile.frames}; the profile was used.`,
					);
				}
			} else {
				periodFrames = measured ?? probeFrames;
				const holeFrames = Math.max(0, periodFrames - videoFrames);
				timeline = {
					source: "container-probe",
					fps,
					frames: periodFrames,
					loopSeconds: periodFrames / fps,
					holes: holeFrames > 0 ? [{ fromFrame: 0, toFrame: holeFrames }] : [],
				};
			}
			// Loop 1 has no head (nothing precedes the first frame); the ring is
			// loop 2 — starting at the first frame after loop 1's video, i.e. at
			// the hole the encoder fills by repeating the last frame (no hole for
			// a normalized loop: loop 2 starts exactly one period in).
			const ringStart = Math.min(videoFrames, periodFrames);
			if (decodedStats.length < ringStart + periodFrames) {
				throw new Error(
					`the pushed reference decoded ${decodedStats.length} frames but the ring needs ${ringStart + periodFrames} (period ${periodFrames}) — the period cannot be trusted (row #256)`,
				);
			}
			const sourceStats = decodedStats.slice(
				ringStart,
				ringStart + periodFrames,
			);
			const sourceMask = sourceMaskOf(timeline);

			const captureDeps: CaptureDeps = {
				resolveCredential: deps.resolveCredential,
				...(deps.makeBrowser ? { makeBrowser: deps.makeBrowser } : {}),
			};

			// The capture window is SEALED here, ONCE, from a single `deps.now`
			// reading — before any rendition is captured — and every target is read
			// over and records THIS window.
			// Re-deriving it per target from `deps.now` mid-run let the
			// endpoint drift over a long download/score, so a multi-rendition set was
			// not compared over the same wall-clock interval / the same scene. This
			// is the SHARED-WINDOW seal only; the reference loop-boundary alignment
			// that row 256 records is a separate, untouched concern.
			const jobWindow = windowFromNow(vmafJobId, deps.now(), windowSeconds);

			// One rendition's failure leaves the OTHERS scored (
			// review-331 I1): a single throw — a truncated listing, a capture the
			// storage refused — used to abort every rendition after it and mark
			// the whole job ERROR with the earlier rows orphaned under it. Each
			// target is isolated; the job still ends ERROR, naming exactly which
			// renditions went unscored and why, and the scored rows are kept.
			const unscored: string[] = [];
			const sealed: SealedRendition[] = [];
			for (const target of targets) {
				try {
					const window = await scoreTarget({
						vmafJobId,
						plan,
						model: row.model,
						target,
						sourceStats,
						referenceGeometry,
						sourceProvenance,
						referenceSource,
						fps,
						inheritedWarnings,
						timeline,
						sourceMask,
						pushedPath,
						ringStart,
						captureDeps,
						windowSeconds,
						captureWindow: jobWindow,
						jobDir,
					});
					sealed.push({ renditionKey: target.renditionKey, window });
					resultCount += 1;
					// Sequential targets: absolute counts heal a missed earlier write.
					await writeProgress(vmafJobId, targets.length, resultCount);
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					unscored.push(`${target.renditionKey}: ${reason}`);
				}
			}

			await rm(sourcePath, { force: true }).catch(() => {});
			if (unscored.length > 0) {
				throw new Error(
					`${unscored.length} of ${targets.length} rendition(s) not scored (${resultCount} scored and kept): ${unscored.join(" | ")}`,
				);
			}
			// FAIL CLOSED on a mixed set:
			// every scored rendition must carry the job's single window. A
			// rendition captured over a drifted window is an inconsistency the seal
			// rejects — the scored rows are kept, but the set is NOT recorded as a
			// comparable FINISHED set. In correct code this never fires (every target
			// records `jobWindow`); it is the explicit guard the invariant rests on.
			const drifted = captureWindowMismatches(sealed, jobWindow);
			if (drifted.length > 0) {
				throw new Error(
					`live VMAF capture-window seal failed: rendition(s) ${drifted.join(", ")} were not captured over the job's single window ${jobWindow.captureWindowId} [${jobWindow.from}, ${jobWindow.to}] — a multi-rendition set over drifting windows is not comparable and is not sealed FINISHED (row #273)`,
				);
			}
			return await markTerminal(vmafJobId, "FINISHED", resultCount);
		} catch (err) {
			if (signal.aborted) throw signal.reason;
			const message = err instanceof Error ? err.message : "live vmaf failed";
			await markTerminal(vmafJobId, "ERROR", resultCount, message);
			throw err;
		} finally {
			await rm(jobDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	return {
		async process(jobData: unknown): Promise<LiveVmafResult> {
			const { vmafJobId } = vmafJobSchema.parse(jobData);
			return run(vmafJobId);
		},
	};
}

export type LiveVmafProcessor = ReturnType<typeof createLiveVmafProcessor>;

/** Placeholder the distorted input replaces in the libvmaf argv. */
const DISTORTED_PLACEHOLDER = "__distorted__";

/**
 * Replaces the placeholder distorted `-i __distorted__` in a buildVmafCommand
 * argv with the real distorted input args (`-i <clip>`, the assembled capture).
 * buildVmafCommand always emits the distorted input FIRST as `-i <path>`; we
 * swap that single `-i __distorted__` token-pair for the provided input args.
 */
export function spliceDistortedInput(
	baseArgv: string[],
	distortedInput: DistortedInput,
): string[] {
	const idx = baseArgv.indexOf(DISTORTED_PLACEHOLDER);
	if (idx < 1 || baseArgv[idx - 1] !== "-i") {
		throw new Error("could not locate the distorted input placeholder in argv");
	}
	return [
		...baseArgv.slice(0, idx - 1),
		...distortedInput,
		...baseArgv.slice(idx + 1),
	];
}
