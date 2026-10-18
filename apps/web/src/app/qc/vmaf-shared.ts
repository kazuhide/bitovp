import type {
	PooledMetrics,
	VmafCloudProfile,
	VmafExecution,
} from "@bitovp/core";
import type { ChartFrame } from "@/lib/server/vmaf-frames";

export type VmafComputeProfileSummary = Pick<
	VmafCloudProfile,
	| "id"
	| "label"
	| "provider"
	| "region"
	| "maxCostUsdPerHour"
	| "timeoutSeconds"
	| "queueTimeoutSeconds"
	| "overheadUsd"
	| "transferUsdPerGiB"
>;

/** VmafJob.status — mirrors the Prisma enum (PR3). */
export type VmafStatus = "PENDING" | "RUNNING" | "FINISHED" | "ERROR";
export type VmafMode = "VOD" | "LIVE";

/**
 * Every status, derived from the tone map's keys so the two cannot drift — and
 * `Record<VmafStatus, …>` makes a missing member a TYPE error, which a
 * hand-written array would not (review catch: the same exhaustiveness gap exists
 * in `JOB_STATUSES`).
 */
export const VMAF_STATUSES = Object.keys({
	PENDING: 1,
	RUNNING: 1,
	FINISHED: 1,
	ERROR: 1,
} satisfies Record<VmafStatus, 1>) as VmafStatus[];

export const VMAF_STATUS_TONE: Record<VmafStatus, "neutral" | "ok" | "error"> =
	{
		PENDING: "neutral",
		RUNNING: "ok",
		FINISHED: "ok",
		ERROR: "error",
	};

/**
 * In-flight report: the VMAF worker still owns the row (PENDING waiting to be
 * picked up, RUNNING mid-scoring). Shared single source of truth so the
 * DELETE/bulk-delete routes' 409 guards and the UI's disabled sets can't drift
 * (mirrors `isActiveJobStatus` for encoding jobs).
 */
export function isActiveVmafStatus(status: VmafStatus): boolean {
	return status === "PENDING" || status === "RUNNING";
}

/** Which rendition a result covers (VmafResult.renditionRef shape). */
export type RenditionRef = {
	streamId?: string;
	label?: string;
	bitrate?: number;
	height?: number;
};

/** Lean index row: one VmafJob + its per-rendition mean VMAF scores. */
export type VmafJobListItem = {
	/** Failed local VOD report whose measurement can be retried separately. */
	localRetryAvailable?: boolean;
	computeTasks?: VmafComputeTaskSummary[];
	id: string;
	encodingJobId: string | null;
	/** The linked encoding job's name (plan.name, e.g. "bbb-pte-crf-17"); null for LIVE jobs. */
	encodingName: string | null;
	mode: VmafMode;
	model: string;
	/**
	 * Scoring generation (see `VMAF_SCORING_VERSION`). 1 ⇒ scored before the
	 * 2026-08-11 PTS fix and NOT comparable with a 2: on one real encode the same
	 * bytes measured 23.08 then and 84.21 now.
	 *
	 * REQUIRED, and that is the point. It shipped optional, and both routes
	 * selected the column from Postgres and then dropped it while hand-building
	 * their response literal — which `tsc` accepted in silence. The result was
	 * worse than the silent chart this field exists to prevent: every report
	 * rendered "gen 1 — understated", including the freshly-corrected ones.
	 * Required makes an omitted field a compile error, which is the only
	 * instrument that catches it — no component test can, because they all mock
	 * `apiFetch` and supply what the route omits.
	 */
	scoringVersion: number;
	status: VmafStatus;
	error: string | null;
	createdAt: string;
	/** mean VMAF per result, ascending result order — drives the index spar-summary. */
	renditionMeans: { label: string; mean: number }[];
};

/** One loop-wrap of the captured window (mirrors core LoopMapEntry). */
export type LiveLoopMapEntry = {
	outputFrameStart: number;
	sourceFrameStart: number;
	loopIndex: number;
};

