/**
 * What a VMAF number MEANS, stated beside it.
 *
 * A real report read mean 16.77 with half its frames at exactly 0. It was investigated
 * as a pipeline bug for hours; re-scoring the same pair by hand reproduced it exactly,
 * so the pipeline was right all along. The number was arithmetically correct and
 * perceptually meaningless: a 300 kbps 360p rung upscaled 3× and compared against a
 * pristine 1080p source saturates VMAF at the bottom.
 *
 * The defect was therefore not the score. It was presenting a correct number with no
 * context, which made a healthy pipeline look broken and would equally let a genuinely
 * broken one look merely "low". So this module derives two things from the numbers
 * already in the report:
 *
 *   1. the comparison's own terms — upscale factor, model, what was scored
 *   2. whether the distribution is DEGENERATE, i.e. not a quality measurement at all
 *
 * Pure and UI-free: the QC screens render it, and the verification harness asserts the
 * same rule ( §4, the QC row), so a run cannot report a degenerate
 * report as a quality result.
 */

/** The subset of pooled metrics this judgement needs. */
export type PooledForContext = {
	mean: number;
	min: number;
	max: number;
	harmonicMean: number;
	percentiles?: {
		p1?: number;
		p5?: number;
		p10?: number;
		p25?: number;
		p50?: number;
	};
	low1Percent?: number;
};

export type DegenerateVerdict = {
	/** True when the distribution cannot be read as a quality score. */
	degenerate: boolean;
	/** Share of frames at (or effectively at) zero, when it could be computed. */
	zeroShare?: number;
	/** One line, always present — the reason, or why it looks sound. */
	/**
	 * WHY, as a discriminant plus its numbers — never a sentence. This was English
	 * prose rendered verbatim into the `role="alert"` line, so the most important
	 * sentence on the QC screen stayed English under `ja` while the badge beside it
	 * was translated . The banner builds the words.
	 */
	reason: DegenerateReason;
};

/**
 * The threshold above which a zero-heavy distribution stops being a quality signal.
 *
 * Chosen from the observed case rather than taste: the real report had 106 of 217 frames
 * below 1.0 (49%). A handful of zero frames on a hard cut is ordinary; half the runtime
 * at zero means the two videos were not comparable at those frames — misalignment,
 * pathological input, or a ladder far outside the model's range. 20% is well clear of
 * ordinary and well below the observed failure.
 */
export const DEGENERATE_ZERO_SHARE = 0.2;

/**
 * Judge a pooled distribution.
 *
 * `frames` is optional because a report may arrive downsampled; when it is absent the
 * percentiles carry the same signal — `p25 === 0` means at least a quarter of frames
 * scored zero, which is the same statement.
 */
export function judgeDegenerate(
	pooled: PooledForContext,
	frames?: { vmaf: number }[],
): DegenerateVerdict {
	if (frames && frames.length > 0) {
		const zeros = frames.filter((f) => f.vmaf < 1).length;
		const zeroShare = zeros / frames.length;
		if (zeroShare > DEGENERATE_ZERO_SHARE) {
			return {
				degenerate: true,
				zeroShare,
				reason: {
					kind: "zeros-dominate",
					zeros,
					frames: frames.length,
					percent: Math.round(zeroShare * 100),
				},
			};
		}
		return {
			degenerate: false,
			zeroShare,
			reason:
				zeros === 0
					? { kind: "no-zero-frames" }
					: {
							kind: "zeros-ordinary",
							zeros,
							frames: frames.length,
							percent: Math.round(zeroShare * 100),
						},
		};
	}

	// No per-frame series: the percentiles say the same thing. A p25 of zero means a
	// quarter of the runtime scored nothing.
	const p25 = pooled.percentiles?.p25;
	if (p25 !== undefined && p25 < 1) {
		return {
			degenerate: true,
			reason: { kind: "p25-below-one" },
		};
	}
	// A harmonic mean of exactly 0 with a non-zero arithmetic mean is the signature of
	// at least one zero frame dominating the aggregate.
	if (pooled.harmonicMean === 0 && pooled.mean > 0) {
		return {
			degenerate: true,
			reason: { kind: "harmonic-collapsed" },
		};
	}
	return { degenerate: false, reason: { kind: "sound" } };
}

/**
 * STRUCTURED, not prose. This used to hand the view two finished English sentences
 * (`geometry` and `summary`) which it rendered verbatim, so a Japanese operator read
 * English on the QC screen no matter what the catalogue said — the same failure the
 * job detail had, where core built a chain description as a string .
 *
 * The numbers live here because deciding what was compared with what is logic; the
 * words live in the catalogue because they are words.
 */
