import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_MOQ_VIDEO_STATISTICS } from "@/lib/moq-player/video-statistics";
import { renderLocalized } from "@/test/render";
import { MoqPlayerStatistics } from "./moq-player-statistics";

describe("canvas measurement provenance", () => {
	it("names the measured canvas update rate and leaves original decoder counters unknown", () => {
		renderLocalized(
			<MoqPlayerStatistics
				configuration={null}
				statistics={{
					...EMPTY_MOQ_VIDEO_STATISTICS,
					renderingSource: "canvas",
					fps: 2,
				}}
			/>,
		);
		expect(
			screen.getByText("Canvas image updates").nextElementSibling,
		).toHaveTextContent("2.0 /s");
		expect(
			screen.getByText("Rendering source").nextElementSibling,
		).toHaveTextContent("Canvas (video-only capture)");
		expect(screen.queryByText("Decoded frames")).toBeNull();
		expect(screen.queryByText("Video FPS")).toBeNull();
	});
	it("keeps only measured primary values, preserves zero, and collapses configuration and secondary counters", () => {
		const rendered = renderLocalized(
			<MoqPlayerStatistics
				configuration={{
					namespace: "original",
					catalogTrackName: "catalog",
					draftVersion: 16,
					mediaTypes: ["audio", "video"],
				}}
				statistics={{
					...EMPTY_MOQ_VIDEO_STATISTICS,
					latencySeconds: 0,
					bufferSeconds: 0,
					bufferSource: "player",
					resolution: "640×360",
					droppedFrames: 0,
				}}
			/>,
		);
		expect(
			screen.getByText("Video latency (barcode)").nextElementSibling,
		).toHaveTextContent("0 ms");
		expect(
			screen.getByText("Player buffer").nextElementSibling,
		).toHaveTextContent("0.00 s");
		expect(screen.getByText("Configured namespace")).not.toBeVisible();
		expect(screen.getByText("Dropped frames")).not.toBeVisible();
		expect(screen.queryByText("Decoded frames")).toBeNull();
		expect(rendered.container.querySelectorAll("details[open]")).toHaveLength(
			0,
		);
	});
	it("shows one compact unknown-latency status without a grid of unknown counters", () => {
		const rendered = renderLocalized(
			<MoqPlayerStatistics
				configuration={null}
				statistics={EMPTY_MOQ_VIDEO_STATISTICS}
			/>,
		);
		expect(screen.getAllByText("Unmeasured")).toHaveLength(1);
		expect(rendered.container.querySelectorAll("dt")).toHaveLength(1);
		expect(rendered.container.querySelector("details")).toBeNull();
	});
});
