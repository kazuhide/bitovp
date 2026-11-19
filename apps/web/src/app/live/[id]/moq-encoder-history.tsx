"use client";

import { useId, useMemo } from "react";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import type { MoqHeartbeatHistory } from "@/lib/moq-player/heartbeat";
import {
	moqHeartbeatSeries,
	moqOutputSeries,
} from "@/lib/moq-player/heartbeat-series";
import { MoqMetricChart, moqUtcTime } from "./moq-metric-chart";

const green = "var(--color-emerald-400)";
const teal = "var(--color-teal-400)";
const amber = "var(--color-amber-400)";
const red = "var(--color-rose-400)";

export function MoqEncoderHistory({
	heartbeat,
	active = false,
	failed = false,
}: {
	heartbeat: MoqHeartbeatHistory;
	active?: boolean;
	failed?: boolean;
}) {
	const { t } = useT();
	const labelId = useId();
	const series = useMemo(
		() => moqHeartbeatSeries(heartbeat.points),
		[heartbeat.points],
	);
	const output = useMemo(() => moqOutputSeries(heartbeat), [heartbeat]);
	const latest = heartbeat.points.at(-1);
	const hasSecondary = series.some(
		(point) =>
			point.droppedPacketsVideo !== null ||
			point.droppedPacketsAudio !== null ||
			point.corruptPacketsVideo !== null ||
			point.corruptPacketsAudio !== null,
	);
	const title = t("moqEncoder.title");
	const outputHelp = t("moqEncoder.outputHelp");
	const readIssue = heartbeat.pushOutputReadFailed
		? t("moqEncoder.pushReadFailed")
		: null;
	return (
		<section
			aria-labelledby={labelId}
			data-moq-encoder-history
			className="min-w-0 space-y-3 border-t border-zinc-800 pt-3 first:border-t-0 first:pt-0"
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h4 id={labelId} className="font-medium text-sm text-zinc-200">
					{title}
				</h4>
				<InfoHint labelFor={title} text={t("moqEncoder.sourceHelp")} />
				{latest ? (
					<time
						dateTime={latest.observedAt}
						className="ml-auto whitespace-nowrap text-[11px] text-zinc-500 tabular-nums"
					>
						{moqUtcTime(Date.parse(latest.observedAt))} UTC
					</time>
				) : null}
			</div>
			{!latest && failed ? (
				<p className="text-xs text-zinc-400">
					{t("moqPlayback.historyFailed")}
				</p>
			) : null}
			{latest ? (
				<>
					<p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
						<span>
							{t(
								latest.source === "poll"
									? "moqEncoder.poll"
									: "moqEncoder.lastReport",
							)}
						</span>
						{latest.ingestHealthy === false ? (
							<span>{t("moqEncoder.ingestUnhealthy")}</span>
						) : null}
						{latest.ingestStatus && latest.ingestStatus !== "UNKNOWN" ? (
							<span>{t(`moqEncoder.ingest.${latest.ingestStatus}`)}</span>
						) : null}
					</p>
					<MoqMetricChart
						id="inputBitrate"
						label={t("moqEncoder.inputBitrate")}
						points={series}
						lines={[
							{
								field: "videoMbps",
								label: t("moqEncoder.video"),
								color: green,
							},
							{ field: "audioMbps", label: t("moqEncoder.audio"), color: teal },
						]}
						unit="Mbps"
						decimals={2}
					/>
					<MoqMetricChart
						id="inputFps"
						label={t("moqEncoder.videoFps")}
						points={series}
						lines={[
							{
								field: "videoFps",
								label: t("moqEncoder.videoFps"),
								color: green,
							},
						]}
						unit="fps"
					/>
					{hasSecondary ? (
						<details>
							<summary className="cursor-pointer text-xs text-zinc-400">
								{t("moqEncoder.details")}
							</summary>
							<div className="mt-3 space-y-3">
								<MoqMetricChart
									id="inputPackets"
									label={t("moqEncoder.inputPackets")}
									points={series}
									lines={[
										{
											field: "droppedPacketsVideo",
											label: t("moqEncoder.droppedVideo"),
											color: amber,
										},
										{
											field: "droppedPacketsAudio",
											label: t("moqEncoder.droppedAudio"),
											color: teal,
										},
										{
											field: "corruptPacketsVideo",
											label: t("moqEncoder.corruptVideo"),
											color: red,
										},
										{
											field: "corruptPacketsAudio",
											label: t("moqEncoder.corruptAudio"),
											color: green,
										},
									]}
									unit=""
									decimals={0}
								/>
							</div>
						</details>
					) : null}
				</>
			) : null}
			{!failed ? (
				<section
					aria-label={t("moqEncoder.output")}
					className="border-t border-zinc-800 pt-3"
				>
					<MoqMetricChart
						id="segmentProcessing"
						label={t("moqEncoder.segmentProcessing")}
						points={output}
						help={readIssue ? `${outputHelp} ${readIssue}` : outputHelp}
						emptyLabel={
							readIssue ??
							t(active ? "status.awaitingData" : "moqEncoder.empty")
						}
						lines={[
							{
								field: "segmentProcessingMeanMs",
								label: t("moqEncoder.mean"),
								color: green,
							},
							{
								field: "segmentProcessingMinMs",
								label: t("moqEncoder.min"),
								color: teal,
							},
							{
								field: "segmentProcessingMaxMs",
								label: t("moqEncoder.max"),
								color: amber,
							},
						]}
						unit="ms"
						decimals={0}
					/>
				</section>
			) : null}
			{heartbeat.truncated ? (
				<p className="text-xs text-zinc-500">{t("moqEncoder.truncated")}</p>
			) : null}
		</section>
	);
}
