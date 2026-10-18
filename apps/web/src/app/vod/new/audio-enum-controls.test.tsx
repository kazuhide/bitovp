import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import { DEFAULT_WIZARD_STATE, type WizardAudioCodec } from "./build-plan";
import { LadderSection } from "./wizard-sections";

function renderAudio(codec: WizardAudioCodec, channelLayout?: string) {
	const onPatch = vi.fn();
	render(
		<LadderSection
			state={{
				...DEFAULT_WIZARD_STATE,
				videos: [],
				audios: [{ codec, bitrate: 128000, rate: 48000, channelLayout }],
			}}
			credentials={[]}
			onPatch={onPatch}
		/>,
	);
	return onPatch;
}

describe("audio channel layout enum controls", () => {
	it.each([
		["AAC", "AacChannelLayout"],
		["OPUS", "OpusChannelLayout"],
		["DD", "DolbyDigitalChannelLayout"],
		["DDPLUS", "DolbyDigitalPlusChannelLayout"],
	] as const)("offers the exact installed SDK enum keys for %s", (codec, model) => {
		renderAudio(codec);
		const control = screen.getByLabelText(
			"Channel layout",
		) as HTMLSelectElement;
		expect(control.tagName).toBe("SELECT");
		const source = readFileSync(
			join(
				__dirname,
				`../../../../node_modules/@bitmovin/api-sdk/dist/models/${model}.d.ts`,
			),
			"utf8",
		);
		const keys = [...source.matchAll(/^\s+(\w+) = /gm)].map(
			(match) => match[1],
		);
		expect(keys.length).toBeGreaterThan(0);
		expect([...control.options].map((option) => option.value)).toEqual([
			"",
			...keys,
		]);
		expect(control).toHaveValue("");
	});
	it("keeps an imported unknown layout visible and clears it without changing siblings", () => {
		const onPatch = renderAudio("AAC", "FUTURE_LAYOUT");
		const control = screen.getByLabelText("Channel layout");
		expect(control).toHaveValue("FUTURE_LAYOUT");
		fireEvent.change(control, { target: { value: "" } });
		expect(onPatch).toHaveBeenCalledWith({
			audios: [
				{
					codec: "AAC",
					bitrate: 128000,
					rate: 48000,
					channelLayout: undefined,
				},
			],
		});
	});
	it("does not offer a channel-layout field for Atmos", () => {
		renderAudio("DOLBY_ATMOS");
		expect(screen.queryByLabelText("Channel layout")).not.toBeInTheDocument();
	});
});
