import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { addVodAudio } from "./rendition-copy";
import { LadderSection } from "./wizard-sections";

function Harness({ initial }: { initial: WizardState }) {
	const [state, setState] = useState(initial);
	return (
		<>
			<LadderSection
				state={state}
				credentials={[]}
				onPatch={(patch) => setState((current) => ({ ...current, ...patch }))}
			/>
			<output data-testid="ladder-plan">
				{JSON.stringify(buildPlan(state))}
			</output>
		</>
	);
}

function plan() {
	return JSON.parse(screen.getByTestId("ladder-plan").textContent ?? "{}");
}

describe("VOD Per-Title initial height", () => {
	it.each([
		"ladder",
		"rendition",
	])("clears the Standard height from the %s mode control and keeps references valid", (control) => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.thumbnails = [
			{ key: "thumb", streamKey: "v360", height: 90, positions: [0] },
		];
		renderWithQuery(<Harness initial={initial} />);
		if (control === "ladder")
			fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		else
			fireEvent.change(screen.getByLabelText("Stream mode"), {
				target: { value: "PER_TITLE_TEMPLATE" },
			});
		expect(screen.getByLabelText("Video 1 height")).toHaveValue(null);
		expect(plan().renditions[0]).toMatchObject({
			key: "v360",
			height: null,
			bitrate: null,
			mode: "PER_TITLE_TEMPLATE",
		});
		expect(plan().thumbnails[0].streamKey).toBe("v360");
		fireEvent.change(screen.getByLabelText("Video 1 height"), {
			target: { value: "720" },
		});
		expect(screen.getByLabelText("Video 1 height")).toHaveValue(720);
		expect(plan().renditions[0]).toMatchObject({ key: "v720", height: 720 });
		expect(plan().thumbnails[0].streamKey).toBe("v720");
	});

	it("preserves the height of existing Per-Title rows when the rest of a mixed ladder enters Per-Title", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.videos.push({
			height: 1080,
			bitrate: null,
			extras: { mode: "PER_TITLE_TEMPLATE" },
		});
		renderWithQuery(<Harness initial={initial} />);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(screen.getByLabelText("Video 1 height")).toHaveValue(null);
		expect(screen.getByLabelText("Video 2 height")).toHaveValue(1080);
	});

	it("preserves a fixed-resolution Per-Title height", () => {
		renderWithQuery(
			<Harness initial={structuredClone(DEFAULT_WIZARD_STATE)} />,
		);
		fireEvent.change(screen.getByLabelText("Stream mode"), {
			target: { value: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" },
		});
		expect(screen.getByLabelText("Video 1 height")).toHaveValue(360);
	});

	it("keeps an authored Per-Title height when removing a Standard sibling", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.videos.push({
			height: 1080,
			bitrate: null,
			extras: { mode: "PER_TITLE_TEMPLATE" },
		});
		renderWithQuery(<Harness initial={initial} />);
		fireEvent.click(screen.getByLabelText("Remove video 1"));
		expect(screen.getByLabelText("Video 1 height")).toHaveValue(1080);
	});

	it("preserves an authored Per-Title height across codec changes and allows editing after returning to Standard", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.videos = [
			{ height: 720, bitrate: null, extras: { mode: "PER_TITLE_TEMPLATE" } },
		];
		renderWithQuery(<Harness initial={initial} />);
		fireEvent.change(screen.getAllByLabelText("Codec")[0] as HTMLElement, {
			target: { value: "H265" },
		});
		expect(screen.getByLabelText("Video 1 height")).toHaveValue(720);
		fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
		expect(screen.getByLabelText("Video 1 height")).toHaveValue(720);
		fireEvent.change(screen.getByLabelText("Video 1 height"), {
			target: { value: "540" },
		});
		expect(plan().renditions[0]).toMatchObject({ codec: "H265", height: 540 });
	});
});

describe("VOD default audio", () => {
	it("starts with AAC at 128 kbps, 48 kHz and CL_STEREO in the editor and plan", () => {
		renderWithQuery(
			<Harness initial={structuredClone(DEFAULT_WIZARD_STATE)} />,
		);
		expect(screen.getByLabelText("Audio 1 bitrate")).toHaveValue(128_000);
		expect(screen.getByLabelText("Audio 1 sample rate")).toHaveValue(48_000);
		expect(screen.getByLabelText("Channel layout")).toHaveValue("CL_STEREO");
		expect(
			plan().renditions.find((row: { codec: string }) => row.codec === "AAC"),
		).toMatchObject({
			codec: "AAC",
			bitrate: 128_000,
			rate: 48_000,
			channelLayout: "CL_STEREO",
		});
	});

	it("adds the same default audio when no rendition exists", () => {
		const initial = { ...structuredClone(DEFAULT_WIZARD_STATE), audios: [] };
		expect(addVodAudio(initial).audios[0]).toMatchObject({
			codec: "AAC",
			bitrate: 128_000,
			rate: 48_000,
			channelLayout: "CL_STEREO",
		});
	});

	it("copies authored audio settings without replacing them with defaults", () => {
		const initial: WizardState = {
			...structuredClone(DEFAULT_WIZARD_STATE),
			audios: [
				{
					codec: "AAC",
					bitrate: 96_000,
					rate: 44_100,
					channelLayout: "CL_MONO",
				},
			],
		};
		expect(addVodAudio(initial, 0).audios[1]).toMatchObject({
			codec: "AAC",
			bitrate: 96_000,
			rate: 44_100,
			channelLayout: "CL_MONO",
		});
		expect(initial.audios[0]?.rate).toBe(44_100);
	});
});
