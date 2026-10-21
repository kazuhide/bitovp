"use client";

import type { PerTitleProposal } from "@bitovp/core";
import { useId } from "react";
import { useT } from "@/lib/i18n/context";

const lowField = "lowComplexityBoundaryForMaxBitrate";
const highField = "highComplexityBoundaryForMaxBitrate";
type Stream = PerTitleProposal["api"]["streams"][number];
type Boundaries = { low: number; high: number };

const copy = {
	en: {
		title: "Complexity boundaries",
		axis: "API settings · kbps (log scale)",
		comparison: "Before → current",
		low: "Low",
		high: "High",
		unavailable: "Boundary values unavailable",
		row: (number: number) => `Rendition ${number}`,
	},
	ja: {
		title: "複雑度境界",
		axis: "API設定 · kbps（対数目盛）",
		comparison: "変更前 → 現在",
		low: "下側",
		high: "上側",
		unavailable: "境界値が未設定または無効です",
		row: (number: number) => `レンディション ${number}`,
	},
};

function eligible(stream: Stream) {
	return (
		stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
		stream.perTitleSettings?.bitrateSelectionMode === "COMPLEXITY_RANGE"
	);
}

function boundaries(stream: Stream): Boundaries | null {
	const low = stream.perTitleSettings?.[lowField];
	const high = stream.perTitleSettings?.[highField];
	return low !== undefined &&
		high !== undefined &&
		Number.isSafeInteger(low) &&
		Number.isSafeInteger(high) &&
		low > 0 &&
		high > low
		? { low, high }
		: null;
}

function idCounts(streams: readonly Stream[]) {
	const counts = new Map<string, number>();
	for (const stream of streams) {
		counts.set(stream.rowId, (counts.get(stream.rowId) ?? 0) + 1);
	}
	return counts;
}

export function PerTitleComplexity({
	proposal,
	baseline,
}: {
	proposal: PerTitleProposal;
	baseline?: PerTitleProposal;
}) {
	const { locale } = useT();
	const text = copy[locale];
	const id = useId();
	const currentCounts = idCounts(proposal.api.streams);
	const previousStreams =
		baseline?.codec === proposal.codec ? baseline.api.streams : [];
	const previousCounts = idCounts(previousStreams);
	const rows = proposal.api.streams.flatMap((stream, index) => {
		if (!eligible(stream)) return [];
		const current = boundaries(stream);
		const previousStream =
			currentCounts.get(stream.rowId) === 1 &&
			previousCounts.get(stream.rowId) === 1
				? previousStreams.find(
						(item) => item.rowId === stream.rowId && eligible(item),
					)
				: undefined;
		const previous =
			current && previousStream ? boundaries(previousStream) : null;
		const changed =
			previous &&
			current &&
			(previous.low !== current.low || previous.high !== current.high);
		return [
			{
				stream,
				number: index + 1,
				current,
				previous: changed ? previous : null,
			},
		];
	});
	if (rows.length === 0) return null;
	const endpoints = rows.flatMap(({ current, previous }) =>
		current
			? [
					current.low,
					current.high,
					...(previous ? [previous.low, previous.high] : []),
				]
			: [],
	);
	const minimum = Math.min(...endpoints);
	const maximum = Math.max(...endpoints);
	const span = Math.log1p((maximum - minimum) / minimum);
	const position = (value: number) =>
		Math.max(
			0,
			Math.min(100, (Math.log1p((value - minimum) / minimum) / span) * 100),
		);
	const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	const bitrate = (value: number) => numbers.format(value / 1000);
	const valueText = (current: number, previous: number | undefined) =>
		previous !== undefined && previous !== current
			? `${bitrate(previous)} → ${bitrate(current)}`
			: bitrate(current);
	return (
		<figure
			aria-labelledby={`${id}-title`}
			className="space-y-2 border-t border-zinc-800 pt-3 text-xs"
		>
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<span id={`${id}-title`} className="font-medium text-zinc-200">
					{text.title}
				</span>
				<span className="text-zinc-400">{text.axis}</span>
			</figcaption>
			{rows.some((row) => row.previous) ? (
				<p className="text-right text-zinc-400">{text.comparison}</p>
			) : null}
			{rows.map(({ stream, number, current, previous }) => (
				<div key={`${stream.rowId}-${number}`} className="space-y-1">
					<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
						<span className="text-zinc-300">
							{text.row(number)}
							{Number.isSafeInteger(stream.height) && (stream.height ?? 0) > 0
								? ` · ${stream.height} px`
								: ""}
						</span>
						{current ? (
							<dl className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
								<div className="flex gap-1.5">
									<dt title={lowField} className="text-zinc-400">
										{text.low}
										<span className="sr-only"> ({lowField})</span>
									</dt>
									<dd className="text-zinc-200">
										{valueText(current.low, previous?.low)}
									</dd>
								</div>
								<div className="flex gap-1.5">
									<dt title={highField} className="text-zinc-400">
										{text.high}
										<span className="sr-only"> ({highField})</span>
									</dt>
									<dd className="text-zinc-200">
										{valueText(current.high, previous?.high)}
									</dd>
								</div>
							</dl>
						) : (
							<span className="text-zinc-400">{text.unavailable}</span>
						)}
					</div>
					{current ? (
						<svg
							viewBox="0 0 100 12"
							preserveAspectRatio="none"
							className="h-3 w-full overflow-visible"
							aria-hidden="true"
							focusable="false"
						>
							<line
								x1="0"
								x2="100"
								y1="6"
								y2="6"
								className="stroke-zinc-800"
								strokeWidth="1"
								vectorEffect="non-scaling-stroke"
							/>
							{(
								[
									{ values: previous, phase: "before" },
									{ values: current, phase: "current" },
								] as const
							).map(({ values, phase }) =>
								values ? (
									<g
										key={phase}
										className={
											phase === "current"
												? "stroke-emerald-400"
												: "stroke-zinc-400"
										}
									>
										<line
											x1={position(values.low)}
											x2={position(values.high)}
											y1={phase === "current" ? 8 : 3}
											y2={phase === "current" ? 8 : 3}
											strokeWidth="2"
											strokeDasharray={phase === "current" ? undefined : "3 2"}
											vectorEffect="non-scaling-stroke"
										/>
										{(
											[
												{ field: lowField, value: values.low },
												{ field: highField, value: values.high },
											] as const
										).map(({ field, value }) => (
											<circle
												key={field}
												data-testid="per-title-complexity-point"
												data-phase={phase}
												data-boundary={field}
												data-value={value}
												cx={position(value)}
												cy={phase === "current" ? 8 : 3}
												r="1"
												className={
													phase === "current"
														? "fill-emerald-400"
														: "fill-zinc-900"
												}
												strokeWidth="1"
												vectorEffect="non-scaling-stroke"
											/>
										))}
									</g>
								) : null,
							)}
						</svg>
					) : null}
				</div>
			))}
			{endpoints.length > 0 ? (
				<div className="flex justify-between text-zinc-400 tabular-nums">
					<span>{bitrate(minimum)}</span>
					<span>{bitrate(maximum)}</span>
				</div>
			) : null}
		</figure>
	);
}
