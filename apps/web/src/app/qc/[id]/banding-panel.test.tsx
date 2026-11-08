import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { BandingResultDetail } from "../vmaf-shared";
import { BandingPanels } from "./banding-panel";

const result: BandingResultDetail = {
	id: "banding-result",
	renditionRef: { label: "360p" },
	pooled: {
		banding: {
			mean: 4,
			min: 1,
			max: 12,
			frameCount: 1502,
			durationSeconds: 60.08,
		},
	},
	bandingFrames: [
		{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.04, cambi: 1 },
		{
			frameNum: 1001,
			timestampSeconds: 40.08,
			durationSeconds: 0.08,
			cambi: 12,
			computedCambi: 12.001,
			worst: true,
		},
	],
	bandingFrameCount: 1502,
	bandingExecution: {
		version: 1,
		metric: "CAMBI_NR",
		backend: "vulkan",
		implementation: "bitovp-owned",
		decisionSource: "CPU_REFERENCE",
		coverage: { complete: true, frameCount: 1502, durationSeconds: 60.08 },
	},
	bandingAssessment: {
		severity: "WARN",
		warningThreshold: 5,
		ranges: [
			{
				startSeconds: 40.04,
				endSeconds: 40.16,
				startFrame: 1000,
				endFrame: 1001,
				peak: 12,
				severity: "WARN",
			},
		],
		affectedSeconds: 0.12,
		warningSeconds: 0.12,
		failureSeconds: 0,
	},
};

describe("Banding report", () => {
	beforeEach(() => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});
	it("opens only the selected rendition and releases it when switching or closing", () => {
		renderWithQuery(
			<BandingPanels
				results={[
					{ ...result, bandingPreview: { url: "/first.mp4" } },
					{
						...result,
						id: "second",
						renditionRef: { label: "720p" },
						bandingPreview: { url: "/second.mp4" },
					},
				]}
			/>,
		);
		const buttons = screen.getAllByRole("button", {
			name: "Play 40.04–40.16 s",
		});
		fireEvent.click(buttons[0] as HTMLElement);
		const first = screen.getByLabelText("360p");
		expect(document.querySelectorAll("video")).toHaveLength(1);
		fireEvent.click(buttons[1] as HTMLElement);
		expect(screen.getByLabelText("720p")).toBeInTheDocument();
		expect(document.querySelectorAll("video")).toHaveLength(1);
		expect(first).not.toHaveAttribute("src");
		fireEvent.click(
			screen.getByRole("button", { name: "Close interval preview" }),
		);
		expect(document.querySelectorAll("video")).toHaveLength(0);
		expect(buttons[1]).toHaveFocus();
	});
	it("keeps scores and intervals when the pinned measured video is unavailable", () => {
		renderWithQuery(<BandingPanels results={[result]} />);
		expect(
			screen.getByRole("button", { name: "Play 40.04–40.16 s" }),
		).toBeDisabled();
		expect(
			screen.getByText(/version-pinned measured video is unavailable/),
		).toBeInTheDocument();
		expect(screen.getByRole("table")).toHaveTextContent("40.04");
		expect(screen.getByText("1,502")).toBeInTheDocument();
	});
	it("shows actual GPU execution separately from CPU-reference decisions and full-frame intervals", () => {
		renderWithQuery(<BandingPanels results={[result]} />);
		expect(
			screen.getByText("Actual execution: AMD Vulkan"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Decision source: official CPU reference · full-frame coverage",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: "CAMBI by presentation time — 360p" }),
		).toBeInTheDocument();
		const row = within(screen.getByRole("table")).getAllByRole("row")[1];
		expect(row).toHaveTextContent("40.04");
		expect(row).toHaveTextContent("40.16");
		expect(row).toHaveTextContent("WARN");
		expect(screen.getByText("1,502")).toBeInTheDocument();
		expect(screen.getByText(/interval ends are exclusive/)).toBeInTheDocument();
	});

	it("does not claim PASS or invent a failure limit for score-only measurements", () => {
		renderWithQuery(
			<BandingPanels
				results={[
					{
						...result,
						bandingAssessment: {
							severity: "PASS",
							ranges: [],
							affectedSeconds: 0,
							warningSeconds: 0,
							failureSeconds: 0,
						},
					},
				]}
			/>,
		);
		expect(
			screen.getByText("No thresholds configured — scores only"),
		).toBeInTheDocument();
		expect(screen.queryByText("PASS")).not.toBeInTheDocument();
		expect(screen.queryByText(/Configured limits/)).not.toBeInTheDocument();
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
	});

	it("distinguishes missing evidence from a passing threshold assessment", () => {
		renderWithQuery(
			<BandingPanels
				results={[
					{
						...result,
						bandingAssessment: undefined,
						bandingExecution: undefined,
					},
				]}
			/>,
			"ja",
		);
		expect(
			screen.getByText("全フレームの判定情報を取得できません"),
		).toBeInTheDocument();
		expect(
			screen.getByText("実行方式の記録を取得できません"),
		).toBeInTheDocument();
		expect(screen.queryByText("PASS")).not.toBeInTheDocument();
	});
});