/** Per-window drift verdict (mirrors core DriftReport). */
export type LiveDriftReport = {
	detected: boolean;
	maxDriftFrames: number;
	perSegmentOffsets: number[];
};

/**
 * Pseudo-live alignment metadata attached to a LIVE result's pooled JSON
 * (`pooled.live`, written by the live VMAF processor). Drives the live report
 * panels: the loop-offset map, the drift warning, and the confidence.
 */
export type LiveReportMetadata = {
	offset: number;
	confidence: number;
	lowConfidence: boolean;
	fps: number;
	/** "luma" (default) or "enriched" (flat-luma fallback). Optional for forward-compat. */
	signatureMode?: "luma" | "enriched";
	sourceFrames: number;
	distortedFrames: number;
	coarseOffset: number | null;
	drift: LiveDriftReport;
	loopMap: LiveLoopMapEntry[];
	warning?: string;
	//  (alignmentVersion 2) — optional so pre-#256 rows still render.
	alignmentVersion?: number;
	timeline?: {
		source: "feeder-profile" | "container-probe";
		fps: number;
		frames: number;
		loopSeconds: number;
		holes: { fromFrame: number; toFrame: number }[];
	};
	segments?: {
		index: number;
		frameStart: number;
		frameEnd: number;
		offset: number;
		confidence: number;
		comparableFrames: number;
		comparableAtWindowOffset?: number;
		included: boolean;
	}[];
	masked?: { frames: number; share: number };
	/**  follow-up: what the reference was cut from. */
	referenceSource?: "spool-loop" | "renormalized-source" | "raw-source";
	excluded?: { segments: number[]; frames: number };
	/** True when no segment aligned and every unmasked frame was pooled . */
	pooledWithoutAlignment?: boolean;
	includedFrames?: number;
	unscoredFrames?: number;
	referenceRuns?: { frameStart: number; frameEnd: number; offset: number }[];
	measuredPeriodFrames?: number | null;
	captureSelection?: {
		mode: "window" | "tail-no-mtimes" | "tail-empty-window";
		from?: string;
		to?: string;
		contiguous: boolean;
		segmentCount: number;
		droppedForGap: number;
		droppedAfterNow?: number;
	};
};

/** One rendition's report payload (detail route). */
export type VmafResultDetail = {
	id: string;
	/** Version-pinned QC mirror; absent on older API payloads. */
	preview?:
		| { url: string }
		| {
				unavailableReason:
					| "LIVE_CAPTURE_NOT_RETAINED"
					| "MISSING_PROVENANCE"
					| "MISSING_FPS"
					| "UNSUPPORTED_SOURCE";
		  };
	renditionRef: RenditionRef;
	pooled: PooledMetrics;
	/** Downsampled per-frame series (≤ DOWNSAMPLE_CAP); worst frame pinned + flagged. */
	frames: ChartFrame[];
	/** Original frame count before downsampling (so the UI can disclose it). */
	frameCount: number;
	/** Present only for LIVE results — the PR6a alignment summary. */
	live?: LiveReportMetadata;
};

/** Full detail payload for /qc/[id]. */
export type VmafTaskProgress = {
	phase:
		| "MANIFEST"
		| "REFERENCE_DOWNLOAD"
		| "DISTORTED_DOWNLOAD"
		| "MODEL_DOWNLOAD"
		| "REFERENCE_PROBE"
		| "DISTORTED_PROBE"
		| "ALIGNMENT"
		| "SCORING"
		| "RESULT_UPLOAD"
		| "RECEIPT_UPLOAD"
		| "STAGING"
		| "QUEUED"
		| "RETRYING";
	updatedAt: string;
	framesProcessed?: number;
	totalFrames?: number;
};

export type VmafComputeTaskSummary = {
	current?: boolean;
	attempt?: number;
	provisioningModel?: "SPOT" | "STANDARD";
	progress?: VmafTaskProgress | null;
	id: string;
	profileId: string;
	state: string;
	reservedUsd: number;
	createdAt: string;
	cleanedAt: string | null;
	error: string | null;
};

