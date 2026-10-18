import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DEFAULT_LIVE_WIZARD_STATE } from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";
import { LiveStartSection } from "./start-section";

describe("Live closed enum controls", () => {
	it.each([
		"AAC",
		"DD",
		"DDPLUS",
	] as const)("offers %s channel layouts as choices and clears to default", (codec) => {
		const onPatch = vi.fn();
		renderWithQuery(
			<LiveLadderSection
				state={{
					...DEFAULT_LIVE_WIZARD_STATE,
					audios: [{ codec, bitrate: 128000, rate: 48000 }],
				}}
				onPatch={onPatch}
			/>,
		);
		const select = screen.getByLabelText("Channel layout");
		expect(select.tagName).toBe("SELECT");
		expect(
			within(select).getByRole("option", { name: "MONO" }),
		).toBeInTheDocument();
		expect(
			within(select).queryByRole("option", { name: "CL_MONO" }),
		).not.toBeInTheDocument();
		const layout = codec === "AAC" ? "CL_7_1_WIDE_BACK" : "CL_QUAD_LFE";
		expect(
			within(select).getByRole("option", { name: layout }),
		).toBeInTheDocument();
		fireEvent.change(select, { target: { value: layout } });
		expect(onPatch.mock.calls[0]?.[0].audios[0].channelLayout).toBe(layout);
		fireEvent.change(select, { target: { value: "" } });
		expect(onPatch.mock.calls[1]?.[0].audios[0].channelLayout).toBeUndefined();
	});

	it("preserves an imported channel layout outside the current codec list", () => {
		renderWithQuery(
			<LiveLadderSection
				state={{
					...DEFAULT_LIVE_WIZARD_STATE,
					audios: [
						{
							codec: "AAC",
							bitrate: 128000,
							rate: 48000,
							channelLayout: "FUTURE_LAYOUT",
						},
					],
				}}
				onPatch={vi.fn()}
			/>,
		);
		const select = screen.getByLabelText("Channel layout");
		expect(select.tagName).toBe("SELECT");
		expect(select).toHaveValue("FUTURE_LAYOUT");
		expect(
			within(select).getByRole("option", { name: "FUTURE_LAYOUT" }),
		).toBeInTheDocument();
	});

	it("selects a Cloud Connect region and keeps the top-level EXTERNAL rule", () => {
		const onPatch = vi.fn();
		renderWithQuery(
			<LiveStartSection state={DEFAULT_LIVE_WIZARD_STATE} onPatch={onPatch} />,
		);
		const select = screen.getByLabelText("Infrastructure region");
		expect(select.tagName).toBe("SELECT");
		fireEvent.change(select, { target: { value: "AWS_EU_WEST_1" } });
		expect(onPatch).toHaveBeenCalledWith({
			cloudRegion: "EXTERNAL",
			infrastructure: { infrastructureId: "", cloudRegion: "AWS_EU_WEST_1" },
		});
	});

	it("shows a saved region outside the current list and can clear the group", () => {
		const onPatch = vi.fn();
		renderWithQuery(
			<LiveStartSection
				state={{
					...DEFAULT_LIVE_WIZARD_STATE,
					infrastructure: { infrastructureId: "", cloudRegion: "EU_WEST_1" },
				}}
				onPatch={onPatch}
			/>,
		);
		const select = screen.getByLabelText("Infrastructure region");
		expect(select.tagName).toBe("SELECT");
		expect(select).toHaveValue("EU_WEST_1");
		fireEvent.change(select, { target: { value: "" } });
		expect(onPatch).toHaveBeenCalledWith({ infrastructure: undefined });
	});
});
