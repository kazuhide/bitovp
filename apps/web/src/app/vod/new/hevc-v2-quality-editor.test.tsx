import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardH265Options,
	type WizardState,
} from "./build-plan";
import { HevcV2QualityEditor } from "./hevc-v2-quality-editor";
import { addVodVideo } from "./rendition-copy";
import { LadderSection } from "./wizard-sections";

function Harness() {
	const [value, setValue] = useState<WizardH265Options>({});
	return (
		<>
			<HevcV2QualityEditor idBase="quality" value={value} onChange={setValue} />
			<output data-testid="quality-value">{JSON.stringify(value)}</output>
		</>
	);
}

describe("native HEVCv2 quality controls", () => {
	it("keeps defaults unset, preserves explicit OFF and zero, and removes the entire nested config", () => {
		render(<Harness />);
		expect(screen.getByTestId("quality-value")).toHaveTextContent("{}");
		fireEvent.change(
			screen.getByLabelText("Motion compensated temporal filtering (MCTF)"),
			{ target: { value: "OFF" } },
		);
		fireEvent.change(
			screen.getByLabelText("Perceptual quality configuration"),
			{ target: { value: "PERCEPTUAL_QUALITY_MODE" } },
		);
		fireEvent.change(screen.getByLabelText("Perceptual encoding mode"), {
			target: { value: "OFF" },
		});
		fireEvent.change(screen.getByLabelText("Perceptual strength"), {
			target: { value: "0" },
		});
		expect(
			JSON.parse(screen.getByTestId("quality-value").textContent ?? "{}"),
		).toEqual({
			motionCompensatedTemporalFiltering: "OFF",
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualEncodingMode: "OFF",
				perceptualStrength: 0,
			},
		});
		fireEvent.change(
			screen.getByLabelText("Perceptual quality configuration"),
			{ target: { value: "" } },
		);
		expect(screen.queryByLabelText("Perceptual strength")).toBeNull();
		expect(
			JSON.parse(screen.getByTestId("quality-value").textContent ?? "{}"),
		).toEqual({ motionCompensatedTemporalFiltering: "OFF" });
		fireEvent.change(
			screen.getByLabelText("Motion compensated temporal filtering (MCTF)"),
			{ target: { value: "" } },
		);
		expect(screen.getByTestId("quality-value")).toHaveTextContent("{}");
	});
	it.each([
		false,
		true,
	])("only exposes new controls for an enabled account (enabled=%s)", (hevcV2Available) => {
		render(
			<LadderSection
				hevcV2Available={hevcV2Available}
				state={{
					...DEFAULT_WIZARD_STATE,
					videos: [{ codec: "H265V2", height: 720, bitrate: 1000000 }],
				}}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByText("Advanced HEVCv2"));
		expect(
			Boolean(
				screen.queryByLabelText("Motion compensated temporal filtering (MCTF)"),
			),
		).toBe(hevcV2Available);
	});
	it("copy and codec switch retain native intent for validation", () => {
		const state: WizardState = {
			...structuredClone(DEFAULT_WIZARD_STATE),
			internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } },
			videos: [
				{
					codec: "H265V2",
					height: 720,
					bitrate: 1000000,
					h265: {
						motionCompensatedTemporalFiltering: "OFF",
						rateControlModeConfig: {
							type: "PERCEPTUAL_QUALITY_MODE",
							perceptualEncodingMode: "OFF",
						},
					},
				},
			],
		};
		const copied = { ...state, ...addVodVideo(state, 0) };
		expect(copied.videos[1]?.h265).toEqual(state.videos[0]?.h265);
		const onPatch = vi.fn();
		render(
			<LadderSection
				hevcV2Available
				state={state}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		const [codec] = screen.getAllByLabelText("Codec");
		if (!codec) throw new Error("Missing video codec control");
		fireEvent.change(codec, {
			target: { value: "H265" },
		});
		const switched = { ...state, ...onPatch.mock.lastCall?.[0] };
		expect(switched.videos[0]?.h265).toEqual(state.videos[0]?.h265);
		expect(buildPlan(switched).renditions[0]).toMatchObject(
			state.videos[0]?.h265 ?? {},
		);
	});
});
