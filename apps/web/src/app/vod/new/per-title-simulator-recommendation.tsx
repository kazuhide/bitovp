"use client";

import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import { PerTitleComplexity } from "./per-title-simulator-complexity";
import { perTitleSimulatorCopy } from "./per-title-simulator-copy";
import { PerTitleLadder } from "./per-title-simulator-ladder";
import { PerTitleOutputChart } from "./per-title-simulator-output";
import { PerTitleParameterView } from "./per-title-simulator-parameters";

export function PerTitleRecommendation({
	goal,
	proposal,
	baseline,
	axis,
	children,
	comparisonOnly = false,
}: {
	goal: PerTitleGoal;
	proposal: PerTitleProposal;
	baseline?: PerTitleProposal;
	axis?: { minimum: number; maximum: number };
	children?: ReactNode;
	comparisonOnly?: boolean;
}) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const id = useId();
	const [view, setView] = useState<"output" | "ranges">("output");
	const format = (value: number, precision = 6) =>
		new Intl.NumberFormat(locale, {
			maximumSignificantDigits: precision,
		}).format(value);
	const positive = (value: number | undefined): value is number =>
		value !== undefined && Number.isFinite(value) && value > 0;
	const formatBitrate = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
			value / 1000,
		);
	const range = (lower: number | undefined, upper: number | undefined) =>
		positive(lower) && positive(upper) && lower <= upper
			? `${formatBitrate(lower)}–${formatBitrate(upper)}`
			: copy.unknown;
	const hasRequiredRows = proposal.api.streams.some(
		(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
	);
	const hasAutomaticTemplates = proposal.api.streams.some(
		(stream) => stream.mode === "PER_TITLE_TEMPLATE",
	);
	const global = proposal.api.global;
	const inputConflicts: string[] = [];
	if (
		!positive(global.minBitrate) ||
		!positive(global.maxBitrate) ||
		global.minBitrate > global.maxBitrate
	) {
		inputConflicts.push(
			locale === "ja"
				? "全体の最小・最大ビットレートには正の値を指定し、最小値を最大値以下にしてください。"
				: "Use positive overall bitrate limits, with the minimum no greater than the maximum.",
		);
	} else {
		for (const stream of proposal.api.streams) {
			if (stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")
				continue;
			const minimum = stream.perTitleSettings?.minBitrate;
			const maximum = stream.perTitleSettings?.maxBitrate;
			const label = stream.height ? `${stream.height} px` : stream.rowId;
			if (!positive(minimum) || !positive(maximum) || minimum > maximum) {
				inputConflicts.push(
					locale === "ja"
						? `${label} の最小・最大ビットレートを確認してください。正の値を指定し、最小値を最大値以下にしてください。`
						: `${label}: use positive bitrate limits, with the minimum no greater than the maximum.`,
				);
				continue;
			}
			if (minimum < global.minBitrate) {
				inputConflicts.push(
					locale === "ja"
						? `${label} の下限 ${formatBitrate(minimum)} kbps が全体の下限 ${formatBitrate(global.minBitrate)} kbps を下回っています。全体の下限を下げるか、このレンディションの下限を上げてください。`
						: `${label}: minimum ${formatBitrate(minimum)} kbps is below the overall minimum ${formatBitrate(global.minBitrate)} kbps. Lower the overall minimum or raise this rendition's minimum.`,
				);
			}
			if (maximum > global.maxBitrate) {
				inputConflicts.push(
					locale === "ja"
						? `${label} の上限 ${formatBitrate(maximum)} kbps が全体の上限 ${formatBitrate(global.maxBitrate)} kbps を超えています。全体の上限を上げるか、このレンディションの上限を下げてください。`
						: `${label}: maximum ${formatBitrate(maximum)} kbps exceeds the overall maximum ${formatBitrate(global.maxBitrate)} kbps. Raise the overall maximum or lower this rendition's maximum.`,
				);
			}
		}
	}
	const derivation = proposal.derivation;
	const checked =
		proposal.status === "candidate" &&
		proposal.applicable &&
		derivation?.targetSatisfied === true;
	const upperScenario = proposal.scenarios.find(
		(scenario) => scenario.fraction === 1,
	);
	const countRange =
		checked && upperScenario?.status === "modelled"
			? upperScenario.modelCountRange
			: null;
	const checkedCount =
		countRange &&
		Number.isSafeInteger(countRange.minimum) &&
		Number.isSafeInteger(countRange.maximum) &&
		countRange.minimum > 0 &&
		countRange.maximum >= countRange.minimum
			? countRange
			: null;
	const adjustment = derivation?.minimumStepRange;
	const checkedAdjustment =
		checked &&
		adjustment &&
		positive(adjustment.lowerInclusive) &&
		positive(adjustment.upperInclusive) &&
		adjustment.lowerInclusive > 1 &&
		adjustment.upperInclusive >= adjustment.lowerInclusive &&
		positive(adjustment.maximumStep) &&
		Number.isSafeInteger(adjustment.exampleCount) &&
		adjustment.exampleCount > 1 &&
		adjustment.maximumStep === global.maxBitrateStepSize
			? adjustment
			: undefined;
	const adjustmentRange = checkedAdjustment
		? (() => {
				const { lowerInclusive, upperInclusive } = checkedAdjustment;
				const precision =
					lowerInclusive !== upperInclusive &&
					format(lowerInclusive) === format(upperInclusive)
						? format(lowerInclusive, 10) === format(upperInclusive, 10)
							? 17
							: 10
						: 6;
				return `≈ ${format(lowerInclusive, precision)}–${format(upperInclusive, precision)}`;
			})()
		: undefined;
	return (
		<section
			aria-labelledby={`${id}-recommendation`}
			className="space-y-3 rounded-md border border-zinc-700 bg-zinc-900/40 p-4"
		>
			<h3
				id={`${id}-recommendation`}
				className="font-medium text-sm text-zinc-100"
			>
				{copy.recommendation}
			</h3>
			{inputConflicts.length ? (
				<div
					role="alert"
					className="space-y-1 rounded-md border border-amber-800/60 bg-amber-950/20 p-2 text-xs text-amber-200"
				>
					{inputConflicts.map((message, index) => (
						<p key={`${index}:${message}`}>{message}</p>
					))}
				</div>
			) : null}
			{comparisonOnly || !checked ? (
				<p
					role="status"
					className="flex flex-wrap gap-x-3 text-xs text-zinc-400"
				>
					{comparisonOnly ? <span>{copy.comparisonOnly}</span> : null}
					{!checked ? (
						<span>
							{proposal.status === "conflict"
								? copy.recommendationConflict
								: copy.recommendationUnknown}
						</span>
					) : null}
				</p>
			) : null}
			<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
				<dt className="text-zinc-400">{copy.recommendedGlobal}</dt>
				<dd className="text-right tabular-nums text-zinc-100">
					{range(global.minBitrate, global.maxBitrate)}
				</dd>
				{checkedCount && goal.countPolicy.kind !== "unrestricted" ? (
					<>
						<dt className="text-zinc-400">{copy.recommendedModelCount}</dt>
						<dd className="text-right tabular-nums text-zinc-100">
							{format(checkedCount.maximum)}
						</dd>
					</>
				) : null}
			</dl>
			<fieldset className="flex flex-wrap gap-1">
				<legend className="sr-only">{copy.chartView}</legend>
				{(["output", "ranges"] as const).map((value) => (
					<Button
						key={value}
						size="sm"
						variant={view === value ? "secondary" : "ghost"}
						aria-pressed={view === value}
						onClick={() => setView(value)}
					>
						{value === "output" ? copy.outputView : copy.rangesView}
					</Button>
				))}
			</fieldset>
			{view === "output" ? (
				<PerTitleOutputChart proposal={proposal} axis={axis} />
			) : (
				<PerTitleLadder proposal={proposal} axis={axis} />
			)}
			<PerTitleComplexity proposal={proposal} baseline={baseline} />
			<PerTitleParameterView proposal={proposal} />
			{children}
			<details className="space-y-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
				<summary className="cursor-pointer">{copy.apiParameters}</summary>
				<p>{copy.modeGuidance[goal.strategy]}</p>
				<p>{copy.countScope}</p>
				<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 pt-2">
					<dt>{copy.minimumRatio}</dt>
					<dd className="text-right tabular-nums text-zinc-100">
						{positive(global.minBitrateStepSize)
							? `≈ ${format(global.minBitrateStepSize)}`
							: copy.unknown}
					</dd>
					<dt>{copy.maximumRatio}</dt>
					<dd className="text-right tabular-nums text-zinc-100">
						{positive(global.maxBitrateStepSize)
							? `≈ ${format(global.maxBitrateStepSize)}`
							: copy.unknown}
					</dd>
					{adjustmentRange ? (
						<>
							<dt>{copy.minimumStepRange}</dt>
							<dd className="break-words text-right tabular-nums text-zinc-100">
								{adjustmentRange}
							</dd>
						</>
					) : null}
				</dl>
				<p>{copy.ratioHint}</p>
				{adjustmentRange ? <p>{copy.minimumStepRangeHint}</p> : null}
				{hasRequiredRows ? <p>{copy.requestedRangeHint}</p> : null}
				{hasAutomaticTemplates ? <p>{copy.automaticCountHint}</p> : null}
				{checkedCount ? <p>{copy.countCheckScope}</p> : null}
			</details>
		</section>
	);
}
