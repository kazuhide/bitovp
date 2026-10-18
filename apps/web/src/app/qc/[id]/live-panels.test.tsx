import { computePooled } from "@bitovp/core";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import type { LiveReportMetadata, VmafResultDetail } from "../vmaf-shared";
import { LivePanels } from "./live-panels";

/**
 * LivePanels renders the pseudo-live alignment summary (loop-offset map,
 * confidence, drift) for LIVE results, and nothing for VOD results. Driven by
 * mock LIVE detail payloads.
 */

function liveResult(
	id: string,
	live: LiveReportMetadata,
	scores: number[] = [97, 98, 96],
): VmafResultDetail {
	const frames = scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
	return {
		id,
		renditionRef: { label: "1080p", height: 1080, bitrate: 4500000 },
		pooled: computePooled(frames),
		frames,
		frameCount: frames.length,
		live,
	};
}

const HEALTHY: LiveReportMetadata = {
	offset: 42,
	confidence: 0.97,
	lowConfidence: false,
	fps: 30,
	sourceFrames: 300,
	distortedFrames: 360,
	coarseOffset: 40,
	drift: {
		detected: false,
		maxDriftFrames: 0,
		perSegmentOffsets: [42, 42, 42],
	},
	loopMap: [
		{ outputFrameStart: 0, sourceFrameStart: 42, loopIndex: 0 },
		{ outputFrameStart: 258, sourceFrameStart: 0, loopIndex: 1 },
		{ outputFrameStart: 558, sourceFrameStart: 0, loopIndex: 2 },
	],
};

describe("LivePanels", () => {
	it("keeps a period warning visible even with high alignment confidence", () => {
		renderL(
			<LivePanels
				results={[
					liveResult("r1", {
						...HEALTHY,
						warning: "Measured output period differs from the reference loop.",
					}),
				]}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Measured output period differs",
		);
	});

	it.each([
		"en",
		"ja",
	] as const)("labels low-confidence scores as unverified in %s without a worker warning", (locale) => {
		renderL(
			<LivePanels
				results={[liveResult("r1", { ...HEALTHY, lowConfidence: true })]}
			/>,
			locale,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			locale === "ja" ? "整列未検証" : "Alignment unverified",
		);
	});

	it("marks the diagnostic all-unconfident pool even when the legacy confidence flag is false", () => {
		renderL(
			<LivePanels
				results={[
					liveResult("r1", { ...HEALTHY, pooledWithoutAlignment: true }),
				]}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"not a verified quality measurement",
		);
	});

	it.each([
		"en",
		"ja",
	] as const)("shows recorded exclusions and loop masks without treating them as additive in %s", (locale) => {
		renderL(
			<LivePanels
				results={[
					liveResult("r1", {
						...HEALTHY,
						excluded: { segments: [0], frames: 60 },
						masked: { frames: 12, share: 1 / 30 },
					}),
				]}
			/>,
			locale,
		);
		expect(
			screen.getByText(
				locale === "ja"
					? "信頼度による除外フレーム: 60"
					: "Confidence-excluded frames: 60",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				locale === "ja"
					? "ループ境界のマスクフレーム: 12"
					: "Loop-masked frames: 12",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("does not invent exclusion counts or an unverified verdict for legacy healthy metadata", () => {
		renderL(<LivePanels results={[liveResult("r1", HEALTHY)]} />);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.queryByText(/Confidence-excluded frames|Loop-masked frames/),
		).not.toBeInTheDocument();
	});

	it("renders the loop-offset map (≥3 entries), confidence and offset", () => {
		renderL(<LivePanels results={[liveResult("r1", HEALTHY)]} />);
		expect(screen.getByText("0.970")).toBeInTheDocument();
		// Offset headline (42) appears; sourceFrameStart in loop 0 is also 42, so
		// assert at least one and the labelled "Offset (frames)" header.
		expect(screen.getByText("Offset (frames)")).toBeInTheDocument();
		expect(screen.getAllByText("42").length).toBeGreaterThanOrEqual(1);
		// 3 loop rows in the map (loopIndex 0,1,2).
		expect(screen.getByText("Loop-offset map")).toBeInTheDocument();
		expect(screen.getByText("3 loops in window")).toBeInTheDocument();
		// The output-frame-start values from the loopMap are present.
		expect(screen.getByText("258")).toBeInTheDocument();
		expect(screen.getByText("558")).toBeInTheDocument();
	});

	it("shows a low-confidence warning band", () => {
		const result = liveResult("r1", {
			...HEALTHY,
			confidence: 0.31,
			lowConfidence: true,
			warning:
				"Low alignment confidence (0.31 < 0.5) — scores may be misaligned.",
		});
		renderL(<LivePanels results={[result]} />);
		expect(screen.getByText(/Low alignment confidence/)).toBeInTheDocument();
	});

	it("shows a drift warning with maxDriftFrames when drift is detected", () => {
		const result = liveResult("r1", {
			...HEALTHY,
			drift: {
				detected: true,
				maxDriftFrames: 3,
				perSegmentOffsets: [42, 43, 45],
			},
		});
		renderL(<LivePanels results={[result]} />);
		expect(screen.getByText(/Drift detected/)).toBeInTheDocument();
		expect(screen.getByText(/spans 3 frames/)).toBeInTheDocument();
	});

	it("renders nothing when no result carries live metadata (VOD)", () => {
		const vod: VmafResultDetail = {
			id: "r1",
			renditionRef: { label: "1080p", height: 1080, bitrate: 4500000 },
			pooled: computePooled([{ frameNum: 0, vmaf: 95 }]),
			frames: [{ frameNum: 0, vmaf: 95 }],
			frameCount: 1,
		};
		const { container } = renderL(<LivePanels results={[vod]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows 'full search' when no coarse anchor was used", () => {
		renderL(
			<LivePanels
				results={[liveResult("r1", { ...HEALTHY, coarseOffset: null })]}
			/>,
		);
		expect(screen.getByText("full search")).toBeInTheDocument();
	});
});
