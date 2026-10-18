"use client";

import {
	type DvrBudgetLevel,
	LIVE_MANIFEST_ELEMENT_BUDGET,
	manifestElementEstimate,
	recommendedMaxTimeshiftSec,
} from "@bitovp/core";
import { DetailPopover, KeyValueRows } from "@/components/ui/detail-popover";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";

/**
 * C8 DVR gauge (COVERAGE §0 C8: "surface the calculator, don't silently
 * clamp"). Pure model + presentational bar: the numbers always show the
 * real utilization (121% stays 121%) — only the bar FILL is visually
 * capped at 100% while the over color and copy carry the truth. The
 * validator's C8 error remains the blocking surface; this gauge never
 * blocks or clamps anything itself.
 */

export type DvrLeg = { segmentLengthSec: number };

export type DvrGaugeModel =
	| { state: "off" }
	| {
			state: "on";
			totalElements: number;
			segmentsPerLeg: number[];
			budget: number;
			/** Real ratio — exceeds 1 when over budget (unclamped by design). */
			utilization: number;
			level: DvrBudgetLevel;
			/** VISUAL bar fill percentage only, capped at 100 (never the data). */
			fillPct: number;
			/** Real percentage for copy (e.g. 121). */
			pct: number;
			/** Percentage points beyond the budget (0 when within it). */
			overflowPct: number;
			/**
			 * The math line as a key + values rather than a formatted string: this
			 * function is pure (its tests call it directly, with no provider), so it
			 * cannot hold a translator. The component formats it.
			 */
			mathLine:
				| {
						key: "uiX.dvrMathUniform" | "uiX.dvrMathUniformOne";
						values: {
							timeshift: number;
							segment: number;
							segments: number;
							renditions: number;
							total: number;
							budget: number;
						};
				  }
				| {
						key: "uiX.dvrMathMixed";
						values: {
							timeshift: number;
							renditions: number;
							total: number;
							budget: number;
						};
				  };
			recommendedSec: number | null;
	  };

/**
 * Per-leg Σ ceil(timeshift / segmentLength) — exactly the validator's C8
 * math (live/validate.ts) so the gauge can never disagree with the
 * blocking issue list.
 */
export function dvrGaugeModel(
	timeshiftSec: number | undefined,
	legs: DvrLeg[],
): DvrGaugeModel {
	if (
		timeshiftSec === undefined ||
		!Number.isFinite(timeshiftSec) ||
		timeshiftSec <= 0 ||
		legs.length === 0 ||
		legs.some(
			(leg) =>
				!Number.isFinite(leg.segmentLengthSec) || leg.segmentLengthSec <= 0,
		)
	) {
		return { state: "off" };
	}
	const segmentsPerLeg = legs.map(
		(leg) =>
			manifestElementEstimate({
				timeshiftSec,
				segmentLengthSec: leg.segmentLengthSec,
				renditionCount: 1,
			}).segmentsPerRendition,
	);
	const totalElements = segmentsPerLeg.reduce((sum, n) => sum + n, 0);
	const utilization = totalElements / LIVE_MANIFEST_ELEMENT_BUDGET;
	const level: DvrBudgetLevel =
		utilization > 1 ? "over" : utilization > 0.8 ? "warning" : "ok";
	const uniformSegmentLength = legs.every(
		(leg) => leg.segmentLengthSec === legs[0]?.segmentLengthSec,
	)
		? legs[0]?.segmentLengthSec
		: undefined;
	const mathLine = uniformSegmentLength
		? {
				// English pluralises the rendition count; main did this with a ternary in
				// the template, and collapsing it to one key made "× 1 renditions".
				key: (legs.length === 1
					? "uiX.dvrMathUniformOne"
					: "uiX.dvrMathUniform") as
					| "uiX.dvrMathUniformOne"
					| "uiX.dvrMathUniform",
				values: {
					timeshift: timeshiftSec,
					segment: uniformSegmentLength,
					segments: segmentsPerLeg[0] ?? 0,
					renditions: legs.length,
					total: totalElements,
					budget: LIVE_MANIFEST_ELEMENT_BUDGET,
				},
			}
		: {
				key: "uiX.dvrMathMixed" as const,
				values: {
					timeshift: timeshiftSec,
					renditions: legs.length,
					total: totalElements,
					budget: LIVE_MANIFEST_ELEMENT_BUDGET,
				},
			};
	const recommendedSec = uniformSegmentLength
		? recommendedMaxTimeshiftSec({
				segmentLengthSec: uniformSegmentLength,
				renditionCount: legs.length,
			})
		: null;
	const pct = Math.round(utilization * 1000) / 10;
	return {
		state: "on",
		totalElements,
		segmentsPerLeg,
		budget: LIVE_MANIFEST_ELEMENT_BUDGET,
		utilization,
		level,
		fillPct: Math.min(100, utilization * 100),
		pct,
		overflowPct: pct > 100 ? Math.round((pct - 100) * 10) / 10 : 0,
		mathLine,
		recommendedSec,
	};
}

export const DVR_LEVEL_BAR_CLASS: Record<DvrBudgetLevel, string> = {
	ok: "bg-emerald-500",
	warning: "bg-amber-500",
	over: "bg-red-500",
};

export const DVR_LEVEL_TEXT_CLASS: Record<DvrBudgetLevel, string> = {
	ok: "text-emerald-400",
	warning: "text-amber-400",
	over: "text-red-400",
};

