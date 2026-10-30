/**
 * Pure libvmaf ffmpeg command construction (P4 — our own VMAF pipeline;
 * Bitmovin has no VMAF API). No process interaction here: the worker
 * (PR3) prepends FFMPEG_PATH and spawns the argv this returns, so every
 * shape is unit-testable without ffmpeg.
 *
 * Geometry contract: libvmaf requires the distorted and reference frames
 * to share identical dimensions AND frame rate. The distorted input is
 * therefore scale/fps-conformed to the reference before the comparison —
 * callers pass the reference geometry in `scaleToReference` / `fpsConform`.
 *
 * Input order (verified against the ffmpeg libvmaf docs): the FIRST input
 * is the distorted video, the SECOND is the reference. So distortedPath →
 * -i #0 → [0:v], referencePath → -i #1 → [1:v].
 *
 * Model syntax (verified): libvmaf's `model` is a '|'-delimited list of
 * models whose params are ':'-separated; a built-in version is selected
 * with `version=<model>` and a custom model file is loaded with
 * `path=<file>`. JSON output uses `log_fmt=json` + `log_path=<file>`.
 *
 * Extra metrics (P4-PR5): libvmaf computes VMAF by default but can ALSO emit
 * PSNR/SSIM/… in the same pass via its `feature` option — a '|'-delimited
 * list of `name=<feature>` specs (e.g. `feature=name=psnr` or
 * `feature='name=psnr|name=float_ssim'`). PSNR adds `psnr_y` per frame +
 * pooled to the JSON the VMAF run already produces; we therefore ride the
 * one libvmaf invocation rather than calling Bitmovin's QC API. `features`
 * here is the list of feature NAMES (just "psnr" today); empty/absent ⇒ no
 * `feature` token, i.e. VMAF-only as before.
 */

/**
 * The scoring GENERATION this builder produces.
 *
 * Bump it whenever a change makes new numbers incomparable with old ones, and
 * say here what changed — a version with no explanation is a number nobody can
 * act on.
 *
 * 1 — neither libvmaf input was PTS-rebased. framesync pairs frames by
 *     timestamp, so a mezzanine with a non-zero first PTS had its frame N
 *     scored against the encode's frame N±1. Measured on one real encode: mean
 *     23.08, p25 0.00, harmonic mean 0.00.
 * 2 — both pads carry `setpts=N/FRAME_RATE/TB` (2026-08-11). Same encode:
 *     mean 84.21, p25 80.47, harmonic mean 84.01.
 * 3 — common AVTB before index rebasing (2026-09-07). Different timebases
 *     otherwise truncate floating expressions differently, mispairing frames.
 *     Sealed 720p VOD: minimum 0 → 84.72; every metric matches original-PTS
 *     control. See
 *
 * Checked before settling on 2: nothing else in this builder's history moved an
 * existing plan's score. `scaleToReference`/`fpsConform` were present in the
 * first commit; the PSNR feature and the `model=path=` branch are additive and
 * leave a VMAF-only argv untouched; `n_subsample` is emitted only when set above
 * 1. So generation 1 is one pipeline, not several wearing one label.
 *
 * What this number does NOT capture: `VMAF_SUBSAMPLE`, an operator env knob that
 * makes the per-frame series sparser and the `min` less reliable *within* a
 * generation (the mean is barely affected). Two reports at the same generation
 * with different subsample settings are still not strictly comparable on their
 * minima — recorded here rather than pretended away, because a version number
 * invites exactly that assumption.
 */
export const VMAF_SCORING_VERSION = 3;
/** Explicit frame-index method: generation 6 ignores container clean aperture
 * while retaining codec conformance cropping. Generation 5 used CLI defaults,
 * so MOV container crops could silently resize the pristine reference. */
