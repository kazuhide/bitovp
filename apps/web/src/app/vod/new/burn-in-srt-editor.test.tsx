import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import { DEFAULT_WIZARD_STATE, type WizardState } from "./build-plan";
import { LadderSection } from "./wizard-sections";

it("authors and clears SRT burn-in inside existing ladder details without entering provider ids", () => {
	const primary =
		DEFAULT_WIZARD_STATE.inputFiles[0] ??
		(() => {
			throw new Error("Missing primary fixture");
		})();
	function Harness() {
		const [state, setState] = useState<WizardState>({
			...DEFAULT_WIZARD_STATE,
			videos: [{ height: 360, bitrate: 200000 }],
			inputFiles: [
				...DEFAULT_WIZARD_STATE.inputFiles,
				{
					...primary,
					key: "srt-file",
					path: "captions/ja.srt",
				},
			],
		});
		return (
			<>
				<LadderSection
					state={state}
					credentials={[]}
					onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
				/>
				<output data-testid="state">{JSON.stringify(state)}</output>
			</>
		);
	}
	render(<Harness />);
	const source = document.querySelector(
		'[id$="-burn-srt"]',
	) as HTMLSelectElement;
	expect(source.closest("details")).not.toHaveAttribute("open");
	fireEvent.change(source, { target: { value: "srt-file" } });
	let state = JSON.parse(screen.getByTestId("state").textContent ?? "{}");
	expect(state.videos[0].extras.burnInSrt).toEqual({
		inputFile: "srt-file",
		characterEncoding: "UTF_8",
	});
	fireEvent.change(
		document.querySelector('[id$="-burn-encoding"]') as HTMLSelectElement,
		{
			target: { value: "SHIFT_JIS" },
		},
	);
	state = JSON.parse(screen.getByTestId("state").textContent ?? "{}");
	expect(state.videos[0].extras.burnInSrt.characterEncoding).toBe("SHIFT_JIS");
	fireEvent.change(source, { target: { value: "" } });
	state = JSON.parse(screen.getByTestId("state").textContent ?? "{}");
	expect(state.videos[0].extras.burnInSrt).toBeUndefined();
});
