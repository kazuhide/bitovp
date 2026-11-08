import {
	type CompositionDocument,
	compileComposition,
	evaluateCompositionAudio,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionInspector } from "./composition-inspector";

const trackId = "99999999-9999-4999-8999-999999999999";
function fixture(count = 1) {
	const project = editingProjectFixture(),
		document = toCompositionDocument(project.draft);
	if (!project.media.timeMap) throw new Error("Missing time map");
	const facts = {
		mediaVersionId: project.media.id,
		timeMap: project.media.timeMap,
		width: 1920,
		height: 1080,
		hasAudio: true,
	};
	document.audioTracks = [
		{
			id: trackId,
			mediaVersionId: project.media.id,
			sourceInUs: facts.timeMap.sourceStartUs,
			timelineStartFrame: 0,
			durationFrames: 300,
			gainDb: 0,
			fadeInFrames: 0,
			fadeOutFrames: 0,
		},
	];
	document.captions = Array.from({ length: count }, (_, index) => ({
		id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
		fromFrame: 10,
		toFrame: 20,
		text: `Caption${index + 1}`,
	}));
	return { project, document, facts };
}
function Harness({ initial }: { initial: ReturnType<typeof fixture> }) {
	const [document, setDocument] = useState<CompositionDocument>(
		initial.document,
	);
	const plan = compileComposition(document, [initial.facts]);
	const gain = (frame: number) =>
		evaluateCompositionAudio(plan, frame).find(
			(item) => item.id === `track:${trackId}`,
		)?.gain;
	return (
		<>
			<CompositionInspector
				document={document}
				sources={[initial.facts]}
				catalog={[{ ...initial.project.media, facts: initial.facts }]}
				selectedId={document.clips[0]?.id ?? ""}
				frame={0}
				disabled={false}
				onChange={setDocument}
				onSelect={vi.fn()}
				onError={vi.fn()}
				onUpload={async () => {}}
			/>
			<output aria-label="Music gain at frame15">{gain(15)}</output>
			<output aria-label="Music gain at frame45">{gain(45)}</output>
			<output aria-label="Music ducking setting">
				{JSON.stringify(document.audioTracks?.[0]?.ducking)}
			</output>
		</>
	);
}
const openAudio = () =>
	fireEvent.click(screen.getByRole("button", { name: /^Audio$/ }));
const openText = () =>
	fireEvent.click(screen.getByRole("button", { name: /^Captions & titles$/ }));
const checkbox = () =>
	screen.getByRole("checkbox", { name: "Lower music during captions" });
const musicGain = (frame: number) =>
	Number(screen.getByLabelText(`Music gain at frame${frame}`).textContent);

it("the inspector's music option follows later caption edits, addition and deletion", () => {
	renderWithQuery(<Harness initial={fixture()} />);
	openAudio();
	fireEvent.click(checkbox());
	expect(musicGain(15)).toBeCloseTo(10 ** (-18 / 20));
	openText();
	const to = screen.getByLabelText("To (s)");
	fireEvent.change(to, { target: { value: "1.6666666667" } });
	fireEvent.blur(to);
	const from = screen.getByLabelText("From (s)");
	fireEvent.change(from, { target: { value: "1.3333333333" } });
	fireEvent.blur(from);
	expect(musicGain(15)).toBe(1);
	expect(musicGain(45)).toBeCloseTo(10 ** (-18 / 20));
	fireEvent.click(
		screen.getByRole("button", { name: "Add caption at playhead" }),
	);
	expect(musicGain(15)).toBeCloseTo(10 ** (-18 / 20));
	const firstRemove = screen.getAllByRole("button", { name: /^Remove$/ })[0];
	if (!firstRemove) throw new Error("Missing caption removal control");
	fireEvent.click(firstRemove);
	fireEvent.click(screen.getByRole("button", { name: /^Remove$/ }));
	expect(musicGain(15)).toBe(1);
	expect(musicGain(45)).toBe(1);
	openAudio();
	expect(checkbox()).toBeEnabled();
	fireEvent.click(checkbox());
	expect(checkbox()).not.toBeChecked();
});
it("stores a caption-linked source with no captured interval snapshot", () => {
	renderWithQuery(<Harness initial={fixture()} />);
	openAudio();
	fireEvent.click(checkbox());
	expect(
		JSON.parse(
			screen.getByLabelText("Music ducking setting").textContent ?? "null",
		),
	).toMatchObject({ source: "CAPTIONS", intervals: [] });
});
it("blocks enabling caption-linked ducking above 64 while normal captions remain editable", () => {
	renderWithQuery(<Harness initial={fixture(65)} />);
	openAudio();
	expect(checkbox()).toBeDisabled();
	expect(screen.getByText(/supports up to 64 captions/i)).toBeInTheDocument();
	openText();
	expect(
		screen.getByRole("button", { name: "Add caption at playhead" }),
	).toBeEnabled();
});
it("allows exactly 64 linked captions and blocks the 65th with help", () => {
	renderWithQuery(<Harness initial={fixture(64)} />);
	openAudio();
	expect(checkbox()).toBeEnabled();
	fireEvent.click(checkbox());
	openText();
	expect(
		screen.getByRole("button", { name: "Add caption at playhead" }),
	).toBeDisabled();
	expect(screen.getByText(/supports up to 64 captions/i)).toBeInTheDocument();
});