export const VMAF_FRAME_INDEX_SCORING_VERSION = 6;
/** Experimental local GPU path; never presented as the validated CPU/cloud method. */
export const VMAF_EXPERIMENTAL_GPU_SCORING_VERSION = 7;
/** NVDEC with legacy CPU scoring; distinct from VMAFx's 10-bit comparison path. */
export const VMAF_EXPERIMENTAL_GPU_DECODE_SCORING_VERSION = 8;
export const VMAF_FRAME_INDEX_CROP_POLICY =
	"codec-only-ignore-container-aperture-v1";

export type VmafReferenceGeometry = {
	width: number;
	height: number;
	sampleAspectRatio: string;
};

/** Unknown ffprobe sentinels preserve the documented legacy coded canvas only. */
export function sampleAspectRatioFromProbe(value: unknown): string | undefined {
	if (
		value === undefined ||
		value === "N/A" ||
		value === "0:1" ||
		value === "0/1"
	)
		return undefined;
	if (
		typeof value !== "string" ||
		!/^[1-9]\d{0,8}[:/][1-9]\d{0,8}$/.test(value)
	)
		throw new Error("INVALID_SAMPLE_ASPECT_RATIO");
	let [numerator, denominator] = value.split(/[:/]/).map(Number) as [
		number,
		number,
	];
	let a = numerator,
		b = denominator;
	while (b) [a, b] = [b, a % b];
	numerator /= a;
	denominator /= a;
	return `${numerator}:${denominator}`;
}

/** Display width is derived from coded samples, never from a caller's canvas claim. */
export function frameIndexDisplayGeometry(reference: VmafReferenceGeometry): {
	width: number;
	height: number;
} {
	if (
		![reference.width, reference.height].every(
			(v) => Number.isSafeInteger(v) && v > 0 && v <= 16384,
		)
	)
		throw new Error("INVALID_REFERENCE_DISPLAY_GEOMETRY");
	const sar = sampleAspectRatioFromProbe(reference.sampleAspectRatio);
	if (!sar) throw new Error("INVALID_SAMPLE_ASPECT_RATIO");
	const [numerator, denominator] = sar.split(":").map(Number) as [
		number,
		number,
	];
	const width = (reference.width * numerator) / denominator;
	if (!Number.isSafeInteger(width) || width < 1 || width > 16384)
		throw new Error("INVALID_REFERENCE_DISPLAY_GEOMETRY");
	return { width, height: reference.height };
}

/** NVDEC surface format; downloaded without dropping chroma or bit depth. */
export type VmafCudaDecode = {
	device: number;
	downloadFormat: "nv12" | "p010le";
};

