"use client";

import {
	CartesianGrid,
	Cell,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
	ZAxis,
} from "recharts";
import { useT } from "@/lib/i18n/context";
import {
	renditionColor,
	renditionLabel,
	VMAF_AXIS_MAX,
	type VmafResultDetail,
} from "../vmaf-shared";

type LadderPoint = {
	x: number;
	mean: number;
	label: string;
	color: string;
	axis: "bitrate" | "height";
};

/**
 * Quality-vs-bitrate ladder: one point per rendition, x = bitrate (kbps) when
 * present else height, y = mean VMAF. Reads the classic encoding-ladder shape
 * (diminishing VMAF gains as bitrate climbs) at a glance; points are coloured
 * to match the time-series lines and pooled table. Renditions missing both
 * bitrate and height are dropped (nothing to place on x).
 */
export function LadderScatter({ results }: { results: VmafResultDetail[] }) {
	const { t } = useT();
	const points: LadderPoint[] = [];
	let useBitrate = false;
	results.forEach((r, i) => {
		const ref = r.renditionRef;
		if (typeof ref.bitrate === "number") {
			useBitrate = true;
			points.push({
				x: Math.round(ref.bitrate / 1000),
				mean: r.pooled.mean,
				label: renditionLabel(ref, i),
				color: renditionColor(i),
				axis: "bitrate",
			});
		} else if (typeof ref.height === "number") {
			points.push({
				x: ref.height,
				mean: r.pooled.mean,
				label: renditionLabel(ref, i),
				color: renditionColor(i),
				axis: "height",
			});
		}
	});

	if (points.length === 0) {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("prose.noLadderMetadata")}
			</p>
		);
	}

	// Sort ascending on x so the connecting line traces the rate-distortion
	// CURVE left→right (low→high bitrate) instead of zig-zagging in rendition
	// order — that curve (diminishing VMAF gains as bitrate climbs) is the point.
	points.sort((a, b) => a.x - b.x);

	const xLabel = t(
		useBitrate ? "uiX.bitrateAxisWithUnit" : "uiX.heightAxisWithUnit",
	);
	// Recharts shows `name` in the tooltip AND the formatter compares against it, so it
	// has to be one value used twice — translating only the display half would silently
	// drop the one-decimal formatting.
	const meanVmafName = t("qc.meanVmafSeries");

	return (
		<div className="mt-2 h-72 w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2">
			<ResponsiveContainer
				width="100%"
				height="100%"
				initialDimension={{ width: 0, height: 270 }}
			>
				<ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
					<CartesianGrid stroke="var(--color-zinc-800)" strokeDasharray="3 3" />
					<XAxis
						type="number"
						dataKey="x"
						name={xLabel}
						stroke="var(--color-zinc-600)"
						tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
						tickLine={false}
						domain={["dataMin", "dataMax"]}
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
						name={meanVmafName}
						domain={[0, VMAF_AXIS_MAX]}
						stroke="var(--color-zinc-600)"
						tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
						tickLine={false}
						width={36}
					/>
					<ZAxis range={[80, 80]} />
					<Tooltip
						cursor={{ stroke: "var(--color-zinc-700)" }}
						contentStyle={{
							background: "var(--color-zinc-900)",
							border: "1px solid var(--color-zinc-700)",
							borderRadius: 6,
							fontSize: 12,
						}}
						labelStyle={{ color: "var(--color-zinc-200)" }}
						formatter={(value, name) => [
							name === meanVmafName && typeof value === "number"
								? value.toFixed(1)
								: value,
							name,
						]}
					/>
					<Scatter
						data={points}
						isAnimationActive={false}
						// Connect the points into the rate-distortion curve. A neutral
						// joining line keeps the per-rendition point colours readable.
						line={{ stroke: "var(--color-zinc-600)", strokeWidth: 1.5 }}
						lineJointType="monotoneX"
					>
						{points.map((p) => (
							<Cell key={p.label} fill={p.color} />
						))}
					</Scatter>
				</ScatterChart>
			</ResponsiveContainer>
		</div>
	);
}
