import {
	type CompositionDocument,
	type CompositionSourceFacts,
	compileComposition,
	evaluateCompositionFrame,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionInspector } from "./composition-inspector";

function fixture() {
	const project = editingProjectFixture();
	if (!project.media.timeMap) throw Error("Missing map");
	const document = toCompositionDocument(project.draft);
	document.captionLayout = { x: 0.1, y: 0.7, w: 0.8, h: 0.2 };
	document.captionStyle = {
		color: "#F0F0F0",
		emphasisColor: "#FFFF00",
		backgroundColor: "#11223380",
	};
	document.captions = [
		{
			id: "77777777-7777-4777-8777-777777777777",
			fromFrame: 0,
			toFrame: 30,
			text: "Hello",
			words: [
				{ fromFrame: 0, toFrame: 15, text: "Hello", startChar: 0, endChar: 5 },
			],
		},
	];
	const source: CompositionSourceFacts = {
		mediaVersionId: project.media.id,
		timeMap: project.media.timeMap,
		width: 1920,
		height: 1080,
		hasAudio: true,
	};
	return { project, document, source };
}
function tree(
	initial: CompositionDocument = fixture().document,
	disabled = false,
	locale: "en" | "ja" = "en",
) {
	const { project, source } = fixture(),
		changed = vi.fn();
	function Controlled() {
		const [document, setDocument] = useState(initial);
		const frame = evaluateCompositionFrame(
			compileComposition(document, [source], { allowUnconfirmed: true }),
			0,
		);
		return (
			<>
				<CompositionInspector
					document={document}
					sources={[source]}
					catalog={[{ ...project.media, facts: source }]}
					selectedId={document.clips[0]?.id ?? ""}
					frame={0}
					disabled={disabled}
					onChange={(next) => {
						compileComposition(next, [source], { allowUnconfirmed: true });
						changed(next);
						setDocument(next);
					}}
					onSelect={() => {}}
					onError={() => {
						throw Error("Invalid edit");
					}}
					onUpload={async () => {}}
				/>
				<output aria-label="Inspector document">
					{JSON.stringify(document)}
				</output>
				<output aria-label="Main video layout">
					{JSON.stringify(frame.layers[0]?.layoutRect)}
				</output>
				<output aria-label="Main video draw">
					{JSON.stringify(frame.layers[0]?.drawRect)}
				</output>
			</>
		);
	}
	renderLocalized(<Controlled />, locale);
	return { changed };
}
const documentValue = () =>
	JSON.parse(
		screen.getByLabelText("Inspector document").textContent ?? "null",
	) as CompositionDocument;
const layout = () =>
	JSON.parse(
		screen.getByLabelText("Main video layout").textContent ?? "null",
	) as { x: number; y: number; w: number; h: number };
const draw = () =>
	JSON.parse(
		screen.getByLabelText("Main video draw").textContent ?? "null",
	) as { x: number; y: number; w: number; h: number };
const textTab = () =>
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));