export type VmafCommandOptions = {
	/** External, opt-in VMAFx binary. Its numerical parity must be qualified separately. */
	scoring?: { backend: "vmafx-cuda"; device: number };
	/** Local input decoding only. Scaling, feature extraction and scoring stay on CPU. */
	decode?: { distorted?: VmafCudaDecode; reference?: VmafCudaDecode };
	/** Explicit full-frame report methodology; omitted preserves generation 3. */
	measurementMethod?: "FRAME_INDEX_BT709_10BIT";
	/** Exact reference cadence, e.g. 24000/1001 (never decimal-rounded). */
	referenceFrameRate?: string;
	/** Original encoded geometry/precision for the VMAF v1 CAMBI feature. */
	distortedOriginal?: { width: number; height: number; bitdepth: number };
	/** Known reference SAR enables a validated square-pixel display canvas.
	 * Omitted on legacy payloads: scaleToReference remains the coded canvas,
	 * including when ffprobe reports absent/N/A/0:1 SAR. */
	referenceGeometry?: VmafReferenceGeometry;
	/** Reference (pristine) video — libvmaf input #1 ([1:v]). */
	referencePath: string;
	/** Distorted (encoded) video — libvmaf input #0 ([0:v]). */
	distortedPath: string;
	/** Built-in model version, e.g. "vmaf_v0.6.1" (model=version=…). */
	model: string;
	/** Custom model file. When set, overrides `model` with model=path=…. */
	modelPath?: string;
	/** JSON log destination passed to libvmaf (log_fmt=json:log_path=…). */
	logPath: string;
	/** Conform the distorted frame size to the reference's W×H. */
	scaleToReference?: { width: number; height: number };
	/** Conform the distorted frame rate to the reference's fps. */
	fpsConform?: number;
	/** libvmaf worker threads (n_threads); omitted ⇒ libvmaf default. */
	threads?: number;
	/** Ordinary-path decoder limit, applied separately before each input. */
	decoderThreads?: number;
	/** Ordinary-path filter graph limit; does not change the filter graph. */
	filterComplexThreads?: number;
	/**
	 * Frame subsample stride (libvmaf `n_subsample`): when set and > 1, libvmaf
	 * scores only every Nth frame. This speeds scoring up — but it yields a
	 * SPARSER per-frame series and a LESS-RELIABLE min (a transient worst frame
	 * can be skipped); the pooled MEAN is barely affected. Absent or 1 ⇒ no token
	 * emitted (full precision, byte-identical argv to a non-subsample run).
	 */
	subsample?: number;
	/**
	 * Extra libvmaf features to compute alongside VMAF, by NAME (e.g.
	 * ["psnr"]). Emitted as `feature=name=a|name=b`. Empty/absent ⇒ no feature
	 * token (VMAF-only). Convenience: pass `psnr: true` to add "psnr".
	 */
	features?: string[];
	/** Shorthand for adding the "psnr" feature (libvmaf psnr_y). */
	psnr?: boolean;
	/**
	 * Drop leading frames so the two sides line up (see `align-linear.ts`).
	 * Positive drops from the REFERENCE, negative from the DISTORTED, 0 ⇒ no
	 * node emitted and the argv is byte-identical to an unaligned run.
	 *
	 * `select`+`setpts`, never `-ss`: a seek lands on a keyframe, which would
	 * quantise the very offset being corrected. Measured worth: a one-frame
	 * correction took a real encode's mean VMAF from 31.6 to 61.4.
	 */
	alignFrames?: number;
};

/**
 * Builds the ffmpeg argv (WITHOUT the binary) that scores `distortedPath`
 * against `referencePath` with libvmaf and writes a JSON report to
 * `logPath`. The distorted input is scaled (+fps-conformed) to the
 * reference geometry so libvmaf's identical-dimensions requirement holds.
 */
