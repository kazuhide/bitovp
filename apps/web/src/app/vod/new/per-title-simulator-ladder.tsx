"use client";

import type { PerTitleProposal } from "@bitovp/core";
import { useId } from "react";
import { useT } from "@/lib/i18n/context";

const copy = {
	en: {
		title: "Allowed bitrate ranges",
		data: "Allowed bitrate ranges (data)",
		axis: "kbps (log scale)",
		description:
			"Specified bitrate limits, not encoding results. Automatic candidates are not guaranteed outputs.",
		height: "Height (px)",
		range: "Range (kbps)",
		auto: "Auto",
		candidates: (count: number) => `Automatic candidates: ${count}`,
		empty: "No required resolutions",
		invalid: "Ranges unavailable",
		overflow: "Outside scale",
	},
	ja: {
		title: "許容ビットレート範囲",
		data: "許容ビットレート範囲（データ）",
		axis: "kbps（対数目盛）",
		description:
			"設定した許容範囲で、エンコード結果ではありません。自動生成の候補は出力を保証しません。",
		height: "高さ (px)",
		range: "範囲 (kbps)",
		auto: "自動",
		candidates: (count: number) => `自動生成の候補: ${count}`,
		empty: "必須の解像度なし",
		invalid: "範囲を表示できません",
		overflow: "目盛りの範囲外",
	},
};

export type PerTitleChartAxis = { minimum: number; maximum: number };

export function perTitlePlotAxis(axis: PerTitleChartAxis) {
	const { minimum, maximum } = axis;
	if (
		!Number.isSafeInteger(minimum) ||
		minimum <= 0 ||
		!Number.isSafeInteger(maximum) ||
		maximum < minimum
	)
		return null;
	const span = Math.log1p((maximum - minimum) / minimum);
	const position = (value: number) => {
		if (span === 0) return value < minimum ? 0 : value > maximum ? 100 : 50;
		if (value <= minimum) return 0;
		if (value >= maximum) return 100;
		return (Math.log1p((value - minimum) / minimum) / span) * 100;
	};
	return {
		minimum,
		maximum,
		position,
		ticks: [
			...new Set([
				minimum,
				Math.min(maximum, minimum * Math.exp(span / 2)),
				maximum,
			]),
		],
	};
}