it("keeps legacy presentation absent until an explicit choice and clears only main overrides", () => {
	const { document } = fixture();
	document.videoTracks = [
		{ id: "main", name: "Main", order: 0 },
		{ id: "pip", name: "PIP", order: 1 },
	];
	const first = document.clips[0];
	if (!first) throw Error("Missing clip");
	first.videoFit = "FIT";
	const pip = {
		...structuredClone(first),
		id: "88888888-8888-4888-8888-888888888888",
		trackId: "pip",
		layout: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
	};
	const custom = {
		...structuredClone(first),
		id: "99999999-9999-4999-8999-999999999999",
		timelineStartFrame: 300,
		layout: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
	};
	document.clips.push(pip, custom);
	const { changed } = tree(document);
	expect(screen.getByRole("combobox", { name: "Video framing" })).toHaveValue(
		"LEGACY",
	);
	expect(changed).not.toHaveBeenCalled();
	expect(documentValue()).not.toHaveProperty("presentation");
	fireEvent.change(screen.getByRole("combobox", { name: "Video framing" }), {
		target: { value: "FILL" },
	});
	const next = documentValue();
	expect(next.presentation).toMatchObject({
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		centerCropConfirmed: false,
	});
	expect(next.clips[0]).not.toHaveProperty("videoFit");
	expect(next.clips[1]).toEqual(pip);
	expect(next.clips[2]).toEqual(custom);
	expect(draw()).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
});
it("lets a clip keep the full image over global Fill and restores Fill on manual crop", () => {
	const { document } = fixture();
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
	};
	tree(document);
	expect(draw().h).toBe(1920);
	fireEvent.click(screen.getByRole("button", { name: "Show full frame" }));
	expect(documentValue().clips[0]?.videoFit).toBe("FIT");
	expect(draw().h).toBeLessThan(1920);
	fireEvent.change(
		screen.getByRole("slider", { name: "Subject horizontal position" }),
		{ target: { value: "0.65" } },
	);
	expect(documentValue().clips[0]?.videoFit).toBe("FILL");
	expect(documentValue().clips[0]?.framing[0]?.mode).toBe("CROP");
	expect(draw().h).toBe(1920);
});
it("keeps intentional bands after removing captions and restores the saved overlay position", () => {
	const { document } = fixture();
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
	};
	tree(document);
	textTab();
	fireEvent.change(
		screen.getByRole("combobox", { name: "Caption placement" }),
		{ target: { value: "BANDS" } },
	);
	expect(layout()).toEqual({ x: 0, y: 346, w: 1080, h: 1228 });
	expect(documentValue().captionLayout).toEqual(document.captionLayout);
	expect(
		screen.queryByRole("spinbutton", { name: "Caption vertical position" }),
	).not.toBeInTheDocument();
	expect(
		screen.getByText(/Bands remain even if captions are removed/),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Remove" }));
	expect(documentValue().captions).toEqual([]);
	expect(documentValue().presentation?.captionPlacement).toBe("BANDS");
	expect(layout().y).toBe(346);
	fireEvent.change(
		screen.getByRole("combobox", { name: "Caption placement" }),
		{ target: { value: "OVERLAY" } },
	);
	expect(layout()).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
	expect(
		screen.getByRole("spinbutton", { name: "Caption vertical position" }),
	).toHaveValue(0.7);
	expect(documentValue().captionLayout).toEqual(document.captionLayout);
});
it("edits caption background RGB and alpha while retaining text and measured word timing", () => {
	const { document } = fixture();
	tree(document);
	textTab();
	expect(screen.getByLabelText("Caption background color")).toHaveValue(
		"#112233",
	);
	expect(
		screen.getByRole("slider", { name: "Caption background opacity (%)" }),
	).toHaveValue("50");
	fireEvent.change(screen.getByLabelText("Caption background color"), {
		target: { value: "#abcdef" },
	});
	expect(documentValue().captionStyle?.backgroundColor).toBe("#abcdef80");
	fireEvent.change(
		screen.getByRole("slider", { name: "Caption background opacity (%)" }),
		{ target: { value: "25" } },
	);
	expect(documentValue().captionStyle).toEqual({
		...document.captionStyle,
		backgroundColor: "#abcdef40",
	});
	expect(documentValue().captions).toEqual(document.captions);
	fireEvent.change(
		screen.getByRole("slider", { name: "Caption background opacity (%)" }),
		{ target: { value: "0" } },
	);
	expect(documentValue().captionStyle?.backgroundColor).toBe("#abcdef00");
	fireEvent.change(
		screen.getByRole("slider", { name: "Caption background opacity (%)" }),
		{ target: { value: "100" } },
	);
	expect(documentValue().captionStyle?.backgroundColor).toBe("#abcdefff");
});
it("disables presentation and background controls for read-only access", () => {
	tree(undefined, true);
	expect(
		screen.getByRole("combobox", { name: "Video framing" }),
	).toBeDisabled();
	textTab();
	expect(
		screen.getByRole("combobox", { name: "Caption placement" }),
	).toBeDisabled();
	expect(screen.getByLabelText("Caption background color")).toBeDisabled();
	expect(
		screen.getByRole("slider", { name: "Caption background opacity (%)" }),
	).toBeDisabled();
});

it("keeps compact visible tabs and full accessible names without editing the document", () => {
	const { changed } = tree();
	expect(screen.getByRole("button", { name: "Audio" })).toHaveTextContent(
		"Audio",
	);
	expect(
		screen.getByRole("button", { name: "Audio" }),
	).toHaveAccessibleDescription("Music & sound");
	expect(
		screen.getByRole("button", { name: "Captions & titles" }),
	).toHaveTextContent("Captions");
	textTab();
	expect(
		screen.getByRole("button", { name: "Captions & titles" }),
	).toHaveAttribute("aria-pressed", "true");
	expect(changed).not.toHaveBeenCalled();
});

it("offers word-timing help once for the caption section without altering captions", () => {
	const { document } = fixture();
	const first = document.captions?.[0];
	if (!first) throw Error("Missing caption");
	document.captions?.push({
		...first,
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		fromFrame: 30,
		toFrame: 60,
		words: undefined,
	});
	const { changed } = tree(document);
	textTab();
	expect(
		screen.queryByText(/Measured word times control highlighting/),
	).not.toBeInTheDocument();
	const help = screen.getAllByRole("button", {
		name: "Word timing — more information",
	});
	expect(help).toHaveLength(1);
	const trigger = help[0];
	if (!trigger) throw Error("Missing word-timing help");
	fireEvent.click(trigger);
	const note = screen.getByRole("note");
	expect(
		within(note).getByText(/Changing the caption text clears its word times/),
	).toBeVisible();
	expect(changed).not.toHaveBeenCalled();
	expect(documentValue().captions).toEqual(document.captions);
});