export function buildVmafCommand(opts: VmafCommandOptions): string[] {
	for (const input of [opts.decode?.distorted, opts.decode?.reference]) {
		if (
			input &&
			(!Number.isSafeInteger(input.device) ||
				input.device < 0 ||
				!["nv12", "p010le"].includes(input.downloadFormat))
		)
			throw new Error("INVALID_CUDA_DECODE_OPTIONS");
	}
	if (
		opts.scoring &&
		(opts.scoring.backend !== "vmafx-cuda" ||
			!Number.isSafeInteger(opts.scoring.device) ||
			opts.scoring.device < 0)
	)
		throw new Error("INVALID_CUDA_SCORING_OPTIONS");
	if (opts.measurementMethod === "FRAME_INDEX_BT709_10BIT") {
		if (opts.scoring)
			throw new Error("GPU_SCORING_NOT_QUALIFIED_FOR_FRAME_INDEX_METHOD");
		if (opts.decode?.distorted || opts.decode?.reference)
			throw new Error("GPU_DECODE_NOT_QUALIFIED_FOR_FRAME_INDEX_METHOD");
		const size = opts.scaleToReference;
		const original = opts.distortedOriginal;
		const rate = opts.referenceFrameRate;
		const positiveInt = (v: number | undefined) =>
			Number.isSafeInteger(v) && (v ?? 0) > 0;
		if (
			!size ||
			!original ||
			!rate ||
			!/^[1-9]\d{0,8}\/[1-9]\d{0,8}$/.test(rate) ||
			![size.width, size.height, original.width, original.height].every(
				positiveInt,
			) ||
			![8, 10, 12, 16].includes(original.bitdepth) ||
			opts.fpsConform !== undefined ||
			(opts.alignFrames ?? 0) !== 0 ||
			(opts.subsample ?? 1) !== 1
		) {
			throw new Error("INVALID_FRAME_INDEX_MEASUREMENT_OPTIONS");
		}
		if (opts.referenceGeometry) {
			const display = frameIndexDisplayGeometry(opts.referenceGeometry);
			if (display.width !== size.width || display.height !== size.height)
				throw new Error("INPUT_GEOMETRY_CLAIM_MISMATCH");
		}
		const model = opts.modelPath
			? `path=${opts.modelPath}`
			: `version=${opts.model}`;
		const cambi = opts.model.startsWith("vmaf_v1.")
			? `\\:cambi.enc_width=${original.width}\\:cambi.enc_height=${original.height}\\:cambi.enc_bitdepth=${original.bitdepth}`
			: "";
		const features = [
			...new Set([...(opts.features ?? []), ...(opts.psnr ? ["psnr"] : [])]),
		];
		const leg = `setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709,scale=${size.width}:${size.height}:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv,format=yuv420p10le,setsar=1,settb=AVTB,setpts=N/(${rate})/TB`;
		const params = [
			`model='${model}${cambi}'`,
			...(features.length
				? [`feature=${features.map((f) => `name=${f}`).join("|")}`]
				: []),
			"log_fmt=json",
			`log_path=${opts.logPath}`,
			...(opts.threads !== undefined ? [`n_threads=${opts.threads}`] : []),
			"n_subsample=1",
			"eof_action=endall",
			"shortest=1",
			"repeatlast=0",
		].join(":");
		return [
			"-hide_banner",
			"-nostdin",
			"-threads",
			"2",
			"-apply_cropping",
			"codec",
			"-i",
			opts.distortedPath,
			"-threads",
			"2",
			"-apply_cropping",
			"codec",
			"-i",
			opts.referencePath,
			"-filter_complex_threads",
			"1",
			"-filter_complex",
			`[0:v:0]${leg}[dist];[1:v:0]${leg}[ref];[dist][ref]libvmaf=${params}[out]`,
			"-map",
			"[out]",
			"-an",
			"-sn",
			"-f",
			"null",
			"-",
		];
	}
	for (const threads of [opts.decoderThreads, opts.filterComplexThreads]) {
		if (
			threads !== undefined &&
			(!Number.isSafeInteger(threads) || threads <= 0)
		)
			throw new Error(
				"Decoder and filter thread limits must be positive integers",
			);
	}

	// Distorted-side conform chain feeding libvmaf's [main] pad. flags=bicubic
	// keeps the resampled distorted frame faithful; fps re-times so frame
	// counts line up with the reference. Both are conditional — an already
	// matching distorted needs no scale/fps node.
	const conform: string[] = downloadChain(opts.decode?.distorted);
	if (opts.scaleToReference) {
		conform.push(
			`scale=${opts.scaleToReference.width}:${opts.scaleToReference.height}:flags=bicubic`,
		);
	}
	if (opts.fpsConform !== undefined) {
		conform.push(`fps=${opts.fpsConform}`);
	}
	if (opts.scoring) conform.push("format=yuv420p10le");

	// libvmaf model selector: a custom file (path=) wins over the built-in
	// version (version=); exactly one is emitted. Both are verified against the
	// worker's ffmpeg — `path=` is how the "VMAF v1" models load (they have no
	// usable built-in). Injection-safe by construction: `model` is charset-
	// constrained at the schema boundary (core `vmafModelNameSchema` — no
	// `:`/`|`/`\`/`/`/whitespace), and `modelPath` is the trusted VMAF_MODEL_DIR
	// joined with that safe name, so neither can break out of the `:`-delimited
	// libvmaf filter value (no escaping needed).
	const modelSpec = opts.modelPath
		? `model=path=${opts.modelPath}`
		: `model=version=${opts.model}`;

	// Extra-feature selector: union of explicit `features` and the `psnr`
	// shorthand, de-duplicated, order-stable. libvmaf's `feature` value is a
	// '|'-delimited list of `name=<feature>` specs; emitted only when non-empty
	// so a VMAF-only run keeps the exact argv it had before PR5.
	const featureNames = [
		...(opts.features ?? []),
		...(opts.psnr ? ["psnr"] : []),
	].filter((name, i, all) => all.indexOf(name) === i);
	const featureSpec =
		featureNames.length > 0
			? `feature=${featureNames.map((name) => `name=${name}`).join("|")}`
			: undefined;

	// Frame subsample (n_subsample): emitted only when > 1 so the default run is
	// full-precision and byte-identical to before. Positioned AFTER n_threads.
	const subsample =
		opts.subsample !== undefined && opts.subsample > 1
			? opts.subsample
			: undefined;

	const libvmafParams = [
		modelSpec,
		...(featureSpec ? [featureSpec] : []),
		`log_path=${opts.logPath}`,
		"log_fmt=json",
		...(opts.threads !== undefined ? [`n_threads=${opts.threads}`] : []),
		...(subsample !== undefined ? [`n_subsample=${subsample}`] : []),
	].join(":");

	// [0:v] = distorted (conformed + re-timed) → [dist], [1:v] = reference
	// (re-timed) → [ref]; libvmaf takes (distorted, reference) in that order.
	/**
	 * REBASE TIMESTAMPS on both sides. Not cosmetic — worth 61 VMAF points on a
	 * real encode.
	 *
	 * libvmaf pairs its two inputs through ffmpeg's framesync, i.e. **by PTS**,
	 * not by frame order. A QuickTime mezzanine carrying an edit list (or any
	 * non-zero first PTS) has its frame N compared against the encode's frame
	 * N±1, and the damage is bimodal rather than gradual: static frames still
	 * match while moving ones collapse to zero. Measured on the `vmaf-only-h264`
	 * mirror against its own source :
	 *
	 *   as scored before : mean 23.08, p50 13.30, 63 of 217 frames near zero
	 *   PTS rebased      : mean 84.24, p50 84.66,  0 frames near zero
	 *
	 * `setpts=N/FRAME_RATE/TB` re-times every frame onto a regular cadence from
	 * zero, which is exactly the assumption "frame N against frame N" requires.
	 * Applied to BOTH pads because either side can carry the offset, and
	 * unconditionally because comparing mistimed frames is never the intent.
	 *
	 * Stated rather than hidden: every VMAF score this product recorded before
	 * this change is understated and NOT comparable with scores after it.
	 */
	// A shared fine-grained timebase is essential before index-based rebasing.
	// With fps=30's 1/30 TB, floating truncation maps e.g. frame 492 to PTS
	// 491; the reference's finer TB loses only a tick, so framesync mispairs.
	// https://ffmpeg.org/ffmpeg-filters.html#libvmaf (common AVTB on both pads).
	const REBASE_PTS = "settb=AVTB,setpts=N/FRAME_RATE/TB";

	/**
	 * `n` is escaped as `n\,` because the whole graph is ONE argv token: an
	 * unescaped comma would end the `select` filter and start a new one.
	 */
	const dropLeading = (frames: number) =>
		`select='gte(n\\,${frames})',${REBASE_PTS}`;
	const align = opts.alignFrames ?? 0;
	if (align < 0) {
		// `dropLeading` already re-times, so this side is done.
		conform.push(dropLeading(-align));
	} else {
		conform.push(REBASE_PTS);
	}

	const distChain = conform.length > 0 ? conform.join(",") : "null";
	/**
	 * Both pads are always labelled now, because both are always re-timed. The
	 * "keep the default argv byte-identical" discipline that `n_subsample` and
	 * `feature` follow cannot apply here — the point of the change is that the old
	 * argv produced wrong numbers.
	 */
	const refChain = [
		...downloadChain(opts.decode?.reference),
		...(opts.scoring ? ["format=yuv420p10le"] : []),
		align > 0 ? dropLeading(align) : REBASE_PTS,
	].join(",");
	const filterComplex =
		`[0:v]${distChain}[dist];` +
		`[1:v]${refChain}[ref];` +
		`[dist][ref]${opts.scoring ? vmafxFilter(opts, featureNames) : `libvmaf=${libvmafParams}`}[out]`;

	return [
		"-hide_banner",
		"-nostdin",
		...(opts.decoderThreads !== undefined
			? ["-threads", String(opts.decoderThreads)]
			: []),
		...cudaInputArgs(opts.decode?.distorted),
		"-i",
		opts.distortedPath,
		...(opts.decoderThreads !== undefined
			? ["-threads", String(opts.decoderThreads)]
			: []),
		...cudaInputArgs(opts.decode?.reference),
		"-i",
		opts.referencePath,
		...(opts.filterComplexThreads !== undefined
			? ["-filter_complex_threads", String(opts.filterComplexThreads)]
			: []),
		"-filter_complex",
		filterComplex,
		"-map",
		"[out]",
		"-f",
		"null",
		"-",
	];
}