export type VmafJobDetail = {
	computeTasks?: VmafComputeTaskSummary[];
	/** Public execution request only; absent on older API payloads. */
	execution?: VmafExecution | null;
	id: string;
	encodingJobId: string | null;
	/** The linked encoding job's name (plan.name); null for LIVE jobs. */
	encodingName: string | null;
	mode: VmafMode;
	model: string;
	/**
	 * Scoring generation (see `VMAF_SCORING_VERSION`). 1 ⇒ scored before the
	 * 2026-08-11 PTS fix and NOT comparable with a 2: on one real encode the same
	 * bytes measured 23.08 then and 84.21 now.
	 *
	 * REQUIRED, and that is the point. It shipped optional, and both routes
	 * selected the column from Postgres and then dropped it while hand-building
	 * their response literal — which `tsc` accepted in silence. The result was
	 * worse than the silent chart this field exists to prevent: every report
	 * rendered "gen 1 — understated", including the freshly-corrected ones.
	 * Required makes an omitted field a compile error, which is the only
	 * instrument that catches it — no component test can, because they all mock
	 * `apiFetch` and supply what the route omits.
	 */
	scoringVersion: number;
	/**
	 * libvmaf `n_subsample` this report was scored with; null ⇒ full precision.
	 *
	 * Every Nth frame is scored, so the per-frame series is sparser and the `min`
	 * can miss the transient worst frame while the pooled mean barely moves — i.e.
	 * two reports can share a scoring generation and still not be comparable on
	 * their minima. REQUIRED for the same reason `scoringVersion` is: the one
	 * instrument that catches a route selecting a column and then dropping it while
	 * hand-building its response literal is the compiler, because every component
	 * test mocks the fetch and supplies what the route omits.
	 */
	subsample: number | null;
	status: VmafStatus;
	error: string | null;
	/** Total work units (targets × resolved per-title rungs); 0 ⇒ not-yet-set. */
	totalUnits: number;
	/** Completed work units (atomic increment per scoring). */
	doneUnits: number;
	/** Worker CPU cores / libvmaf threads / concurrent scorings (null = older job). */
	cores: number | null;
	threads: number | null;
	concurrency: number | null;
	createdAt: string;
	updatedAt: string;
	/**
	 * Geometry of the SOURCE this job scored against, recorded by the worker.
	 *
	 * Null on jobs written before this existed. Without it a report cannot state its own
	 * terms — and a 360p rung scored against a 1080p source reads as a broken encoder
	 * rather than an aggressive ladder, which is exactly what happened.
	 */
	reference: { width?: number; height?: number; fps?: number } | null;
	results: VmafResultDetail[];
};

/* Human rendition label with height and bitrate, falling back to stream identity or index. Browser callers can supply a localized fallback; API and CSV data retain stable English labels. */
export function renditionLabel(
	ref: RenditionRef,
	index: number,
	numberedFallback?: string,
): string {
	if (ref.label) {
		return ref.label;
	}
	if (ref.height) {
		return ref.bitrate
			? `${ref.height}p · ${Math.round(ref.bitrate / 1000)}k`
			: `${ref.height}p`;
	}
	if (ref.bitrate) {
		return `${Math.round(ref.bitrate / 1000)}k`;
	}
	if (ref.streamId) {
		return ref.streamId;
	}
	return numberedFallback ?? `Rendition ${index + 1}`;
}

/**
 * Deterministic line/point colour per rendition (overlay charts). Tailwind
 * zinc-theme-friendly hues; cycles for >8 renditions.
 */
export const RENDITION_COLORS = [
	"#34d399", // emerald-400 (house accent)
	"#60a5fa", // blue-400
	"#f472b6", // pink-400
	"#fbbf24", // amber-400
	"#a78bfa", // violet-400
	"#22d3ee", // cyan-400
	"#fb923c", // orange-400
	"#4ade80", // green-400
] as const;

export function renditionColor(index: number): string {
	return RENDITION_COLORS[index % RENDITION_COLORS.length] as string;
}