export function formatSeconds(totalSec: number): string {
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = Math.round(totalSec % 60);
	const parts: string[] = [];
	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds}s`);
	}
	return parts.join(" ");
}

export function DvrGauge({
	label,
	tooltip,
	timeshiftSec,
	legs,
	variant = "gauge",
}: {
	label: string;
	tooltip?: string;
	timeshiftSec: number | undefined;
	legs: DvrLeg[];
	/**
	 * "note" : one line of reference information beside the
	 * timeshift field — no bar, no box. The validator's C8 error stays the
	 * blocking surface, so an over-budget window still says so.
	 */
	variant?: "gauge" | "note";
}) {
	const { t } = useT();
	const model = dvrGaugeModel(timeshiftSec, legs);
	const labelEl = (
		<span className="inline-flex items-center gap-1 font-medium text-xs text-zinc-300">
			{label}
			{tooltip ? (
				<InfoHint
					text={tooltip}
					label={t("uiX.moreInformationFor", { label })}
				/>
			) : null}
		</span>
	);
	if (variant === "note") {
		return (
			<p className="text-xs text-zinc-500" data-testid="dvr-note">
				{labelEl}
				<span className="mx-1">·</span>
				{model.state === "off" ? (
					t("uiX.noDvrWindowHint", { budget: LIVE_MANIFEST_ELEMENT_BUDGET })
				) : (
					<>
						<span className={`font-mono ${DVR_LEVEL_TEXT_CLASS[model.level]}`}>
							{t("uiX.pctOfBudget", { pct: model.pct })}
						</span>
						<span className="mx-1">·</span>
						<span className="font-mono text-[11px]">
							{model.mathLine.key === "uiX.dvrMathMixed" ? (
								// The wizard is where a leg can be FIXED, so the per-leg
								// breakdown (ux inventory #15) stays one click away here too
								// (review-539 R2).
								<DetailPopover
									summary={t(model.mathLine.key, model.mathLine.values)}
									label={t("uiX.dvrPerLegLabel")}
								>
									<KeyValueRows
										sort={false}
										record={Object.fromEntries(
											model.segmentsPerLeg.map((count, index) => [
												t("uiX.dvrLegName", { n: index + 1 }),
												t("uiX.dvrLegSegments", { count }),
											]),
										)}
									/>
								</DetailPopover>
							) : (
								t(model.mathLine.key, model.mathLine.values)
							)}
						</span>
						{model.recommendedSec !== null ? (
							<>
								<span className="mx-1">·</span>
								{t("uiX.maxInBudgetTimeshift")}
								<span className="ml-1 text-zinc-300">
									{formatSeconds(model.recommendedSec)}
								</span>
							</>
						) : null}
						{model.level === "over" ? (
							<span role="alert" className="ml-2 text-red-400">
								{t("uiX.overBudgetBlocks", { budget: model.budget })}
							</span>
						) : null}
					</>
				)}
			</p>
		);
	}
	if (model.state === "off") {
		return (
			<div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
				{labelEl}
				<p className="mt-1 text-xs text-zinc-500">
					{t("uiX.noDvrWindowHint", {
						budget: LIVE_MANIFEST_ELEMENT_BUDGET,
					})}
				</p>
			</div>
		);
	}
	return (
		<div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
			<div className="flex items-center justify-between gap-3">
				{labelEl}
				<p className={`font-mono text-xs ${DVR_LEVEL_TEXT_CLASS[model.level]}`}>
					{t("uiX.pctOfBudget", { pct: model.pct })}
					{model.overflowPct > 0 ? (
						<span className="ml-2 rounded border border-red-500/50 bg-red-950/40 px-1 py-px text-[10px] text-red-300">
							{t("uiX.overBudgetPct", { pct: model.overflowPct })}
						</span>
					) : null}
				</p>
			</div>
			{/* Decorative bar — the utilization is carried by the visible text
			    (percentage + overflow marker + math line), so screen readers lose
			    nothing. The FILL is visually capped at 100%; overflow gets the
			    ring treatment + the marker above instead of a longer bar. */}
			<div
				aria-hidden
				className={`mt-2 h-2 overflow-hidden rounded-full bg-zinc-800 ${
					model.overflowPct > 0 ? "ring-1 ring-red-500/70" : ""
				}`}
			>
				<div
					data-testid="dvr-gauge-bar"
					data-level={model.level}
					data-overflow={model.overflowPct > 0 ? "true" : undefined}
					className={`h-full ${DVR_LEVEL_BAR_CLASS[model.level]}`}
					style={{ width: `${model.fillPct}%` }}
				/>
			</div>
			<p className="mt-2 font-mono text-[11px] text-zinc-500">
				{model.mathLine.key === "uiX.dvrMathMixed" ? (
					// The mixed-segment case hid the per-leg breakdown the uniform
					// case shows — WHICH leg blows the C8 budget is the fixable fact
					// (ux inventory #15). Click opens leg → segment count.
					<DetailPopover
						summary={t(model.mathLine.key, model.mathLine.values)}
						label={t("uiX.dvrPerLegLabel")}
					>
						<KeyValueRows
							sort={false}
							record={Object.fromEntries(
								model.segmentsPerLeg.map((count, index) => [
									t("uiX.dvrLegName", { n: index + 1 }),
									t("uiX.dvrLegSegments", { count }),
								]),
							)}
						/>
					</DetailPopover>
				) : (
					t(model.mathLine.key, model.mathLine.values)
				)}
			</p>
			{model.recommendedSec !== null ? (
				<p className="mt-1 text-[11px] text-zinc-500">
					{t("uiX.maxInBudgetTimeshift")}{" "}
					<span className="text-zinc-300">
						{formatSeconds(model.recommendedSec)}
					</span>{" "}
					{t("uiX.recommendedSecTail", { sec: model.recommendedSec })}
				</p>
			) : null}
			{model.level === "over" ? (
				<p role="alert" className="mt-1 text-[11px] text-red-400">
					{t("uiX.overBudgetBlocks", { budget: model.budget })}
				</p>
			) : null}
		</div>
	);
}
