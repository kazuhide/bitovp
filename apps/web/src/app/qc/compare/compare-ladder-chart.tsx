"use client";

import { useMemo } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { DetailPopover } from "@/components/ui/detail-popover";
import { useT } from "@/lib/i18n/context";
import { fmtScore, VMAF_AXIS_MAX } from "../vmaf-shared";
import type { CompareSeries } from "./compare-client";

/** One ladder point: x (bitrate kbps or height px) → mean VMAF, per series. */
type LadderPoint = { x: number; mean: number; label: string };

/** A job's rate-distortion curve: its colour, label and ascending points. */
type JobCurve = {
	jobId: string;
	label: string;
	color: string;
	points: LadderPoint[];
};

/**
 * Quality-ladder overlay: ONE rate-distortion curve per report (its selected
 * renditions), x = bitrate (kbps) when present else height, y = pooled mean
 * VMAF. Points within a curve are sorted ascending on x and joined with a line
 * so each curve reads as the classic encoding-ladder shape (diminishing VMAF
 * gains as bitrate climbs); each report gets a distinct colour with a legend.
 * Renditions missing both bitrate and height are dropped (nothing to place on
 * x), mirroring the single-report ladder.
 *
 * Mixing kbps and px on one numeric axis would be misleading, so the axis is
 * chosen ONCE for the whole chart: bitrate if ANY selected series has one, else
 * height. Series lacking the chosen dimension are dropped (and disclosed).
 */
export function CompareLadderChart({ series }: { series: CompareSeries[] }) {
	const { t } = useT();
	const { curves, useBitrate, dropped } = useMemo(() => {
		// Axis mode: prefer bitrate when any series carries one.
		const anyBitrate = series.some(
			(s) => typeof s.result.renditionRef.bitrate === "number",
		);
		const byJob = new Map<string, JobCurve>();
		// NAMES, not a count: a chart that silently drops a rung misrepresents
		// the ladder, and "2 omitted" does not say WHICH comparison is missing
		// (ux inventory #11).
		const dropped: string[] = [];
		for (const s of series) {
			const ref = s.result.renditionRef;
			let x: number | null = null;
			if (anyBitrate) {
				x =
					typeof ref.bitrate === "number"
						? Math.round(ref.bitrate / 1000)
						: null;
			} else if (typeof ref.height === "number") {
				x = ref.height;
			}
			if (x === null) {
				// s.label is ALREADY fully qualified (jobLabel · rendition) — review I1.
				dropped.push(s.label);
				continue;
			}
			let curve = byJob.get(s.jobId);
			if (!curve) {
				curve = {
					jobId: s.jobId,
					// Group label = the job's short label; colour the curve by the
					// FIRST series of the job so curve colour is stable per report.
					label: s.jobLabel,
					color: s.color,
					points: [],
				};
				byJob.set(s.jobId, curve);
			}
			curve.points.push({ x, mean: s.result.pooled.mean, label: s.label });
		}
		// Sort each curve ascending on x so the line traces low→high, not zig-zag.
		const list = [...byJob.values()].filter((c) => c.points.length > 0);
		for (const c of list) {
			c.points.sort((a, b) => a.x - b.x);
		}
		return { curves: list, useBitrate: anyBitrate, dropped };
	}, [series]);

	if (series.length === 0) {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("qc.noSeriesLadder")}</p>
		);
	}
	if (curves.length === 0) {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("prose.noLadderMetadataSelected")}
			</p>
		);
	}

	// The axis caption is copy: line ~175 of this file already translates the same two
	// words via `uiX.bitrateAxis`/`heightAxis`, so this site was the only English one.
	const xLabel = t(
		useBitrate ? "uiX.bitrateAxisWithUnit" : "uiX.heightAxisWithUnit",
	);

	return (
		<>
			<div className="mt-2 h-72 w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2">
				<ResponsiveContainer
					width="100%"
					height="100%"
					initialDimension={{ width: 0, height: 270 }}
				>
					<LineChart margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
						<CartesianGrid
							stroke="var(--color-zinc-800)"
							strokeDasharray="3 3"
						/>
						<XAxis
							type="number"
							dataKey="x"
							name={xLabel}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							domain={["dataMin", "dataMax"]}
							allowDuplicatedCategory={false}
							label={{
								value: xLabel,
								position: "insideBottom",
								offset: -8,
								fill: "var(--color-zinc-600)",
								fontSize: 11,
							}}
						/>
						<YAxis
							type="number"
							dataKey="mean"
							name="mean VMAF"
							domain={[0, VMAF_AXIS_MAX]}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							width={36}
						/>
						<Tooltip
							cursor={{ stroke: "var(--color-zinc-700)" }}
							contentStyle={{
								background: "var(--color-zinc-900)",
								border: "1px solid var(--color-zinc-700)",
								borderRadius: 6,
								fontSize: 12,
							}}
							labelStyle={{ color: "var(--color-zinc-200)" }}
							labelFormatter={(v) => `${v} ${useBitrate ? "kbps" : "px"}`}
							formatter={(value, name) => [
								typeof value === "number" ? fmtScore(value) : value,
								name,
							]}
						/>
						{curves.map((c) => (
							<Line
								key={c.jobId}
								type="monotone"
								data={c.points}
								dataKey="mean"
								name={c.label}
								stroke={c.color}
								strokeWidth={1.5}
								dot={{ r: 3, fill: c.color, strokeWidth: 0 }}
								activeDot={{ r: 4 }}
								isAnimationActive={false}
							/>
						))}
					</LineChart>
				</ResponsiveContainer>
			</div>
			{dropped.length > 0 ? (
				<p className="mt-1 text-xs text-zinc-600">
					<DetailPopover
						summary={t(
							dropped.length === 1
								? "uiX.renditionsOmittedOne"
								: "uiX.renditionsOmittedOther",
							{
								count: dropped.length,
								axis: t(useBitrate ? "uiX.bitrateAxis" : "uiX.heightAxis"),
							},
						)}
						label={t("uiX.renditionsOmittedLabel")}
					>
						<ul className="space-y-1">
							{dropped.map((name, index) => (
								<li key={`${index}:${name}`} className="text-zinc-200">
									{name}
								</li>
							))}
						</ul>
					</DetailPopover>
				</p>
			) : null}
		</>
	);
}
