import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