/** Why a distribution is (or is not) a usable quality measurement. */
export type DegenerateReason =
	| { kind: "zeros-dominate"; zeros: number; frames: number; percent: number }
	| { kind: "zeros-ordinary"; zeros: number; frames: number; percent: number }
	| { kind: "no-zero-frames" }
	| { kind: "p25-below-one" }
	| { kind: "harmonic-collapsed" }
	| { kind: "sound" };

/** Whether adjacent rungs separate, and which steps did not move. */
export type SeparationReason =
	| { kind: "too-few-rungs" }
	| { kind: "all-steps-move" }
	| { kind: "flat-steps"; steps: string[] };

/**
 * A REAL discriminated union: each variant carries exactly the payload its sentence
 * needs, REQUIRED. The first version put every field optional at the top level with
 * `kind` as a bare tag, so the type admitted `kind: "cross-resolution"` with
 * `upscale: undefined` — and the banner's `??`-fallbacks papered over it right up to
 * the `qc.geometryUpscaled` render, which throws on an unfilled `{upscale}` and takes the
 * whole QC page down (review catch: unreachable today only by construction, which is
 * exactly the kind of invariant that quietly stops holding). With the payload inside
 * the variant, that state cannot typecheck and every `??` in the banner disappears.
 */
export type ComparisonContext =
	| {
			kind: "cross-resolution";
			renditionHeight: number;
			referenceHeight: number;
			upscale: number;
			model?: string;
			crossResolution: true;
	  }
	| {
			kind: "native";
			renditionHeight: number;
			referenceHeight: number;
			upscale: number;
			model?: string;
			crossResolution: false;
	  }
	| { kind: "unknown-with-model"; model: string; crossResolution: false }
	| { kind: "unknown-without-model"; crossResolution: false };

/**
 * Describe what was compared with what.
 *
 * The upscale factor is the fact that was missing all along: a reader who sees
 * "360p scored against a 1080p source, 3.0× upscale" does not mistake a low number for
 * a broken encoder, and a reader who sees "1080p → 1080p (native)" knows a low number
 * really is a problem.
 */
export function comparisonContext(input: {
	renditionHeight?: number | null;
	referenceHeight?: number | null;
	model?: string;
}): ComparisonContext {
	const { renditionHeight, referenceHeight, model } = input;
	if (!renditionHeight || !referenceHeight) {
		return model
			? { kind: "unknown-with-model", model, crossResolution: false }
			: { kind: "unknown-without-model", crossResolution: false };
	}
	const upscale = referenceHeight / renditionHeight;
	// 1.01 rather than 1: a ladder rung one pixel off its nominal height is native.
	// Two literal returns rather than one with a computed tag: TypeScript narrows a
	// discriminated union per return site, so each branch is checked against ITS
	// variant's required payload.
	if (upscale > 1.01) {
		return {
			kind: "cross-resolution",
			renditionHeight,
			referenceHeight,
			upscale,
			crossResolution: true,
			...(model ? { model } : {}),
		};
	}
	return {
		kind: "native",
		renditionHeight,
		referenceHeight,
		upscale,
		crossResolution: false,
		...(model ? { model } : {}),
	};
}

/**
 * Do adjacent rungs separate the way a working ladder should?
 *
 * A ladder where a 2× bitrate step changes nothing is either mis-encoded or being
 * measured wrong. Reported as an observation, never as a failure: content genuinely
 * saturates, and a ladder at the top of the scale legitimately flattens out.
 */
export function ladderSeparation(
	rungs: { label: string; bitrate?: number | null; mean: number }[],
): { separated: boolean; reason: SeparationReason } {
	const ranked = rungs
		.filter((r) => typeof r.bitrate === "number" && r.bitrate > 0)
		.sort((a, b) => (a.bitrate as number) - (b.bitrate as number));
	if (ranked.length < 2) {
		return { separated: true, reason: { kind: "too-few-rungs" } };
	}
	const flat: string[] = [];
	for (let i = 1; i < ranked.length; i++) {
		const low = ranked[i - 1] as (typeof ranked)[number];
		const high = ranked[i] as (typeof ranked)[number];
		const ratio = (high.bitrate as number) / (low.bitrate as number);
		// Only judge a step that should visibly matter, and only below saturation.
		if (ratio < 1.5 || low.mean >= 85) {
			continue;
		}
		if (high.mean - low.mean < 1) {
			flat.push(
				`${low.label}→${high.label} (${ratio.toFixed(1)}× bitrate, ${(high.mean - low.mean).toFixed(2)} VMAF)`,
			);
		}
	}
	return flat.length === 0
		? {
				separated: true,
				reason: { kind: "all-steps-move" },
			}
		: {
				separated: false,
				reason: { kind: "flat-steps", steps: flat },
			};
}
