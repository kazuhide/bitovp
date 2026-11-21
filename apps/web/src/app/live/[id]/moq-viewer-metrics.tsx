"use client";

import { useId, useMemo } from "react";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import {
	type MoqMetricSample,
	moqViewerMetricSeries,
} from "@/lib/moq-player/metric-series";
import { MoqMetricChart } from "./moq-metric-chart";

const blue = "var(--color-sky-400)";
const violet = "var(--color-violet-400)";
const grey = "var(--color-zinc-400)";

export function MoqViewerMetrics({
	samples,
	startedAt,
	playhead,
	live = false,
}: {
	samples: readonly MoqMetricSample[];
	startedAt: string;
	playhead?: number | null;
	live?: boolean;
}) {
	const { t } = useT();
	const labelId = useId();
	const points = useMemo(
		() => moqViewerMetricSeries(samples, startedAt),
		[samples, startedAt],
	);
	const hasLatency = points.some((point) => point.latencyMs !== null);
	const hasCanvas = points.some((point) => point.canvasUpdates !== null);
	const hasVideo = points.some((point) => point.videoFps !== null);
	const hasLegacy = points.some((point) => point.legacyFrameRate !== null);
	const hasPlayerBuffer = points.some(
		(point) => point.playerBufferSeconds !== null,
	);
	const hasVideoBuffer = points.some(
		(point) => point.videoBufferSeconds !== null,
	);
	const hasLegacyBuffer = points.some(
		(point) => point.legacyBufferSeconds !== null,
	);
	const hasMeasurements =
		hasLatency ||
		hasCanvas ||
		hasVideo ||
		hasLegacy ||
		hasPlayerBuffer ||
		hasVideoBuffer ||
		hasLegacyBuffer;
	const singleCanvas = hasCanvas && !hasVideo && !hasLegacy;
	const singleVideo = hasVideo && !hasCanvas && !hasLegacy;
	const label = t("moqPlayback.viewerMetrics");
	return (
		<section
			aria-labelledby={labelId}
			data-moq-viewer-metrics
			className="min-w-0 space-y-3 border-t border-zinc-800 pt-3 first:border-t-0 first:pt-0"
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h4 id={labelId} className="font-medium text-sm text-zinc-200">
					{label}
				</h4>
				<InfoHint labelFor={label} text={t("moqPlayback.historyClock")} />
				{hasMeasurements ? (
					<span className="ml-auto text-[11px] text-zinc-500">UTC</span>
				) : null}
			</div>
			{hasMeasurements ? (
				<>
					<MoqMetricChart
						id="latencyMs"
						label={t("moqPlayback.latency")}
						points={points}
						lines={[
							{
								field: "latencyMs",
								label: t("moqPlayback.latency"),
								color: blue,
							},
						]}
						unit="ms"
						decimals={0}
						help={t("moqPlayback.latencyMethod")}
						playhead={playhead}
					/>
					<MoqMetricChart
						id="bufferSeconds"
						label={t(
							hasPlayerBuffer && !hasVideoBuffer && !hasLegacyBuffer
								? "moqPlayback.bufferPlayer"
								: hasVideoBuffer && !hasPlayerBuffer && !hasLegacyBuffer
									? "moqPlayback.bufferVideo"
									: "moqPlayback.bufferHistory",
						)}
						points={points}
						lines={[
							{
								field: "playerBufferSeconds",
								label: t("moqPlayback.bufferPlayer"),
								color: blue,
							},
							{
								field: "videoBufferSeconds",
								label: t("moqPlayback.bufferVideo"),
								color: violet,
							},
							{
								field: "legacyBufferSeconds",
								label: t("moqPlayback.bufferHistory"),
								color: grey,
							},
						]}
						unit="s"
						decimals={2}
						help={t("moqPlayback.bufferMeasurement")}
						playhead={playhead}
					/>
					<MoqMetricChart
						id="fps"
						label={t(
							singleCanvas
								? "moqPlayback.canvasUpdates"
								: singleVideo
									? "moqPlayback.fps"
									: "moqPlayback.frameHistory",
						)}
						points={points}
						lines={[
							{ field: "videoFps", label: t("moqPlayback.fps"), color: blue },
							{
								field: "canvasUpdates",
								label: t("moqPlayback.canvasUpdates"),
								color: violet,
							},
							{
								field: "legacyFrameRate",
								label: t("moqPlayback.frameHistory"),
								color: grey,
							},
						]}
						unit={singleVideo ? "fps" : "/s"}
						help={t(
							singleCanvas
								? "moqPlayback.canvasMeasurement"
								: "moqPlayback.frameHistoryMeasurement",
						)}
						playhead={playhead}
					/>
				</>
			) : (
				<p className="text-xs text-zinc-500">
					{t(live ? "moqPlayback.noLiveSamples" : "moqPlayback.noSamples")}
				</p>
			)}
		</section>
	);
}
