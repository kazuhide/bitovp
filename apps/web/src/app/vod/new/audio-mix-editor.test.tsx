import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import { AudioMixEditor } from "./audio-mix-editor";
import { DEFAULT_WIZARD_STATE, type WizardState } from "./build-plan";
import { LadderSection } from "./wizard-sections";

let current: WizardState;
function Harness() {
	const [state, setState] = useState<WizardState>({
		...DEFAULT_WIZARD_STATE,
		sources: {
			tracks: [
				{
					key: "mono2",
					inputFile: "primary",
					selectionMode: "AUDIO_RELATIVE",
					position: 1,
				},
			],
		},
	});
	current = state;
	return (
		<AudioMixEditor
			state={state}
			index={0}
			sourceOptions={[
				{ value: "", label: "Input · audio track 0" },
				{ value: "mono2", label: "Second.wav · audio track 1" },
			]}
			onPatch={(patch) => setState((s) => ({ ...s, ...patch }))}
		/>
	);
}
it("creates mix with existing source refs, edits decimal and zero gain, clears optional gain, detaches", () => {
	render(<Harness />);
	fireEvent.click(screen.getByText("Audio channel mix"));
	fireEvent.change(screen.getByLabelText("Start from a preset"), {
		target: { value: "mono" },
	});
	expect(
		current.sources?.audioMixStreams?.[0]?.audioMixChannels.map(
			(c) => c.sourceKey,
		),
	).toEqual(["audio", "mono2"]);
	expect(screen.getAllByLabelText("Source audio")[1]).toHaveValue("mono2");
	expect(current.audios[0]?.channelLayout).toBe("CL_STEREO");
	const gain = screen.getAllByLabelText("Gain")[0];
	if (!gain) throw new Error("Gain control missing");
	fireEvent.change(gain, { target: { value: "0." } });
	expect(gain).toHaveValue("0.");
	fireEvent.change(gain, { target: { value: "0.25" } });
	fireEvent.blur(gain);
	expect(
		current.sources?.audioMixStreams?.[0]?.audioMixChannels[0]
			?.sourceChannels[0]?.gain,
	).toBe(0.25);
	fireEvent.change(gain, { target: { value: "0" } });
	fireEvent.blur(gain);
	expect(
		current.sources?.audioMixStreams?.[0]?.audioMixChannels[0]
			?.sourceChannels[0]?.gain,
	).toBe(0);
	fireEvent.change(gain, { target: { value: "" } });
	fireEvent.blur(gain);
	expect(
		current.sources?.audioMixStreams?.[0]?.audioMixChannels[0]
			?.sourceChannels[0]?.gain,
	).toBeUndefined();
	fireEvent.click(screen.getByText("Remove mix from this rendition"));
	expect(current.sources?.audioMixStreams).toEqual([]);
	expect(current.audios[0]?.extras?.source).toBe("audio");
});

it("excludes audio mixes from the Dolby Atmos source choices", () => {
	const state: WizardState = {
		...DEFAULT_WIZARD_STATE,
		audios: [{ codec: "DOLBY_ATMOS", bitrate: 448000, rate: 48000 }],
		sources: {
			audioMixStreams: [
				{
					key: "mix",
					audioMixChannels: [
						{
							sourceKey: "audio",
							outputChannelType: "FRONT_LEFT",
							sourceChannels: [{ type: "FRONT_LEFT" }],
						},
					],
				},
			],
		},
	};
	render(<LadderSection state={state} credentials={[]} onPatch={() => {}} />);
	const source = document.getElementById(
		"wz-a-0-x-source",
	) as HTMLSelectElement;
	expect(source).not.toBeNull();
	expect(Array.from(source.options).map((o) => o.value)).not.toContain("mix");
});

it("reapplies presets without changing the selected source material", () => {
	render(<Harness />);
	fireEvent.click(screen.getByText("Audio channel mix"));
	const preset = screen.getByLabelText("Start from a preset");
	fireEvent.change(preset, { target: { value: "mono" } });
	const [left, right] = screen.getAllByLabelText("Source audio");
	if (!left || !right) throw new Error("Missing mix source controls");
	fireEvent.change(left, { target: { value: "mono2" } });
	fireEvent.change(right, { target: { value: "audio" } });
	fireEvent.change(preset, { target: { value: "mono" } });
	expect(
		current.sources?.audioMixStreams?.[0]?.audioMixChannels.map(
			(c) => c.sourceKey,
		),
	).toEqual(["mono2", "audio"]);
	for (const value of ["swap", "downmix"]) {
		fireEvent.change(preset, { target: { value } });
		expect(
			current.sources?.audioMixStreams?.[0]?.audioMixChannels.map(
				(c) => c.sourceKey,
			),
		).toEqual(["mono2", "mono2"]);
	}
});

for (const preset of ["downmix", "swap"]) {
	it(`preserves ${preset} source addressing when adding an output row`, () => {
		render(<Harness />);
		fireEvent.click(screen.getByText("Audio channel mix"));
		fireEvent.change(screen.getByLabelText("Start from a preset"), {
			target: { value: preset },
		});
		fireEvent.change(screen.getByLabelText("Mix channel layout"), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByText("Add output channel"));
		expect(
			current.sources?.audioMixStreams?.[0]?.audioMixChannels.at(-1)
				?.sourceChannels,
		).toEqual(
			preset === "downmix"
				? [{ type: "CHANNEL_NUMBER", channelNumber: 0 }]
				: [{ type: "CENTER" }],
		);
	});
}
