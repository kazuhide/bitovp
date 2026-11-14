"use client";

import type { ReactNode } from "react";
import { useT } from "@/lib/i18n/context";
import {
	renditionLabel,
	sortedRenditions,
	type VmafResultDetail,
} from "../vmaf-shared";
import { FrameChart } from "./frame-chart";
import { MeasuredMediaComparison } from "./measured-media-comparison";

/** VMAF keeps its measured reference FPS and frame-index chart semantics. */
export function FrameComparison({
	results,
	fps,
	mode,
	initialIds,
	labels,
	unavailableReason,
	renderChart,
}: {
	results: VmafResultDetail[];
	fps?: number;
	mode: "VOD" | "LIVE";
	initialIds?: [string, string];
	labels?: Readonly<Record<string, string>>;
	unavailableReason?: string;
	renderChart?: (selection: {
		selectedFrame?: number;
		onFrameSelect: (frame: number) => void;
	}) => ReactNode;
}) {
	const { t } = useT();
	const candidates = sortedRenditions(results).flatMap(({ result, index }) =>
		result.preview && "url" in result.preview
			? [
					{
						id: result.id,
						url: result.preview.url,
						label:
							labels?.[result.id] ?? renditionLabel(result.renditionRef, index),
					},
				]
			: [],
	);
	const max = results.reduce(
		(m, result) =>
			result.frames.reduce((n, point) => Math.max(n, point.frameNum), m),
		0,
	);
	const clock =
		mode === "VOD" && typeof fps === "number" && Number.isFinite(fps) && fps > 0
			? { kind: "frame" as const, fps, max }
			: null;
	const scope = JSON.stringify([candidates, clock, initialIds]);
	return (
		<MeasuredMediaComparison
			key={scope}
			candidates={candidates}
			clock={clock}
			metric="VMAF"
			initialIds={initialIds}
			unavailableReason={
				unavailableReason ??
				t(
					mode === "LIVE"
						? "qc.previewLiveUnavailable"
						: "qc.previewUnavailable",
				)
			}
			scoreAt={(id, frame) =>
				results
					.find((result) => result.id === id)
					?.frames.find((point) => point.frameNum === frame)?.vmaf
			}
			renderChart={({ selectedPosition, onPositionSelect }) => {
				const selection = {
					selectedFrame: selectedPosition,
					onFrameSelect: onPositionSelect,
				};
				return renderChart ? (
					renderChart(selection)
				) : (
					<FrameChart results={results} {...selection} />
				);
			}}
		/>
	);
}
