"use client";

import { useT } from "@/lib/i18n/context";
import { FrameComparison } from "../[id]/frame-comparison";
import type { VmafJobDetail } from "../vmaf-shared";
import type { CompareSeries } from "./compare-client";
import { CompareFrameChart } from "./compare-frame-chart";

/** Reuse the report player's media lifecycle; the comparison keeps its own chart. */
export function ReportFrameComparison({
	jobs,
	series,
	shownSeries,
}: {
	jobs: Pick<VmafJobDetail, "id" | "mode" | "reference">[];
	series: CompareSeries[];
	shownSeries: CompareSeries[];
}) {
	const { t } = useT();
	const available = series.filter(
		(item) => item.result.preview && "url" in item.result.preview,
	);
	const reports = available.map((item) =>
		jobs.find((job) => job.id === item.jobId),
	);
	const fps = reports[0]?.reference?.fps;
	const commonClock =
		typeof fps === "number" &&
		Number.isFinite(fps) &&
		fps > 0 &&
		reports.every(
			(job) =>
				job?.mode === "VOD" &&
				job.reference?.fps !== undefined &&
				Math.abs(job.reference.fps - fps) < 0.000001,
		);
	const first = available[0];
	const second =
		available.find((item) => item.jobId !== first?.jobId) ?? available[1];
	const labels = Object.fromEntries(
		series.map((item) => [item.key, item.label]),
	);
	const results = series.map((item) => ({ ...item.result, id: item.key }));
	const scope = JSON.stringify([
		available.map((item) => [item.key, item.result.preview]),
		reports.map((job) => [job?.id, job?.mode, job?.reference?.fps]),
	]);
	return (
		<FrameComparison
			key={scope}
			results={results}
			fps={commonClock ? fps : undefined}
			mode="VOD"
			labels={labels}
			initialIds={[first?.key ?? "", second?.key ?? ""]}
			unavailableReason={
				available.length > 0 && !commonClock
					? t("qc.previewReportsClock")
					: undefined
			}
			renderChart={(selection) => (
				<CompareFrameChart series={shownSeries} {...selection} />
			)}
		/>
	);
}
