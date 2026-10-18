"use client";

import { useT } from "@/lib/i18n/context";
import type {
	ComparisonContext,
	DegenerateReason,
	SeparationReason,
} from "../vmaf-context";
import {
	comparisonContext,
	judgeDegenerate,
	ladderSeparation,
} from "../vmaf-context";
import { renditionLabel, type VmafResultDetail } from "../vmaf-shared";

/**
 * What this report's numbers MEAN, above the numbers.
 *
 * A real report read mean 16.77 with half its frames at zero and was investigated as a
 * pipeline bug for hours. Re-scoring the same pair by hand reproduced it exactly: the
 * pipeline was right, the ladder was 300 kbps at 360p, and the source was 1080p. The
 * defect was presenting a correct number with none of that beside it.
 *
 * So the banner states the comparison's terms first, and flags a degenerate
 * distribution as "not a quality measurement" rather than letting the reader decide
 * whether 16.77 is bad encoding or a broken tool. The same rule runs in the
 * verification harness, so a nightly run cannot pass a degenerate report as a result.
 */
/**
 * One sentence per comparison kind, chosen by an exhaustive switch so a new kind
 * cannot silently render as blank — the `never` is the guard.
 */
/**
 * The alert's sentence. It was English prose returned by `judgeDegenerate` and
 * printed verbatim, so the `role="alert"` line — the most important sentence on this
 * screen — stayed English under `ja` while the badge next to it was translated. The
 * fix two functions away in the same module did not reach it (review catch).
 */
function degenerateReason(
	reason: DegenerateReason,
	t: ReturnType<typeof useT>["t"],
): string {
	switch (reason.kind) {
		case "zeros-dominate":
			return t("qc.reasonZerosDominate", {
				zeros: String(reason.zeros),
				frames: String(reason.frames),
				percent: String(reason.percent),
			});
		case "zeros-ordinary":
			return t("qc.reasonZerosOrdinary", {
				zeros: String(reason.zeros),
				frames: String(reason.frames),
				percent: String(reason.percent),
			});
		case "no-zero-frames":
			return t("qc.reasonNoZeroFrames");
		case "p25-below-one":
			return t("qc.reasonP25BelowOne");
		case "harmonic-collapsed":
			return t("qc.reasonHarmonicCollapsed");
		case "sound":
			return t("qc.reasonSound");
		default: {
			const exhaustive: never = reason;
			return String(exhaustive);
		}
	}
}

function separationReason(
	reason: SeparationReason,
	t: ReturnType<typeof useT>["t"],
): string {
	switch (reason.kind) {
		case "too-few-rungs":
			return t("qc.reasonTooFewRungs");
		case "all-steps-move":
			return t("qc.reasonAllStepsMove");
		case "flat-steps":
			return t("qc.reasonFlatSteps", { steps: reason.steps.join(", ") });
		default: {
			const exhaustive: never = reason;
			return String(exhaustive);
		}
	}
}

function comparisonSentence(
	context: ComparisonContext,
	t: ReturnType<typeof useT>["t"],
): string {
	// No `??` anywhere below: every payload is REQUIRED by its variant, so a missing
	// number is a compile error here instead of an unfilled `{placeholder}` throw at
	// render time (which took the whole page down).
	const modelPart = (model: string | undefined) =>
		model ? t("qc.summaryModelPart", { model }) : "";
	switch (context.kind) {
		case "cross-resolution":
			return t("qc.summaryCrossResolution", {
				rendition: String(context.renditionHeight),
				reference: String(context.referenceHeight),
				upscale: context.upscale.toFixed(1),
				model: modelPart(context.model),
			});
		case "native":
			return t("qc.summaryNative", {
				rendition: String(context.renditionHeight),
				reference: String(context.referenceHeight),
				model: modelPart(context.model),
			});
		case "unknown-with-model":
			return t("qc.summaryUnknownWithModel", { model: context.model });
		case "unknown-without-model":
			return t("qc.summaryUnknownNoModel");
		default: {
			const exhaustive: never = context;
			return String(exhaustive);
		}
	}
}

export function VmafContextBanner({
	results,
	model,
	referenceHeight,
}: {
	results: VmafResultDetail[];
	model?: string | null;
	/** Source height, when the job recorded it. */
	referenceHeight?: number | null;
}) {
	const { t } = useT();
	if (results.length === 0) {
		return null;
	}

	// The tallest rendition stands in for the comparison's terms: every rung was scored
	// against the same source, so one upscale factor per report would be misleading —
	// this names the BEST case, and the per-row heights are in the table below.
	const tallest = results.reduce<VmafResultDetail | undefined>(
		(best, r) =>
			(r.renditionRef.height ?? 0) > (best?.renditionRef.height ?? 0)
				? r
				: best,
		undefined,
	);
	const context = comparisonContext({
		renditionHeight: tallest?.renditionRef.height ?? null,
		referenceHeight: referenceHeight ?? null,
		...(model ? { model } : {}),
	});

	const degenerate = results
		.map((r) => ({
			label: renditionLabel(r.renditionRef, 0),
			verdict: judgeDegenerate(r.pooled, r.frames),
		}))
		.filter((r) => r.verdict.degenerate);

	const separation = ladderSeparation(
		results.map((r, i) => ({
			label: renditionLabel(r.renditionRef, i),
			bitrate: r.renditionRef.bitrate ?? null,
			mean: r.pooled.mean,
		})),
	);

	return (
		<div className="mt-6 space-y-2">
			{/* The terms of the comparison, always — this is the line that was missing. */}
			<p className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
				<span className="font-medium text-zinc-300">
					{context.kind === "cross-resolution"
						? t("qc.geometryUpscaled", {
								rendition: String(context.renditionHeight),
								reference: String(context.referenceHeight),
								upscale: context.upscale.toFixed(1),
							})
						: context.kind === "native"
							? t("qc.geometryNative", {
									rendition: String(context.renditionHeight),
									reference: String(context.referenceHeight),
								})
							: t("qc.comparisonUnknown")}
				</span>
				{" — "}
				{/* The sentence is BUILT HERE, from a discriminant, rather than arriving
				    as a finished English string that no catalogue could reach. */}
				{comparisonSentence(context, t)}
			</p>

			{degenerate.length > 0 ? (
				<p
					role="alert"
					className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-red-300 text-xs"
				>
					<span className="font-medium">{t("qc.degenerateBadge")}</span>
					{" — "}
					{degenerate
						.map((d) => `${d.label}: ${degenerateReason(d.verdict.reason, t)}`)
						.join(" / ")}
				</p>
			) : null}

			{!separation.separated ? (
				<p className="rounded-md border border-amber-900 bg-amber-950/20 px-3 py-2 text-amber-300 text-xs">
					<span className="font-medium">{t("qc.ladderFlatBadge")}</span>
					{" — "}
					{separationReason(separation.reason, t)}
				</p>
			) : null}
		</div>
	);
}
