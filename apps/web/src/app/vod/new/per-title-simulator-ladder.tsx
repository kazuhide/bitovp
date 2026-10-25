"use client";

import type { PerTitleProposal } from "@bitovp/core";
import { useId } from "react";
import { useT } from "@/lib/i18n/context";
import { perTitleStreamLabel } from "./per-title-stream-mode";

const copy = {
	en: {
		title: "Allowed bitrate ranges",
		data: "Allowed bitrate ranges (data)",
		axis: "kbps (log scale)",
		description:
			"Specified bitrate limits, not encoding results. Stream templates do not guarantee an output count.",
		height: "Height (px)",
		range: "Range (kbps)",
		mode: "Stream mode",
		unspecified: "Not specified",
		globalRange: (range: string) => `Not specified; overall limits ${range}`,
		analysis: "Not specified (content analysis)",
		candidates: (count: number) => `Stream templates: ${count}`,
		empty: "No Stream templates",
		invalid: "Ranges unavailable",
		overflow: "Outside scale",
	},
	ja: {
		title: "許容ビットレート範囲",
		data: "許容ビットレート範囲（データ）",
		axis: "kbps（対数目盛）",
		description:
			"設定した許容範囲で、エンコード結果ではありません。Streamテンプレート数は出力本数を保証しません。",
		height: "高さ (px)",
		range: "範囲 (kbps)",
		mode: "Streamモード",
		unspecified: "未指定",
		globalRange: (range: string) => `未指定（全体の制約 ${range}）`,
		analysis: "未指定（素材解析で決定）",
		candidates: (count: number) => `Streamテンプレート: ${count}`,
		empty: "Streamテンプレートがありません",
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

type PlotRow = {
	stream: PerTitleProposal["api"]["streams"][number];
	bounds: PerTitleChartAxis | null;
	fixedBand: boolean;
};

function plotData(proposal: PerTitleProposal) {
	const { minBitrate: minimum, maxBitrate: maximum } = proposal.api.global;
	const positive = (value: number | undefined): value is number =>
		value !== undefined && Number.isSafeInteger(value) && value > 0;
	if (!positive(minimum) || !positive(maximum) || maximum < minimum)
		return null;
	const rows: PlotRow[] = [];
	for (const stream of proposal.api.streams) {
		if (
			![
				"PER_TITLE_TEMPLATE",
				"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
				"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			].includes(stream.mode) ||
			(stream.height !== undefined && !positive(stream.height)) ||
			(stream.width !== undefined && !positive(stream.width)) ||
			(stream.mode !== "PER_TITLE_TEMPLATE" &&
				!positive(stream.height) &&
				!positive(stream.width))
		)
			return null;
		const fixedBand =
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
		let bounds: PerTitleChartAxis | null =
			stream.mode === "PER_TITLE_TEMPLATE" ? null : { minimum, maximum };
		if (fixedBand) {
			const lower = stream.perTitleSettings?.minBitrate;
			const upper = stream.perTitleSettings?.maxBitrate;
			if (
				!positive(lower) ||
				!positive(upper) ||
				lower > upper ||
				lower < minimum ||
				upper > maximum
			)
				return null;
			bounds = { minimum: lower, maximum: upper };
		}
		rows.push({ stream, bounds, fixedBand });
	}
	return { minimum, maximum, rows };
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
	const rangeText = (bounds: PerTitleChartAxis) =>
		`${bitrate(bounds.minimum)}–${bitrate(bounds.maximum)}`;
	const dimension = (stream: PlotRow["stream"], unit: boolean) =>
		stream.height !== undefined
			? `${stream.height}${unit ? " px" : ""}`
			: stream.width !== undefined
				? `${stream.width} px (${locale === "ja" ? "幅" : "width"})`
				: text.unspecified;
	const rangeLabel = (row: PlotRow) =>
		row.bounds
			? row.fixedBand
				? rangeText(row.bounds)
				: text.globalRange(rangeText(row.bounds))
			: text.analysis;
	const scale = data ? perTitlePlotAxis(axis ?? data) : null;
	return (
		<figure aria-labelledby={`${id}-title`} className="space-y-2">
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
				<span id={`${id}-title`} className="font-medium text-zinc-200">
					{text.title}
				</span>
				{data?.rows.length ? (
					<span className="text-zinc-400">
						{text.candidates(data.rows.length)}
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
						className="space-y-3"
					>
						<div
							data-testid="per-title-ladder-axis"
							className="text-xs text-zinc-400"
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
						{data.rows.map((row, index) => {
							const { stream, bounds, fixedBand } = row;
							return (
								<div
									key={`${stream.rowId}-${index}`}
									data-testid="per-title-ladder-row"
									className="min-w-0 space-y-1 text-xs"
								>
									<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-zinc-300">
										<span className="tabular-nums">
											{dimension(stream, true)}
										</span>
										<code className="min-w-0 break-all text-[10px] text-zinc-400">
											{perTitleStreamLabel(stream, locale)}
										</code>
									</div>
									<div className="flex flex-wrap justify-end gap-x-2 text-zinc-300 tabular-nums">
										<span>{rangeLabel(row)}</span>
										{bounds &&
										(bounds.minimum < scale.minimum ||
											bounds.maximum > scale.maximum) ? (
											<span className="text-amber-300">
												{bounds.minimum < scale.minimum ? "← " : ""}
												{text.overflow}
												{bounds.maximum > scale.maximum ? " →" : ""}
											</span>
										) : null}
									</div>
									{bounds ? (
										<svg
											aria-hidden="true"
											viewBox="0 0 100 12"
											preserveAspectRatio="none"
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
												x1={scale.position(bounds.minimum)}
												x2={scale.position(bounds.maximum)}
												y1={6}
												y2={6}
												className={
													fixedBand ? "stroke-emerald-400" : "stroke-zinc-400"
												}
												strokeWidth={fixedBand ? 4 : 2}
												strokeDasharray={fixedBand ? undefined : "4 3"}
												vectorEffect="non-scaling-stroke"
											/>
											{fixedBand
												? [bounds.minimum, bounds.maximum].map(
														(value, endpoint) => (
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
														),
													)
												: null}
										</svg>
									) : null}
								</div>
							);
						})}
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
									<th scope="col">{text.mode}</th>
									<th scope="col">{text.range}</th>
								</tr>
							</thead>
							<tbody>
								{data.rows.map((row, index) => (
									<tr key={`${row.stream.rowId}-${index}`}>
										<th scope="row">{dimension(row.stream, false)}</th>
										<td>{perTitleStreamLabel(row.stream, locale)}</td>
										<td>{rangeLabel(row)}</td>
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
