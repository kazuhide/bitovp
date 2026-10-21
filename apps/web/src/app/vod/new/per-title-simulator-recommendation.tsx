"use client";

import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { type ReactNode, useId } from "react";
import { useT } from "@/lib/i18n/context";
import { perTitleSimulatorCopy } from "./per-title-simulator-copy";

export function PerTitleRecommendation({
	goal,
	proposal,
	children,
}: {
	goal: PerTitleGoal;
	proposal: PerTitleProposal;
	children?: ReactNode;
}) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const id = useId();
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
	const required = proposal.api.streams.filter(
		(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
	);
	const automaticCount = proposal.api.streams.length - required.length;
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
			<p
				className={`text-xs ${proposal.status === "conflict" ? "text-red-300" : proposal.status === "unknown" ? "text-amber-300" : "text-zinc-300"}`}
			>
				{proposal.status === "conflict"
					? copy.recommendationConflict
					: !proposal.applicable || proposal.status === "unknown"
						? copy.recommendationUnknown
						: copy.recommendationReady}
			</p>
			<p className="text-xs text-zinc-300">
				{copy.modeGuidance[goal.strategy]}
			</p>
			<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
				<dt className="text-zinc-400">{copy.recommendedGlobal}</dt>
				<dd className="text-right tabular-nums text-zinc-100">
					{range(global.minBitrate, global.maxBitrate)}
				</dd>
				{checkedCount ? (
					<>
						<dt className="text-zinc-400">{copy.recommendedModelCount}</dt>
						<dd className="text-right tabular-nums text-zinc-100">
							{checkedCount.minimum === checkedCount.maximum
								? format(checkedCount.minimum)
								: `${format(checkedCount.minimum)}–${format(checkedCount.maximum)}`}
						</dd>
					</>
				) : null}
				<dt className="text-zinc-400">{copy.minimumRatio}</dt>
				<dd className="text-right tabular-nums text-zinc-100">
					{positive(global.minBitrateStepSize)
						? `≈ ${format(global.minBitrateStepSize)}`
						: copy.unknown}
				</dd>
				<dt className="text-zinc-400">{copy.maximumRatio}</dt>
				<dd className="text-right tabular-nums text-zinc-100">
					{positive(global.maxBitrateStepSize)
						? `≈ ${format(global.maxBitrateStepSize)}`
						: copy.unknown}
				</dd>
				{adjustmentRange ? (
					<>
						<dt className="text-zinc-400">{copy.minimumStepRange}</dt>
						<dd className="break-words text-right tabular-nums text-zinc-100">
							{adjustmentRange}
						</dd>
					</>
				) : null}
				{automaticCount ? (
					<>
						<dt className="text-zinc-400">{copy.automaticCount}</dt>
						<dd className="text-right tabular-nums text-zinc-100">
							{automaticCount}
						</dd>
					</>
				) : null}
			</dl>
			<p className="text-xs text-zinc-400">{copy.ratioHint}</p>
			{adjustmentRange ? (
				<p className="text-xs text-zinc-400">{copy.minimumStepRangeHint}</p>
			) : null}
			{required.length ? (
				<>
					<div className="overflow-x-auto">
						<table
							aria-label={copy.rows}
							className="w-full text-left text-xs text-zinc-300 [&_th]:py-2 [&_th]:font-medium [&_td]:py-2 [&_tbody_tr]:border-t [&_tbody_tr]:border-zinc-800"
						>
							<thead>
								<tr>
									<th scope="col">{copy.height}</th>
									<th scope="col">{copy.requestedRange}</th>
								</tr>
							</thead>
							<tbody>
								{required.map((stream) => (
									<tr key={stream.rowId}>
										<td>
											{positive(stream.height)
												? format(stream.height)
												: copy.unknown}
										</td>
										<td>
											{stream.mode ===
											"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
												? range(
														stream.perTitleSettings?.minBitrate,
														stream.perTitleSettings?.maxBitrate,
													)
												: copy.chosenWithinGlobal}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="text-xs text-zinc-400">{copy.requestedRangeHint}</p>
				</>
			) : null}
			{automaticCount ? (
				<p className="text-xs text-zinc-400">{copy.automaticCountHint}</p>
			) : null}
			<p className="text-xs text-zinc-400">{copy.countScope}</p>
			{children}
		</section>
	);
}
