"use client";

import type { ReactNode } from "react";
import { useT } from "@/lib/i18n/context";
import type { BandingResultData, RenditionRef } from "../vmaf-shared";
import { renditionLabel } from "../vmaf-shared";
import { MeasuredMediaComparison } from "./measured-media-comparison";

type Result = BandingResultData & { id: string; renditionRef: RenditionRef };

/** CAMBI's decoded presentation timestamps are independent of reference FPS. */
export function BandingFrameComparison({
	results,
	labels,
	initialIds,
	renderChart,
}: {
	results: Result[];
	labels?: Readonly<Record<string, string>>;
	initialIds?: [string, string];
	renderChart: (selection: {
		selectedTime?: number;
		onTimeSelect: (seconds: number) => void;
	}) => ReactNode;
}) {
	const { t } = useT();
	const candidates = results.flatMap((result, index) =>
		result.bandingPreview && "url" in result.bandingPreview
			? [
					{
						id: result.id,
						url: result.bandingPreview.url,
						label:
							labels?.[result.id] ?? renditionLabel(result.renditionRef, index),
					},
				]
			: [],
	);
	const frames = results.flatMap((result) => result.bandingFrames ?? []);
	const timestamps = [...new Set(frames.map((frame) => frame.timestampSeconds))]
		.filter((seconds) => Number.isFinite(seconds) && seconds >= 0)
		.sort((a, b) => a - b);
	const max = frames.reduce(
		(end, frame) =>
			Math.max(end, frame.timestampSeconds + frame.durationSeconds),
		0,
	);
	const clock =
		Number.isFinite(max) && max > 0
			? { kind: "time" as const, timestamps, max }
			: null;
	// A different retained object or measurement clock must release the old decoders.
	const scope = JSON.stringify([candidates, clock, initialIds]);
	return (
		<MeasuredMediaComparison
			key={scope}
			candidates={candidates}
			clock={clock}
			metric="CAMBI"
			initialIds={initialIds}
			unavailableReason={t("banding.previewUnavailable")}
			scoreAt={(id, seconds) =>
				results
					.find((result) => result.id === id)
					?.bandingFrames?.find(
						(frame) =>
							seconds >= frame.timestampSeconds &&
							seconds < frame.timestampSeconds + frame.durationSeconds,
					)?.cambi
			}
			renderChart={({ selectedPosition, onPositionSelect }) =>
				renderChart({
					selectedTime: selectedPosition,
					onTimeSelect: onPositionSelect,
				})
			}
		/>
	);
}
