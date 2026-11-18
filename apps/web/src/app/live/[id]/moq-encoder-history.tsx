"use client";

import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useT } from "@/lib/i18n/context";
import type { MoqHeartbeatHistory } from "@/lib/moq-player/heartbeat";
import { moqHeartbeatSeries } from "@/lib/moq-player/heartbeat-series";

const clock = (value: number) =>
	Number.isFinite(value) ? new Date(value).toISOString().slice(11, 19) : "—";
const colors = [
	"var(--color-emerald-400)",
	"var(--color-sky-400)",
	"var(--color-amber-400)",
	"var(--color-rose-400)",
] as const;

export function MoqEncoderHistory({
	heartbeat,
}: {
	heartbeat: MoqHeartbeatHistory;
}) {
	const { t } = useT();
	const series = moqHeartbeatSeries(heartbeat.points),
		latest = heartbeat.points.at(-1);
	const charts = [
		{
			title: t("moqEncoder.inputBitrate"),
			unit: "Mbps",
			lines: [
				{ field: "videoMbps", label: t("moqEncoder.video") },
				{ field: "audioMbps", label: t("moqEncoder.audio") },
			],
		},
		{
			title: t("moqEncoder.videoFps"),
			unit: "fps",
			lines: [{ field: "videoFps", label: t("moqEncoder.video") }],
		},
		{
			title: t("moqEncoder.segmentProcessing"),
			unit: "ms",
			lines: [
				{ field: "segmentProcessingMeanMs", label: t("moqEncoder.mean") },
				{ field: "segmentProcessingMinMs", label: t("moqEncoder.min") },
				{ field: "segmentProcessingMaxMs", label: t("moqEncoder.max") },
			],
		},
		{
			title: t("moqEncoder.inputPackets"),
			unit: "",
			lines: [
				{ field: "droppedPacketsVideo", label: t("moqEncoder.droppedVideo") },
				{ field: "droppedPacketsAudio", label: t("moqEncoder.droppedAudio") },
				{ field: "corruptPacketsVideo", label: t("moqEncoder.corruptVideo") },
				{ field: "corruptPacketsAudio", label: t("moqEncoder.corruptAudio") },
			],
		},
	];
	return (
		<section
			data-moq-encoder-history
			className="space-y-2 border-t border-zinc-800 pt-3"
		>
			<h4 className="font-medium text-sm text-zinc-200">
				{t("moqEncoder.title")}
			</h4>
			<p className="text-xs text-zinc-500">{t("moqEncoder.source")}</p>
			{!latest ? (
				<p className="text-xs text-zinc-500">{t("moqEncoder.empty")}</p>
			) : (
				<>
					<p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
						<time dateTime={latest.observedAt}>{latest.observedAt}</time>
						<span>{latest.ingestStatus ?? "—"}</span>
						<span>
							{t("moqEncoder.healthy")}:{" "}
							{latest.ingestHealthy === null
								? "—"
								: latest.ingestHealthy
									? t("moqEncoder.yes")
									: t("moqEncoder.no")}
						</span>
					</p>
					<div className="grid gap-3 @3xl:grid-cols-2">
						{charts.map(({ title, unit, lines }) => (
							<figure key={title} className="min-w-0">
								<figcaption className="mb-1 text-xs text-zinc-400">
									{title}
									{unit ? ` (${unit})` : ""}
								</figcaption>
								<div className="h-36 w-full">
									{lines.some((line) =>
										series.some(
											(point) =>
												typeof Reflect.get(point, line.field) === "number",
										),
									) ? (
										<ResponsiveContainer width="100%" height="100%">
											<LineChart data={series} accessibilityLayer>
												<CartesianGrid stroke="var(--color-zinc-800)" />
												<XAxis
													dataKey="timestamp"
													type="number"
													domain={["dataMin", "dataMax"]}
													tickFormatter={clock}
													stroke="var(--color-zinc-500)"
													tick={{ fontSize: 10 }}
												/>
												<YAxis
													width={42}
													stroke="var(--color-zinc-500)"
													tick={{ fontSize: 10 }}
												/>
												<Tooltip
													labelFormatter={(value) => clock(Number(value))}
													contentStyle={{
														background: "var(--color-zinc-950)",
														borderColor: "var(--color-zinc-700)",
														color: "var(--color-zinc-200)",
													}}
												/>
												<Legend wrapperStyle={{ fontSize: 10 }} />
												{lines.map((line, index) => (
													<Line
														key={line.field}
														dataKey={line.field}
														name={line.label}
														unit={unit ? ` ${unit}` : ""}
														connectNulls={false}
														dot={false}
														isAnimationActive={false}
														stroke={colors[index]}
													/>
												))}
											</LineChart>
										</ResponsiveContainer>
									) : (
										<p className="flex h-full items-center text-xs text-zinc-500">
											{t("moqPlayback.unmeasured")}
										</p>
									)}
								</div>
							</figure>
						))}
					</div>
					{heartbeat.truncated ? (
						<p className="text-xs text-zinc-500">{t("moqEncoder.truncated")}</p>
					) : null}
				</>
			)}
		</section>
	);
}
