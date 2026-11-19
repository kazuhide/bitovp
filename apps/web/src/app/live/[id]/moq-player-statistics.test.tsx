import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_MOQ_VIDEO_STATISTICS } from "@/lib/moq-player/video-statistics";
import { renderLocalized } from "@/test/render";
import { MoqPlayerStatistics } from "./moq-player-statistics";

describe("MoQ playback details", () => {
	it("retains rendering source without inventing decoder counters", () => {
		renderLocalized(
			<MoqPlayerStatistics
				configuration={null}
				statistics={{
					...EMPTY_MOQ_VIDEO_STATISTICS,
					renderingSource: "canvas",
				}}
			/>,
		);
		expect(
			screen.getByText("Rendering source").nextElementSibling,
		).toHaveTextContent("Canvas (video-only capture)");
		expect(screen.queryByText("Decoded frames")).toBeNull();
	});

	it("keeps measured zero counters and leaves configuration collapsed", () => {
		const { container } = renderLocalized(
			<MoqPlayerStatistics
				configuration={{
					namespace: "original",
					catalogTrackName: "catalog",
					draftVersion: 16,
					mediaTypes: ["audio", "video"],
				}}
				statistics={{ ...EMPTY_MOQ_VIDEO_STATISTICS, droppedFrames: 0 }}
			/>,
		);
		expect(
			screen.getByText("Dropped frames").nextElementSibling,
		).toHaveTextContent("0");
		expect(screen.getByText("Configured namespace")).not.toBeVisible();
		expect(container.querySelectorAll("details[open]")).toHaveLength(0);
	});

	it("omits the details when there is nothing to show", () => {
		const { container } = renderLocalized(
			<MoqPlayerStatistics
				configuration={null}
				statistics={EMPTY_MOQ_VIDEO_STATISTICS}
			/>,
		);
		expect(container.querySelector("dl")).toBeNull();
		expect(container.querySelector("details")).toBeNull();
	});
});