it("passes AUTO to the document presentation while preserving saved crop windows and keys", () => {
	const { document } = fixture();
	const clip = document.clips[0];
	if (!clip) throw Error("Missing fixture clip");
	const rect = { x: 0.2, y: 0.1, w: 0.4, h: 0.8 };
	clip.framing = [
		{ fromFrame: 0, toFrame: 30, mode: "CROP", origin: "MANUAL", rect },
		{
			fromFrame: 30,
			toFrame: clip.durationFrames,
			mode: "FIT",
			origin: "MANUAL",
		},
	];
	clip.cropKeyframes = [
		{ frame: 0, rect, easing: "LINEAR" },
		{ frame: 29, rect: { ...rect, x: 0.3 }, easing: "SMOOTH" },
	];
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
	};
	const clips = structuredClone(document.clips);
	const { changed } = tree(document);
	fireEvent.change(screen.getByRole("combobox", { name: "Video framing" }), {
		target: { value: "AUTO" },
	});
	expect(changed).toHaveBeenCalledOnce();
	expect(documentValue().presentation).toMatchObject({
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
	});
	expect(documentValue().clips).toEqual(clips);
	const help = screen.getByRole("button", {
		name: "Video framing — more information",
	});
	fireEvent.click(help);
	expect(screen.getByRole("note")).toHaveTextContent(
		"Use saved framing and measured subject tracks.",
	);
	expect(screen.getByRole("note")).toHaveTextContent(
		"Show the full image with a blurred background where neither is available.",
	);
	expect(changed).toHaveBeenCalledOnce();
	expect(documentValue().clips).toEqual(clips);
	fireEvent.click(help);
	textTab();
	fireEvent.change(
		screen.getByRole("combobox", { name: "Caption placement" }),
		{ target: { value: "BANDS" } },
	);
	expect(documentValue().presentation).toMatchObject({
		videoFit: "AUTO",
		captionPlacement: "BANDS",
	});
	expect(documentValue().clips).toEqual(clips);
});

it.each([
	{ locale: "en" as const, visible: "Audio", description: "Music & sound" },
	{ locale: "ja" as const, visible: "音声", description: "音楽・音量" },
])("includes the visible audio tab text in its accessible name ($locale)", ({
	locale,
	visible,
	description,
}) => {
	tree(undefined, false, locale);
	const tab = screen.getByRole("button", { name: visible });
	expect(tab).toHaveTextContent(visible);
	expect(tab).toHaveAccessibleDescription(description);
});

it.each([
	{
		locale: "en" as const,
		auto: "Full image + blurred background",
		fill: "Crop to fill",
		fit: "Full image + black bars",
		video: "Video framing",
		help: "Video framing — more information",
		foreground: "Automatic framing keeps the full source image.",
	},
	{
		locale: "ja" as const,
		auto: "全体表示＋ぼかし背景",
		fill: "切り抜いて画面いっぱい",
		fit: "全体表示＋黒帯",
		video: "映像の収め方",
		help: "「映像の収め方」の説明",
		foreground: "自動の構図は切り抜かず、元映像全体を表示します。",
	},
])("keeps protected AUTO distinct from legacy AUTO without editing clips when help opens ($locale)", (copy) => {
	const { document } = fixture();
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		fallbackFraming: "PRESERVE_SOURCE_V1",
		captionPlacement: "OVERLAY",
	};
	const clips = structuredClone(document.clips),
		{ changed } = tree(document, false, copy.locale);
	expect(screen.getByRole("option", { name: copy.auto })).toHaveValue("AUTO");
	expect(screen.getByRole("option", { name: copy.fill })).toHaveValue("FILL");
	expect(screen.getByRole("option", { name: copy.fit })).toHaveValue("FIT");
	fireEvent.click(screen.getByRole("button", { name: copy.help }));
	expect(screen.getByRole("note")).toHaveTextContent(copy.foreground);
	expect(changed).not.toHaveBeenCalled();
	expect(documentValue().clips).toEqual(clips);
	fireEvent.click(screen.getByRole("button", { name: copy.help }));
	fireEvent.change(screen.getByRole("combobox", { name: copy.video }), {
		target: { value: "FILL" },
	});
	expect(documentValue().presentation).toMatchObject({
		videoFit: "FILL",
		fallbackFraming: "PRESERVE_SOURCE_V1",
	});
	expect(documentValue().clips).toEqual(clips);
});