function plotData(proposal: PerTitleProposal) {
	const { minBitrate: minimum, maxBitrate: maximum } = proposal.api.global;
	const positiveInteger = (value: number | undefined): value is number =>
		value !== undefined && Number.isSafeInteger(value) && value > 0;
	if (
		!positiveInteger(minimum) ||
		!positiveInteger(maximum) ||
		maximum < minimum
	)
		return null;
	const rows: Array<{
		id: string;
		height: number;
		minimum: number;
		maximum: number;
		auto: boolean;
	}> = [];
	let candidates = 0;
	for (const stream of proposal.api.streams) {
		if (stream.mode === "PER_TITLE_TEMPLATE") {
			candidates++;
			continue;
		}
		if (
			(stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" &&
				stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE") ||
			!positiveInteger(stream.height)
		)
			return null;
		const auto = stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
		const lower = auto ? minimum : stream.perTitleSettings?.minBitrate;
		const upper = auto ? maximum : stream.perTitleSettings?.maxBitrate;
		if (
			!positiveInteger(lower) ||
			!positiveInteger(upper) ||
			lower > upper ||
			lower < minimum ||
			upper > maximum
		)
			return null;
		rows.push({
			id: stream.rowId,
			height: stream.height,
			minimum: lower,
			maximum: upper,
			auto,
		});
	}
	return { minimum, maximum, rows, candidates };
}

export function PerTitleLadder({
	proposal,
	axis,
}: {
	proposal: PerTitleProposal;
	axis?: PerTitleChartAxis;
}) {
	const { locale } = useT();
	const text = copy[locale];
	const id = useId();
	const data = plotData(proposal);
	const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	const axisNumbers = new Intl.NumberFormat(locale, {
		maximumSignificantDigits: 3,
	});
	const bitrate = (value: number) => numbers.format(value / 1000);
	const rangeText = (minimum: number, maximum: number) =>
		`${bitrate(minimum)}–${bitrate(maximum)}`;
	const scale = data ? perTitlePlotAxis(axis ?? data) : null;
	return (
		<figure aria-labelledby={`${id}-title`} className="space-y-2">
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
				<span id={`${id}-title`} className="font-medium text-zinc-200">
					{text.title}
				</span>
				{data?.candidates ? (
					<span className="text-zinc-400">
						{text.candidates(data.candidates)}
					</span>
				) : null}
			</figcaption>
			{data && scale ? (
				<>
					<div
						role="img"
						aria-labelledby={`${id}-title`}
						aria-describedby={`${id}-axis ${id}-description`}
						title={text.description}
						className="space-y-2"
					>
						<div
							data-testid="per-title-ladder-axis"
							className="ml-14 text-xs text-zinc-400"
						>
							<div id={`${id}-axis`} className="text-right">
								{text.axis}
							</div>
							<div className="relative h-6 border-b border-zinc-700">
								{scale.ticks.map((tick) => {
									const percent = scale.position(tick);
									return (
										<span
											key={tick}
											className={`absolute top-0 tabular-nums ${percent === 0 ? "" : percent === 100 ? "-translate-x-full" : "-translate-x-1/2"}`}
											style={{ left: `${percent}%` }}
										>
											{axisNumbers.format(tick / 1000)}
										</span>
									);
								})}
							</div>
						</div>
						{data.rows.map((row, index) => (
							<div
								key={`${row.id}-${index}`}
								className="grid grid-cols-[3rem_minmax(0,1fr)] items-end gap-x-2 text-xs"
							>
								<span className="pb-1 text-zinc-300 tabular-nums">
									{row.height} px
								</span>
								<div className="min-w-0">
									<div className="flex flex-wrap justify-end gap-x-2 text-zinc-300 tabular-nums">
										<span>{rangeText(row.minimum, row.maximum)}</span>
										{row.auto ? (
											<span className="text-zinc-400">{text.auto}</span>
										) : null}
										{row.minimum < scale.minimum ||
										row.maximum > scale.maximum ? (
											<span className="text-amber-300">
												{row.minimum < scale.minimum ? "← " : ""}
												{text.overflow}
												{row.maximum > scale.maximum ? " →" : ""}
											</span>
										) : null}
									</div>
									<svg
										viewBox="0 0 100 12"
										preserveAspectRatio="none"
										aria-hidden="true"
										focusable="false"
										className="h-3 w-full overflow-visible"
									>
										<line
											x1={0}
											x2={100}
											y1={6}
											y2={6}
											className="stroke-zinc-800"
											strokeWidth={1}
											vectorEffect="non-scaling-stroke"
										/>
										<line
											data-testid="per-title-ladder-range"
											x1={scale.position(row.minimum)}
											x2={scale.position(row.maximum)}
											y1={6}
											y2={6}
											className={
												row.auto ? "stroke-zinc-400" : "stroke-emerald-400"
											}
											strokeWidth={row.auto ? 2 : 4}
											strokeDasharray={row.auto ? "4 3" : undefined}
											vectorEffect="non-scaling-stroke"
										/>
										{!row.auto
											? [row.minimum, row.maximum].map((value, endpoint) => (
													<line
														key={endpoint === 0 ? "minimum" : "maximum"}
														x1={scale.position(value)}
														x2={scale.position(value)}
														y1={2}
														y2={10}
														className="stroke-emerald-400"
														strokeWidth={1}
														vectorEffect="non-scaling-stroke"
													/>
												))
											: null}
									</svg>
								</div>
							</div>
						))}
						{!data.rows.length ? (
							<p className="text-xs text-zinc-400">{text.empty}</p>
						) : null}
					</div>
					<p id={`${id}-description`} className="sr-only">
						{text.description}
					</p>
					{data.rows.length ? (
						<table aria-label={text.data} className="sr-only">
							<thead>
								<tr>
									<th scope="col">{text.height}</th>
									<th scope="col">{text.range}</th>
								</tr>
							</thead>
							<tbody>
								{data.rows.map((row, index) => (
									<tr key={`${row.id}-${index}`}>
										<th scope="row">{row.height}</th>
										<td>
											{rangeText(row.minimum, row.maximum)}
											{row.auto ? ` ${text.auto}` : ""}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					) : null}
				</>
			) : (
				<p role="status" className="text-xs text-zinc-400">
					{text.invalid}
				</p>
			)}
		</figure>
	);
}
