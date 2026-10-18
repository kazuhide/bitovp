"use client";

import { useMemo } from "react";
import {
	Brush,
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useT } from "@/lib/i18n/context";
import { VMAF_AXIS_MAX } from "../vmaf-shared";
import type { CompareSeries } from "./compare-client";

/**
 * One x-position (frameNum) carrying each visible series' VMAF under its key.
 * Series are downsampled independently and have different lengths, so the x
 * axis is the union of every series' frame numbers with gaps left undefined —
 * Recharts connects each line across the nulls (connectNulls).
 */
type MergedPoint = { frameNum: number } & Record<string, number | undefined>;

/**
 * Per-frame VMAF overlay across reports: one VMAF line per (job × rendition)
 * series, coloured to match the legend, over the route's downsampled series.
 * Generalises the single-report FrameChart to the comparison case — series come
 * from different jobs and differ in length, which the union axis handles. The
 * left y-axis is locked to 0–100 so every encode is read on the same scale; a
 * Brush gives pan/zoom. VMAF-only (no PSNR overlay) — the comparison is about
 * relative VMAF across encodes.
 */
export function CompareFrameChart({ series }: { series: CompareSeries[] }) {
	const { t } = useT();
	const withFrames = useMemo(
		() => series.filter((s) => s.result.frames.length > 0),
		[series],
	);

	const data = useMemo<MergedPoint[]>(() => {
		const byFrame = new Map<number, MergedPoint>();
		for (const s of withFrames) {
			for (const f of s.result.frames) {
				let point = byFrame.get(f.frameNum);
				if (!point) {
					point = { frameNum: f.frameNum };
					byFrame.set(f.frameNum, point);
				}
				point[s.key] = f.vmaf;
			}
		}
		return [...byFrame.values()].sort((a, b) => a.frameNum - b.frameNum);
	}, [withFrames]);

	if (series.length === 0) {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("qc.noSeriesFrame")}</p>
		);
	}
	if (withFrames.length === 0) {
		return <p className="mt-2 text-sm text-zinc-500">{t("qc.noSeriesData")}</p>;
	}

	// A label lookup so the tooltip/legend show the human series label, not key.
	const labelFor = new Map(withFrames.map((s) => [s.key, s.label]));

	return (
		<div className="mt-2 h-80 w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2">
			<ResponsiveContainer
				width="100%"
				height="100%"
				initialDimension={{ width: 0, height: 302 }}
			>
				<LineChart
					data={data}
					margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
				>
					<CartesianGrid stroke="var(--color-zinc-800)" strokeDasharray="3 3" />
					<XAxis
						dataKey="frameNum"
						type="number"
						domain={["dataMin", "dataMax"]}
						stroke="var(--color-zinc-600)"
						tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
						tickLine={false}
						label={{
							value: "frame",
							position: "insideBottomRight",
							fill: "var(--color-zinc-600)",
							fontSize: 11,
						}}
					/>
					<YAxis
						domain={[0, VMAF_AXIS_MAX]}
						stroke="var(--color-zinc-600)"
						tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
						tickLine={false}
						width={36}
					/>
					<Tooltip
						contentStyle={{
							background: "var(--color-zinc-900)",
							border: "1px solid var(--color-zinc-700)",
							borderRadius: 6,
							fontSize: 12,
						}}
						labelStyle={{ color: "var(--color-zinc-200)" }}
						labelFormatter={(v) => `frame ${v}`}
						formatter={(value, name) => [
							typeof value === "number" ? value.toFixed(1) : value,
							labelFor.get(String(name)) ?? name,
						]}
					/>
					{withFrames.map((s) => (
						<Line
							key={s.key}
							type="monotone"
							dataKey={s.key}
							name={s.key}
							stroke={s.color}
							strokeWidth={1.5}
							dot={false}
							connectNulls
							isAnimationActive={false}
						/>
					))}
					<Brush
						dataKey="frameNum"
						height={20}
						stroke="var(--color-zinc-700)"
						fill="var(--color-zinc-900)"
						travellerWidth={8}
						tickFormatter={(v) => `${v}`}
					/>
				</LineChart>
			</ResponsiveContainer>
		</div>
	);
}