/**
 * Wider palette for the report-comparison overlays, where up to 6 jobs × their
 * renditions share one chart and every (job × rendition) series needs its own
 * readable hue. Distinct from {@link RENDITION_COLORS} (which is per-rendition
 * within a single report) — here we want as many mutually-distinguishable hues
 * as practical before cycling. Tailwind-400 family, dark-theme friendly.
 */
export const SERIES_COLORS = [
	"#34d399", // emerald-400
	"#60a5fa", // blue-400
	"#f472b6", // pink-400
	"#fbbf24", // amber-400
	"#a78bfa", // violet-400
	"#22d3ee", // cyan-400
	"#fb923c", // orange-400
	"#4ade80", // green-400
	"#f87171", // red-400
	"#818cf8", // indigo-400
	"#2dd4bf", // teal-400
	"#e879f9", // fuchsia-400
	"#a3e635", // lime-400
	"#facc15", // yellow-400
	"#38bdf8", // sky-400
	"#fda4af", // rose-300
] as const;

export function seriesColor(index: number): string {
	return SERIES_COLORS[index % SERIES_COLORS.length] as string;
}

/** Short, human-stable job identifier (first 8 of the id) for compact labels. */
export function shortJobId(id: string): string {
	return id.slice(0, 8);
}

/**
 * Best human label for a whole VMAF job in the comparison legend. Prefers the
 * **encoding name** (plan.name, e.g. "bbb-pte-crf-17") since that's what an
 * operator recognises; falls back to the encoding model (e.g. "vmaf_v0.6.1")
 * plus the short job id, then the short id alone (LIVE jobs have no encoding,
 * so they take this fallback). Kept short — it prefixes every rendition label
 * in the overlay. The short id stays available separately ({@link shortJobId})
 * as a disambiguator when two jobs share an encoding name (e.g. re-runs).
 */
export function jobShortLabel(
	job: {
		id: string;
		model?: string | null;
		encodingName?: string | null;
	},
	/**
	 * Force the model into the label even when an encoding name exists.
	 *
	 * The mixed-model warning names the model SET and, without this, nothing
	 * attributed a model to a report: `encodingName` is always present for a VOD job,
	 * so the short-circuit above meant the legend read `bbb-pte-crf-17` and the model
	 * appeared nowhere per job. An operator told "compare reports that share a model",
	 * looking at up to six series, could not see which was which (review finding). The
	 * comparison screen passes `true` exactly when the set is mixed, so the ordinary
	 * uniform case keeps its short labels.
	 */
	withModel = false,
): string {
	const short = shortJobId(job.id);
	if (job.encodingName) {
		return withModel && job.model
			? `${job.encodingName} · ${job.model}`
			: job.encodingName;
	}
	return job.model ? `${job.model} · ${short}` : short;
}

/** Sort without mutating report order or its chart-color/fallback-label identity. */
export function sortedRenditions(
	results: readonly VmafResultDetail[],
	direction: "asc" | "desc" = "asc",
) {
	const bitrate = (r: VmafResultDetail) => {
		const value = r.renditionRef.bitrate;
		return typeof value === "number" && Number.isFinite(value) && value > 0
			? value
			: null;
	};
	return results
		.map((result, index) => ({ result, index }))
		.sort((a, b) => {
			const left = bitrate(a.result);
			const right = bitrate(b.result);
			if (left === null) return right === null ? a.index - b.index : 1;
			if (right === null) return -1;
			return (
				(direction === "asc" ? left - right : right - left) || a.index - b.index
			);
		});
}

/** Round a VMAF score for display (one decimal — the meaningful resolution). */
export function fmtScore(score: number): string {
	return Number.isFinite(score) ? score.toFixed(1) : "—";
}

/** Round a PSNR value (dB) for display (two decimals — dB resolution). */
export function fmtPsnr(value: number | undefined): string {
	return typeof value === "number" && Number.isFinite(value)
		? value.toFixed(2)
		: "—";
}

/** True iff at least one result carries a pooled PSNR block (PSNR-enabled run). */
export function anyHasPsnr(results: { pooled: PooledMetrics }[]): boolean {
	return results.some((r) => r.pooled.psnr !== undefined);
}

