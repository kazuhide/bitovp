"use client";

import { useT } from "@/lib/i18n/context";
import { BandingPanels } from "../[id]/banding-panel";
import {
	type BandingJobDetail,
	type BandingResultData,
	renditionLabel,
	shortJobId,
} from "../vmaf-shared";

/** Prefer a cross-report pair; unavailable pinned media never becomes a default. */
export function bandingComparisonInitialIds(
	items: readonly {
		id: string;
		reportId: string;
		preview?: BandingResultData["bandingPreview"];
	}[],
): [string, string] {
	const available = items.filter(
		(item) => item.preview && "url" in item.preview,
	);
	const first = available[0];
	const second =
		available.find((item) => item.reportId !== first?.reportId) ?? available[1];
	return [first?.id ?? "", second?.id ?? ""];
}

/** Keep native CAMBI timestamps and media URLs; qualify only UI result IDs. */
export function BandingReportComparison({
	jobs,
}: {
	jobs: BandingJobDetail[];
}) {
	const { t } = useT();
	const counts = new Map<string, number>();
	for (const job of jobs) {
		const name = job.encodingName ?? shortJobId(job.id);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const labels: Record<string, string> = {};
	const results = jobs.flatMap((job) => {
		const name = job.encodingName ?? shortJobId(job.id);
		const reportLabel =
			(counts.get(name) ?? 0) > 1 ? `${name} · ${shortJobId(job.id)}` : name;
		return job.results.map((result, index) => {
			const id = `${job.id}:${result.id}`;
			labels[id] =
				`${reportLabel} · ${renditionLabel(result.renditionRef, index, t("common.renditionNumbered", { n: index + 1 }))}`;
			return { ...result, id };
		});
	});
	return (
		<BandingPanels
			results={results}
			labels={labels}
			initialIds={bandingComparisonInitialIds(
				jobs.flatMap((job) =>
					job.results.map((result) => ({
						id: `${job.id}:${result.id}`,
						reportId: job.id,
						preview: result.bandingPreview,
					})),
				),
			)}
		/>
	);
}
