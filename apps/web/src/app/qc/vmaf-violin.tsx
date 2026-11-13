"use client";

import { useId } from "react";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import { fmtScore, type VmafScoreDistribution } from "./vmaf-shared";
import {
	interpolateScore,
	scoreFraction,
	validVmafDistribution,
	violinDensity,
} from "./vmaf-violin-geometry";

export type VmafViolinSeries = {
	key: string;
	label: string;
	color: string;
	distribution?: VmafScoreDistribution | null;
	subsample?: number | null;
};

const LEFT = 56;
const COLUMN = 128;
const TOP = 16;
const HEIGHT = 248;

/** Scores are measured; only the silhouette is a smoothed histogram estimate. */
export function VmafViolinChart({
	series,
}: {
	series: readonly VmafViolinSeries[];
}) {
	const { t, locale } = useT();
	const titleId = useId();
	const rows = series.map((row) => ({
		...row,
		distribution: validVmafDistribution(row.distribution)
			? row.distribution
			: null,
	}));
	const measured = rows.flatMap((row) =>
		row.distribution ? [row.distribution] : [],
	);
	const min = Math.min(0, ...measured.map((value) => value.min));
	const max = Math.max(100, ...measured.map((value) => value.max));
	const width = LEFT + Math.max(1, rows.length) * COLUMN;
	const y = (score: number) =>
		TOP + HEIGHT * (1 - scoreFraction(score, min, max));
	const countLabel = (row: VmafViolinSeries, count: number) =>
		t(
			row.subsample && row.subsample > 1
				? "qc.violinSampleCount"
				: "qc.violinFrameCount",
			{
				count: count.toLocaleString(locale),
				stride: row.subsample ?? 1,
			},
		);
	return (
		<figure className="space-y-2" aria-labelledby={titleId}>
			<figcaption className="flex items-center gap-2 font-medium text-sm text-zinc-300">
				<span id={titleId}>{t("qc.violinTitle")}</span>
				<InfoHint labelFor={t("qc.violinTitle")} text={t("qc.violinHelp")} />
			</figcaption>
			<div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2">
				<div className="mx-auto" style={{ width, minWidth: width }}>
					{measured.length > 0 && (
						<svg
							viewBox={`0 0 ${width} ${TOP + HEIGHT + 16}`}
							width={width}
							height={TOP + HEIGHT + 16}
							className="block"
							role="img"
							aria-label={t("qc.violinTitle")}
						>
							{Array.from({ length: 6 }, (_, i) => {
								const score = interpolateScore(min, max, i / 5);
								return (
									<g key={i}>
										<line
											x1={LEFT}
											x2={width}
											y1={y(score)}
											y2={y(score)}
											stroke="var(--color-zinc-800)"
											strokeDasharray="3 3"
										/>
										<text
											x={LEFT - 8}
											y={y(score)}
											dominantBaseline="middle"
											textAnchor="end"
											fill="var(--color-zinc-400)"
											fontSize={11}
										>
											{fmtScore(score)}
										</text>
									</g>
								);
							})}
							{rows.map((row, i) => {
								const distribution = row.distribution;
								if (!distribution) return null;
								const x = LEFT + (i + 0.5) * COLUMN;
								const label = `${row.label}: ${countLabel(row, distribution.frameCount)}; ${t("qc.mean")} ${fmtScore(distribution.mean)}, ${t("qc.min")} ${fmtScore(distribution.min)}, ${t("qc.max")} ${fmtScore(distribution.max)}`;
								const density = violinDensity(distribution);
								const coordinates = (side: number) =>
									density.map(
										(point) =>
											`${(x + side * point.density * 40).toFixed(3)},${y(point.score).toFixed(3)}`,
									);
								return (
									<g key={row.key} aria-label={label}>
										<title>{label}</title>
										{distribution.min === distribution.max ? (
											<line
												x1={x - 36}
												x2={x + 36}
												y1={y(distribution.min)}
												y2={y(distribution.max)}
												stroke={row.color}
												strokeWidth={5}
											/>
										) : (
											<path
												data-violin
												d={`M${x},${y(distribution.min)} L${coordinates(-1).join(" L")} L${x},${y(distribution.max)} L${coordinates(1).reverse().join(" L")} Z`}
												fill={row.color}
												fillOpacity={0.35}
												stroke={row.color}
												strokeWidth={1.5}
											/>
										)}
										<line
											x1={x - 12}
											x2={x + 12}
											y1={y(distribution.mean)}
											y2={y(distribution.mean)}
											stroke="var(--color-zinc-100)"
											strokeWidth={2}
										/>
									</g>
								);
							})}
						</svg>
					)}
					<div className="flex pb-1" style={{ paddingLeft: LEFT }}>
						{rows.map((row) => (
							<div
								key={row.key}
								className="w-32 shrink-0 space-y-1 px-2 text-center text-xs"
							>
								<p
									className="break-words font-medium"
									style={{ color: row.color }}
								>
									{row.label}
								</p>
								{row.distribution ? (
									<>
										<p className="break-keep text-zinc-400">
											{countLabel(row, row.distribution.frameCount)}
										</p>
										<p className="text-zinc-200 tabular-nums">
											{t("qc.mean")} {fmtScore(row.distribution.mean)}
										</p>
										<p className="text-zinc-500 tabular-nums">
											{t("qc.min")} {fmtScore(row.distribution.min)} ·{" "}
											{t("qc.max")} {fmtScore(row.distribution.max)}
										</p>
									</>
								) : (
									<p className="text-zinc-500">{t("qc.violinUnavailable")}</p>
								)}
							</div>
						))}
					</div>
				</div>
			</div>
		</figure>
	);
}
