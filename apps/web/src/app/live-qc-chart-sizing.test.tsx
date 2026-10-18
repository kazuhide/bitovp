import { computePooled } from "@bitovp/core";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { HeartbeatHistory } from "./live/[id]/heartbeat-history";
import { RunTimelineChart } from "./live/[id]/run-timeline-chart";
import { FrameChart } from "./qc/[id]/frame-chart";
import { LadderScatter } from "./qc/[id]/ladder-scatter";
import type { CompareSeries } from "./qc/compare/compare-client";
import { CompareFrameChart } from "./qc/compare/compare-frame-chart";
import { CompareLadderChart } from "./qc/compare/compare-ladder-chart";
import type { VmafResultDetail } from "./qc/vmaf-shared";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const frames = [90, 80, 95].map((vmaf, frameNum) => ({ frameNum, vmaf }));
const result: VmafResultDetail = {
	id: "r1",
	renditionRef: { label: "720p", height: 720, bitrate: 1_500_000 },
	frames,
	frameCount: frames.length,
	pooled: computePooled(frames),
};
const series: CompareSeries[] = [
	{
		key: "s1",
		jobId: "j1",
		jobIndex: 0,
		jobLabel: "Job",
		label: "720p",
		color: "#10b981",
		mean: result.pooled.mean,
		result,
	},
];
// Tailwind border-box heights minus p-2 (16px) and border (2px).
const cases = [
	{
		name: "heartbeat",
		height: 238,
		chart: <HeartbeatHistory channelId="c1" status="STOPPED" />,
	},
	{
		name: "timeline",
		height: 206,
		chart: (
			<RunTimelineChart
				window={{ startMs: 0, endMs: 1000 }}
				events={[]}
				points={[]}
				nowMs={1000}
			/>
		),
	},
	{ name: "QC frames", height: 302, chart: <FrameChart results={[result]} /> },
	{
		name: "QC ladder",
		height: 270,
		chart: <LadderScatter results={[result]} />,
	},
	{
		name: "compare frames",
		height: 302,
		chart: <CompareFrameChart series={series} />,
	},
	{
		name: "compare ladder",
		height: 270,
		chart: <CompareLadderChart series={series} />,
	},
];
let observers: { callback: ResizeObserverCallback; target: Element }[];
let width: number;
let height: number;
beforeEach(() => {
	width = 0;
	height = 0;
	observers = [];
	apiFetch.mockResolvedValue({
		windowMinutes: 120,
		points: [
			{
				at: "2026-09-08T00:00:00Z",
				droppedPacketsVideo: 0,
				droppedPacketsAudio: 0,
				corruptPacketsVideo: 0,
				corruptPacketsAudio: 0,
				ingestStatus: "CONNECTED",
			},
			{
				at: "2026-09-08T00:00:02Z",
				droppedPacketsVideo: 1,
				droppedPacketsAudio: 0,
				corruptPacketsVideo: 0,
				corruptPacketsAudio: 0,
				ingestStatus: "CONNECTED",
			},
		],
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, width, height),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private callback: ResizeObserverCallback) {}
			observe(target: Element) {
				observers.push({ callback: this.callback, target });
			}
			unobserve() {}
			disconnect() {
				observers = observers.filter(
					({ callback }) => callback !== this.callback,
				);
			}
		},
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function resize(nextWidth: number) {
	width = nextWidth;
	act(() => {
		for (const { callback, target } of observers)
			callback(
				[
					{
						target,
						contentRect: new DOMRect(0, 0, width, height),
					} as ResizeObserverEntry,
				],
				{} as ResizeObserver,
			);
	});
}

it.each(
	cases,
)("$name waits for actual width without warnings and follows resize/remount", async ({
	chart,
	height: contentHeight,
}) => {
	height = contentHeight;
	const warn = vi.spyOn(console, "warn");
	const { container, rerender } = renderWithQuery(chart);
	await waitFor(() =>
		expect(
			container.querySelectorAll(".recharts-responsive-container"),
		).toHaveLength(1),
	);
	expect(container.querySelector("svg.recharts-surface")).toBeNull();
	expect(warn).not.toHaveBeenCalled();
	for (const nextWidth of [600, 320]) {
		if (nextWidth === 320) height = contentHeight - 12;
		resize(nextWidth);
		await waitFor(() =>
			expect(
				container.querySelector(
					`svg.recharts-surface[width='${nextWidth}'][height='${height}']`,
				),
			).not.toBeNull(),
		);
	}
	rerender(<div />);
	expect(container.querySelector(".recharts-responsive-container")).toBeNull();
	width = 0;
	rerender(chart);
	await waitFor(() =>
		expect(
			container.querySelectorAll(".recharts-responsive-container"),
		).toHaveLength(1),
	);
	expect(container.querySelector("svg.recharts-surface")).toBeNull();
	resize(480);
	await waitFor(() =>
		expect(
			container.querySelector(
				`svg.recharts-surface[width='480'][height='${height}']`,
			),
		).not.toBeNull(),
	);
	expect(warn).not.toHaveBeenCalled();
});
