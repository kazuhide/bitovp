import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { projectWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery as render } from "@/test/render";
import type { WizardCaptionStream } from "./build-plan";
import { EmbeddedCaptionSources } from "./embedded-caption-sources";

function Editor() {
	const [streams, setStreams] = useState<WizardCaptionStream[]>([]);
	return (
		<>
			<EmbeddedCaptionSources
				streams={streams}
				files={[{ key: "feature", label: "feature.ts", path: "feature.ts" }]}
				encodings={[]}
				nextKey="sub1"
				onChange={setStreams}
			/>
			<output>
				{JSON.stringify(
					projectWizardDraft("vod", { sources: { captionStreams: streams } }),
				)}
			</output>
		</>
	);
}
describe("embedded caption authoring", () => {
	it("persists each caption selector in the draft and clears incompatible track settings", () => {
		render(<Editor />);
		fireEvent.click(
			screen.getByRole("button", { name: "Add embedded captions" }),
		);
		const draft = () =>
			JSON.parse(screen.getByRole("status").textContent ?? "").sources
				.captionStreams[0];
		fireEvent.change(screen.getByLabelText("Caption channel"), {
			target: { value: "CC3" },
		});
		expect(draft()).toEqual({
			kind: "CEA608",
			inputFile: "feature",
			key: "sub1",
			channel: "CC3",
		});
		fireEvent.change(screen.getByLabelText("Caption format"), {
			target: { value: "CEA708" },
		});
		expect(draft()).not.toHaveProperty("channel");
		fireEvent.change(screen.getByLabelText("Caption service"), {
			target: { value: "63" },
		});
		expect(draft().channel).toBe(63);
		fireEvent.change(screen.getByLabelText("Caption format"), {
			target: { value: "DVB" },
		});
		fireEvent.change(screen.getByLabelText("Track selection"), {
			target: { value: "SUBTITLE_RELATIVE" },
		});
		fireEvent.change(screen.getByLabelText("Track position (zero-based)"), {
			target: { value: "2" },
		});
		expect(draft()).toMatchObject({
			kind: "DVB",
			position: 2,
			selectionMode: "SUBTITLE_RELATIVE",
		});
		fireEvent.change(screen.getByLabelText("Track selection"), {
			target: { value: "AUTO" },
		});
		expect(draft()).toEqual({
			kind: "DVB",
			inputFile: "feature",
			key: "sub1",
			selectionMode: "AUTO",
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Remove caption source" }),
		);
		expect(screen.queryByRole("group")).toBeNull();
	});
});
