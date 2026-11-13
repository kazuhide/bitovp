import { computePooled } from "@bitovp/core";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { VmafJobDetail } from "../vmaf-shared";
import type { CompareSeries } from "./compare-client";
import { ReportFrameComparison } from "./report-frame-comparison";

vi.mock("./compare-frame-chart", () => ({
	CompareFrameChart: ({
		onFrameSelect,
	}: {
		onFrameSelect: (frame: number) => void;
	}) => (
		<button type="button" onClick={() => onFrameSelect(48)}>
			Chart frame 48
		</button>
	),
}));

const frames = [
	{ frameNum: 0, vmaf: 90 },
	{ frameNum: 240, vmaf: 85 },
];
const jobs: Pick<
	VmafJobDetail,
	"id" | "mode" | "reference" | "encodingName"
>[] = ["H.264", "AV1"].map((name, index) => ({
	id: `job-${index}`,
	mode: "VOD",
	reference: { fps: 24 },
	encodingName: name,
}));
const series: CompareSeries[] = jobs.flatMap((job, jobIndex) =>
	[1, 2].map((rung) => ({
		key: `${job.id}:r${rung}`,
		jobId: job.id,
		jobIndex,
		jobLabel: job.encodingName ?? job.id,
		label: `${job.encodingName} · Rung ${rung}`,
		color: "#00ff00",
		mean: 90,
		result: {
			id: `r${rung}`,
			renditionRef: { bitrate: rung * 1000 },
			frames,
			frameCount: 241,
			pooled: computePooled(frames),
			preview: { url: `/api/vmaf-jobs/${job.id}/preview?resultId=r${rung}` },
		},
	})),
);

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("report comparison preview", () => {
	it("opens different reports by default, labels their renditions, and loads on demand", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		const user = userEvent.setup();
		const { container } = renderWithQuery(
			<ReportFrameComparison
				jobs={jobs}
				series={series}
				shownSeries={series}
			/>,
		);
		expect(container.querySelectorAll("video")).toHaveLength(0);
		await user.click(
			screen.getByRole("button", { name: "Open comparison preview" }),
		);
		expect(screen.getByRole("combobox", { name: "Rendition A" })).toHaveValue(
			"job-0:r1",
		);
		expect(screen.getByRole("combobox", { name: "Rendition B" })).toHaveValue(
			"job-1:r1",
		);
		expect(
			[...container.querySelectorAll("video")].map((v) =>
				v.getAttribute("src"),
			),
		).toEqual([
			"/api/vmaf-jobs/job-0/preview?resultId=r1",
			"/api/vmaf-jobs/job-1/preview?resultId=r1",
		]);
		expect(
			screen.getByLabelText("H.264 · Rung 1", { selector: "video" }),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("AV1 · Rung 1", { selector: "video" }),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Close comparison preview" }),
		);
		expect(container.querySelectorAll("video")).toHaveLength(0);
	});

	it("uses the comparison chart to seek both report videos at the measured clock", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		const { container } = renderWithQuery(
			<ReportFrameComparison
				jobs={jobs}
				series={series}
				shownSeries={series.slice(0, 1)}
			/>,
		);
		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Open comparison preview" }),
		);
		const videos = [...container.querySelectorAll("video")];
		for (const video of videos)
			Object.defineProperty(video, "readyState", {
				configurable: true,
				value: 4,
			});
		await user.click(screen.getByRole("button", { name: "Chart frame 48" }));
		for (const video of videos)
			expect(video.currentTime).toBeCloseTo(48.5 / 24);
	});

	it.each([
		undefined,
		30,
	])("retains charts without pretending mixed or missing FPS is synchronized (%s)", (fps) => {
		const mixed = jobs.map((job, index) =>
			index === 1 ? { ...job, reference: { fps } } : job,
		);
		renderWithQuery(
			<ReportFrameComparison
				jobs={mixed}
				series={series}
				shownSeries={series}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Open comparison preview" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Chart frame 48" }),
		).toBeInTheDocument();
	});

	it("keeps available report previews when another report has no retained media", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		const available = series.map((s) =>
			s.jobId === "job-0"
				? { ...s, result: { ...s.result, preview: undefined } }
				: s,
		);
		const { container } = renderWithQuery(
			<ReportFrameComparison
				jobs={jobs}
				series={available}
				shownSeries={available}
			/>,
		);
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Open comparison preview" }));
		expect(
			[...container.querySelectorAll("video")].every((v) =>
				v.getAttribute("src")?.includes("job-1"),
			),
		).toBe(true);
		expect(container.querySelectorAll("video")).toHaveLength(2);
	});
});
