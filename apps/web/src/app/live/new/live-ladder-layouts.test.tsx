import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { DEFAULT_LIVE_WIZARD_STATE } from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";

describe("Live audio layout choices", () => {
	it.each([
		"AAC",
		"DD",
		"DDPLUS",
	] as const)("offers only %s SDK enum names", (codec) => {
		const audio = DEFAULT_LIVE_WIZARD_STATE.audios[0];
		if (!audio) throw new Error("fixture audio missing");
		const { container } = renderLocalized(
			<LiveLadderSection
				state={{
					...DEFAULT_LIVE_WIZARD_STATE,
					audios: [{ ...audio, codec }],
				}}
				onPatch={vi.fn()}
			/>,
			"en",
		);
		const select = container.querySelector<HTMLSelectElement>("#lw-a-0-layout");
		expect(select?.tagName).toBe("SELECT");
		const names = Array.from(select?.options ?? [], (option) => option.value);
		expect(names).toContain("MONO");
		expect(names).toContain("CL_STEREO");
		expect(names).not.toContain("CL_MONO");
		if (codec === "AAC") {
			expect(names).toContain("CL_5_1_BACK");
			expect(names).not.toContain("CL_5_1");
		} else {
			expect(names).toContain("CL_5_1");
			expect(names).not.toContain("CL_5_1_BACK");
			expect(names).not.toContain("CL_7_1");
		}
	});
});