/**
 * Do these jobs share a scoring generation?
 *
 * A chart overlaying generation 1 and generation 2 series is not comparing
 * encodes, it is comparing pipelines: the same bytes measured 23.08 before the
 * 2026-08-11 PTS fix and 84.21 after. A difference that large swamps every real
 * quality difference on the same axes, so the comparison screen has to say so
 * rather than draw it silently.
 *
 * Absent (`undefined`) counts as generation 1 — a row from before the column
 * existed was scored by the old pipeline by definition.
 */
export function scoringGenerations(
	jobs: readonly { scoringVersion?: number }[],
): number[] {
	return [...new Set(jobs.map((j) => j.scoringVersion ?? 1))].sort(
		(a, b) => a - b,
	);
}

export function mixesScoringGenerations(
	jobs: readonly { scoringVersion?: number }[],
): boolean {
	return scoringGenerations(jobs).length > 1;
}

/**
 * Which libvmaf MODELS these jobs were scored with.
 *
 * The same problem as `scoringGenerations`, and it was unguarded until measured:
 * a model is a viewing condition, not a detail. Scoring one synthetic pair with
 * every bundled model (`scripts/vmaf-model-matrix.ts`, recorded in
 * ) put the SAME bytes at 83.01 on
 * `vmaf_v1.0.16_3d0h` and 92.44 on `vmaf_v1.0.16_3d0h_2160` — 9.4 points from the
 * model alone, which is larger than most of the encode differences this screen
 * exists to show. `vmaf_v0.6.1` vs `vmaf_v0.6.1neg` moved 3.7 the other way.
 *
 * So an overlay of two models is a chart of two viewing conditions. The screen
 * says so instead of drawing it silently, exactly as it does for generations.
 */
/**
 * Upper bound for every VMAF axis — a FUNCTION of the data, not the constant 100.
 *
 * VMAF is not capped at 100. None of the fourteen bundled models defines
 * `score_clip`, and `pooled.ts` never clamps, so a model tuned for a larger display
 * legitimately scores above it: measured pooled MEANS of 101.88, 104.20, 107.49 and
 * 107.53 on a 1080p reference (review finding). Four charts hardcoded
 * `domain={[0, 100]}`, which draws such a series flattened against the top of the
 * plot — a plateau that is not in the data, with nothing to say so. That is the same
 * defect class this screen's mixed-model warning exists to prevent: a chart that
 * reads as something other than what was measured.
 *
 * Recharts calls this with the data's own maximum. Keeping the floor at 100 means
 * the ordinary case looks exactly as it did — the axis only grows when a real score
 * needs the room.
 */
export const VMAF_AXIS_MAX = (dataMax: number): number =>
	Math.max(100, Math.ceil(dataMax));

export function comparedModels(jobs: readonly { model?: string }[]): string[] {
	return [
		...new Set(jobs.map((j) => j.model).filter((m): m is string => !!m)),
	].sort();
}

export function mixesModels(jobs: readonly { model?: string }[]): boolean {
	return comparedModels(jobs).length > 1;
}

/**
 * Do these jobs disagree about frame subsampling?
 *
 * The third axis of "not comparable", and the quietest: `n_subsample=N` scores
 * every Nth frame, so a subsampled report's `min` is the worst of a SAMPLE while a
 * full-precision report's is the worst frame there is. The pooled means stay close,
 * which is what makes it quiet — the chart looks fine and the minima are measuring
 * different things.
 *
 * Null/absent means full precision: every report written before the worker
 * recorded this, and every run with `VMAF_SUBSAMPLE` unset, which is the default.
 * So `null` and `1` are the same answer and must not read as two.
 */
export function comparedSubsamples(
	jobs: readonly { subsample?: number | null }[],
): number[] {
	return [
		...new Set(
			jobs.map((j) =>
				typeof j.subsample === "number" && j.subsample > 1 ? j.subsample : 1,
			),
		),
	].sort((a, b) => a - b);
}

export function mixesSubsampling(
	jobs: readonly { subsample?: number | null }[],
): boolean {
	return comparedSubsamples(jobs).length > 1;
}
