"use client";

import {
	CartesianGrid,
	type DotItemDotProps,
	Line,
	LineChart,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { InfoHint } from "@/components/ui/info-hint";

type TimedPoint = { timestamp: number };
type Measurement<T> = {
	field: Extract<keyof T, string>;
	label: string;
	color: string;
};
type Props<T extends TimedPoint> = {
	id: string;
	label: string;
	points: T[];
	lines: readonly Measurement<T>[];
	unit: string;
	decimals?: number;
	help?: string;
	playhead?: number | null;
};

export function moqUtcTime(timestamp: number) {
	const time = new Date(timestamp);
	return Number.isFinite(time.getTime())
		? time.toISOString().slice(11, 19)
		: "";
}

function isMeasurement(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function renderIsolatedPoint({
	cx,
	cy,
	index,
	points,
	stroke,
	value,
}: DotItemDotProps) {
	if (
		!isMeasurement(value) ||
		!isMeasurement(cx) ||
		!isMeasurement(cy) ||
		isMeasurement(points[index - 1]?.value) ||
		isMeasurement(points[index + 1]?.value)
	) {
		return null;
	}
	return <circle cx={cx} cy={cy} r={2.5} fill={stroke} />;
}

export function MoqMetricChart<T extends TimedPoint>({
	id,
	label,
	points,
	lines,
	unit,
	decimals = 1,
	help,
	playhead,
}: Props<T>) {
	const measurements = lines.flatMap((line) => {
		if (!points.some((point) => isMeasurement(point[line.field]))) return [];
		const hasIsolatedPoint = points.some(
			(point, index) =>
				isMeasurement(point[line.field]) &&
				!isMeasurement(points[index - 1]?.[line.field]) &&
				!isMeasurement(points[index + 1]?.[line.field]),
		);
		return [{ ...line, hasIsolatedPoint }];
	});
	if (!measurements.length) return null;

	const first = points[0]?.timestamp;
	const last = points.at(-1)?.timestamp;
	const cursor =
		typeof playhead === "number" &&
		first !== undefined &&
		last !== undefined &&
		first <= playhead &&
		playhead <= last
			? playhead
			: null;
	const readPoint =
		playhead === undefined
			? points.at(-1)
			: cursor === null
				? undefined
				: points.findLast((point) => point.timestamp <= cursor);
	const isSingle = measurements.length === 1;
	return (
		<figure data-moq-chart={id} className="min-w-0 space-y-1.5">
			<figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
				<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-zinc-400">
					<span>{label}</span>
					{help ? <InfoHint labelFor={label} text={help} /> : null}
				</div>
				{measurements.map(({ field, label: name, color }) => {
					const value = readPoint?.[field];
					if (!isMeasurement(value) && isSingle) return null;
					return (
						<span
							key={field}
							className="inline-flex items-center gap-1 text-zinc-300 tabular-nums"
						>
							{isSingle ? null : (
								<>
									<span
										aria-hidden="true"
										className="size-1.5 shrink-0 rounded-full"
										style={{ backgroundColor: color }}
									/>
									<span>{name}</span>
								</>
							)}
							{isMeasurement(value)
								? `${value.toFixed(decimals)} ${unit}`.trim()
								: null}
						</span>
					);
				})}
			</figcaption>
			<div
				className="h-[5.25rem] min-w-0 w-full"
				data-moq-playhead={cursor ?? undefined}
			>
				<ResponsiveContainer width="100%" height="100%" minWidth={0}>
					<LineChart
						data={points}
						accessibilityLayer
						margin={{ top: 4, right: 5, bottom: 0, left: 0 }}
					>
						<CartesianGrid vertical={false} stroke="var(--color-zinc-800)" />
						<XAxis
							dataKey="timestamp"
							type="number"
							domain={["dataMin", "dataMax"]}
							tickFormatter={moqUtcTime}
							stroke="var(--color-zinc-500)"
							tick={{ fontSize: 10 }}
							tickCount={3}
							tickMargin={4}
							height={20}
							tickLine={false}
						/>
						<YAxis
							width={37}
							tickCount={3}
							stroke="var(--color-zinc-500)"
							tick={{ fontSize: 10 }}
							tickFormatter={(value) =>
								String(Number(Number(value).toFixed(decimals)))
							}
							tickLine={false}
							axisLine={false}
						/>
						<Tooltip
							labelFormatter={(value) => `${moqUtcTime(Number(value))} UTC`}
							contentStyle={{
								background: "var(--color-zinc-950)",
								borderColor: "var(--color-zinc-700)",
								color: "var(--color-zinc-200)",
								fontSize: 12,
							}}
						/>
						{cursor === null ? null : (
							<ReferenceLine
								x={cursor}
								stroke="var(--color-zinc-400)"
								strokeDasharray="3 2"
							/>
						)}
						{measurements.map(
							({ field, label: name, color, hasIsolatedPoint }) => (
								<Line
									key={field}
									dataKey={field}
									name={name}
									unit={unit ? ` ${unit}` : ""}
									type="linear"
									connectNulls={false}
									isAnimationActive={false}
									dot={hasIsolatedPoint ? renderIsolatedPoint : false}
									stroke={color}
									strokeWidth={1.75}
								/>
							),
						)}
					</LineChart>
				</ResponsiveContainer>
			</div>
		</figure>
	);
}
