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
		expect(
			screen.getByText("Decoded frames").nextElementSibling,
		).toHaveTextContent("—");
		expect(screen.queryByText("Video FPS")).toBeNull();
	});
});