function cudaInputArgs(input: VmafCudaDecode | undefined): string[] {
	return input
		? [
				"-hwaccel",
				"cuda",
				"-hwaccel_device",
				String(input.device),
				"-hwaccel_output_format",
				"cuda",
			]
		: [];
}

function downloadChain(input: VmafCudaDecode | undefined): string[] {
	return input
		? [
				"hwdownload",
				`format=${input.downloadFormat}`,
				`format=${input.downloadFormat === "nv12" ? "yuv420p" : "yuv420p10le"}`,
			]
		: [];
}

function vmafxFilter(opts: VmafCommandOptions, features: string[]): string {
	if (
		!opts.modelPath ||
		!/^vmaf_v1\.0\.16_(?:hfr_)?(?:3d0h(?:_2160)?|5d0h|1d5h_2160)$/.test(
			opts.model,
		)
	)
		throw new Error("VMAFX_REQUIRES_V1_MODEL_FILE");
	if (features.some((feature) => feature !== "psnr"))
		throw new Error("VMAFX_UNQUALIFIED_FEATURE");
	if ((opts.subsample ?? 1) !== 1) throw new Error("VMAFX_REQUIRES_ALL_FRAMES");
	const original = opts.distortedOriginal;
	if (
		!original ||
		![original.width, original.height].every(
			(n) => Number.isSafeInteger(n) && n > 0,
		) ||
		![8, 10, 12, 16].includes(original.bitdepth)
	)
		throw new Error("VMAFX_REQUIRES_ORIGINAL_DISTORTED_GEOMETRY");
	return `vmafx=${[
		"backend=cuda",
		`device=${opts.scoring?.device}`,
		"import=auto",
		"gpumask=0",
		"provenance=log+report",
		"score_fmt=%.17g",
		`model='path=${opts.modelPath}\\:name=vmaf\\:cambi.enc_width=${original.width}\\:cambi.enc_height=${original.height}\\:cambi.enc_bitdepth=${original.bitdepth}'`,
		...(features.length ? [`feature=${features.join("|")}`] : []),
		`log_path=${opts.logPath}`,
		"log_fmt=json",
		...(opts.threads !== undefined ? [`n_threads=${opts.threads}`] : []),
		`n_subsample=${opts.subsample ?? 1}`,
		// Match the legacy libvmaf framesync defaults, not VMAFx's different defaults.
		"eof_action=repeat",
		"shortest=0",
		"repeatlast=1",
	].join(":")}`;
}
