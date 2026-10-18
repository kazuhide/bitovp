import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import { DEFAULT_WIZARD_STATE } from "./build-plan";
import { blankStream, convertStreamType, flattenStreams } from "./stream-model";
import { LadderSection } from "./wizard-sections";

describe("media authoring", () => {
	it("selects IMSC styling and TTML sources without HLS-only controls", () => {
		const onPatch = vi.fn();
		render(
			<LadderSection
				state={{
					...DEFAULT_WIZARD_STATE,
					subtitles: [{ codec: "IMSC", source: "ttml" }],
					sources: {
						fileStreams: [
							{ key: "ttml", fileType: "TTML", inputFile: "main" },
							{ key: "vtt", inputFile: "main" },
						],
					},
				}}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		const source = screen.getByLabelText("File stream") as HTMLSelectElement;
		expect(Array.from(source.options).map((x) => x.value)).toEqual([
			"",
			"ttml",
		]);
		expect(screen.queryByLabelText("Media URI")).toBeNull();
		fireEvent.change(screen.getByLabelText("Styling"), {
			target: { value: "DROP_STYLING" },
		});
		expect(onPatch).toHaveBeenLastCalledWith({
			subtitles: [
				{ codec: "IMSC", source: "ttml", styling: { mode: "DROP_STYLING" } },
			],
		});
	});
	it("preserves TTML type when adding, editing and converting source rows", () => {
		const sources = blankStream({}, "TTML", "input");
		const row = flattenStreams(sources)[0];
		if (!row) throw new Error("Missing stream");
		expect(row.type).toBe("TTML");
		expect(sources.fileStreams?.[0]?.fileType).toBe("TTML");
		expect(
			convertStreamType(sources, row, "WEBVTT").fileStreams?.[0]?.fileType,
		).toBeUndefined();
	});
});
