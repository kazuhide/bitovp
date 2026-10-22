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
