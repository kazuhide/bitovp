import { afterEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import type { BandingJobDetail } from "../vmaf-shared";

const panels = vi.fn();
vi.mock("../[id]/banding-panel", () => ({
	BandingPanels: (props: unknown) => {
		panels(props);
		return null;
	},
}));

import { BandingReportComparison } from "./banding-report-comparison";

afterEach(() => vi.clearAllMocks());

function reports(): BandingJobDetail[] {
	return ["aaaaaaaa", "bbbbbbbb"].map((prefix) => ({
		id: `${prefix}-0000-4000-8000-000000000001`,
		encodingJobId: null,
		encodingName: "same encoding",
		kind: "BANDING",
		detector: "CAMBI",
		model: null,
		mode: "VOD",
		status: "FINISHED",
		reference: null,
		subsample: null,
		scoringVersion: 11,
		error: null,
		totalUnits: 1,
		doneUnits: 1,
		cores: 1,
		threads: 1,
		concurrency: 1,
		createdAt: "2026-11-14T00:00:00Z",
		updatedAt: "2026-11-14T00:00:00Z",
		results: [
			{
				id: "same-result",
				renditionRef: { label: "360p" },
				pooled: {
					banding: {
						mean: 4,
						min: 4,
						max: 4,
						frameCount: 1,
						durationSeconds: 0.08,
					},
				},
				bandingFrames: [
					{
						frameNum: 1001,
						timestampSeconds: 40.08,
						durationSeconds: 0.08,
						cambi: 4,
					},
				],
				bandingPreview: {
					url: `/api/vmaf-jobs/${prefix}/preview?resultId=same-result&metric=banding`,
				},
			},
		],
	}));
}

it("qualifies duplicate result IDs while preserving CAMBI evidence and pinned media without fabricating VMAF", () => {
	const jobs = reports();
	renderLocalized(<BandingReportComparison jobs={jobs} />);
	const props = panels.mock.lastCall?.[0] as {
		results: BandingJobDetail["results"];
		labels: Record<string, string>;
	};
	expect(props.results.map((result) => result.id)).toEqual(
		jobs.map((report) => `${report.id}:same-result`),
	);
	for (const [index, report] of jobs.entries()) {
		const result = props.results[index];
		expect(result?.bandingFrames).toBe(report.results[0]?.bandingFrames);
		expect(result?.bandingPreview).toBe(report.results[0]?.bandingPreview);
		expect(result?.pooled).toBe(report.results[0]?.pooled);
		expect(result).not.toHaveProperty("frames");
		expect(result).not.toHaveProperty("pooled.mean");
		expect(props.labels[`${report.id}:same-result`]).toBe(
			`same encoding · ${report.id.slice(0, 8)} · 360p`,
		);
	}
	expect(props).not.toHaveProperty("fps");
});

it("opens usable renditions from different reports before taking a second rung from the first report", () => {
	const jobs = reports();
	const first = jobs[0];
	const second = jobs[1];
	const rung = first?.results[0];
	if (!first || !second || !rung)
		throw new Error("Two report fixture required");
	first.results.push({ ...rung, id: "another-rung" });
	second.results.unshift({
		...rung,
		id: "unavailable",
		bandingPreview: { unavailableReason: "MISSING_PROVENANCE" },
	});
	renderLocalized(<BandingReportComparison jobs={jobs} />);
	expect(panels.mock.lastCall?.[0]).toHaveProperty("initialIds", [
		`${first.id}:same-result`,
		`${second.id}:same-result`,
	]);
});
