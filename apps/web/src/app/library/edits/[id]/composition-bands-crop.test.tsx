import {
	type CompositionDocument,
	type CompositionSourceFacts,
	compileComposition,
	evaluateCompositionFrame,
	resolveCompositionGeometry,
	suggestFixedCrop,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionInspector } from "./composition-inspector";

function fixture() {
	const project = editingProjectFixture();
	if (!project.media.timeMap) throw new Error("Missing fixture map");
	const document = toCompositionDocument(project.draft);
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "BANDS",
	};
	const source: CompositionSourceFacts = {
		mediaVersionId: project.media.id,
		timeMap: project.media.timeMap,
		width: 1920,
		height: 1080,
		hasAudio: true,
	};
	return { project, document, source };
}
function tree(initial: CompositionDocument) {
	const { project, source } = fixture();
	function Controlled() {
		const [document, setDocument] = useState(initial),
			[frame, setFrame] = useState(0);
		const plan = compileComposition(document, [source], {
			allowUnconfirmed: true,
		});
		const layer = evaluateCompositionFrame(plan, frame).layers[0];
		const small = evaluateCompositionFrame(plan, frame, {
			width: 360,
			height: 640,
		}).layers[0];
		return (
			<>
				<button type="button" onClick={() => setFrame(75)}>
					Move playhead to frame 75
				</button>
				<CompositionInspector
					document={document}
					sources={[source]}
					catalog={[{ ...project.media, facts: source }]}
					selectedId={document.clips[0]?.id ?? ""}
					frame={frame}
					disabled={false}
					onChange={(next) => {
						compileComposition(next, [source], { allowUnconfirmed: true });
						setDocument(next);
					}}
					onSelect={() => {}}
					onError={() => {
						throw new Error("Invalid edit");
					}}
					onUpload={async () => {}}
				/>
				<output aria-label="Saved crop document">
					{JSON.stringify(document)}
				</output>
				<output aria-label="Rendered crop layer">
					{JSON.stringify(layer)}
				</output>
				<output aria-label="Preview source rectangle">
					{JSON.stringify(small?.sourceRect)}
				</output>
			</>
		);
	}
	renderLocalized(<Controlled />);
}
function documentValue() {
	return JSON.parse(
		screen.getByLabelText("Saved crop document").textContent ?? "null",
	) as CompositionDocument;
}
function layerValue() {
	const { document, source } = fixture();
	type Layer = ReturnType<typeof evaluateCompositionFrame>["layers"][number];
	const layer = JSON.parse(
		screen.getByLabelText("Rendered crop layer").textContent ?? "null",
	) as Layer;
	if (!layer.cropRect) throw new Error("Expected visible crop");
	const maximum = suggestFixedCrop({
		sourceWidth: source.width,
		sourceHeight: source.height,
		targetWidth: layer.layoutRect.w,
		targetHeight: layer.layoutRect.h,
		centerX: layer.cropRect.x + layer.cropRect.w / 2,
		centerY: layer.cropRect.y + layer.cropRect.h / 2,
	});
	return {
		...layer,
		cropRect: layer.cropRect,
		zoom: maximum.w / layer.cropRect.w,
		canvas: document.canvas,
	};
}
const zoomControl = () => screen.getByRole("slider", { name: "Crop zoom" });
function overlay() {
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	fireEvent.change(
		screen.getByRole("combobox", { name: "Caption placement" }),
		{ target: { value: "OVERLAY" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "Video" }));
}
it.each([
	1.2, 2, 3,
])("keeps BANDS zoom %s on redraw and saves the original-canvas crop for an overlay return", (zoom) => {
	const { document, source } = fixture();
	tree(document);
	fireEvent.change(zoomControl(), { target: { value: String(zoom) } });
	expect(Number((zoomControl() as HTMLInputElement).value)).toBeCloseTo(
		zoom,
		10,
	);
	const saved = documentValue(),
		clip = saved.clips[0],
		part = clip?.framing[0];
	if (part?.mode !== "CROP") throw new Error("Expected saved canonical crop");
	const original = suggestFixedCrop({
		sourceWidth: source.width,
		sourceHeight: source.height,
		targetWidth: document.canvas.width,
		targetHeight: document.canvas.height,
		centerX: 0.5,
		centerY: 0.5,
		zoom,
	});
	// New manual crops use decimal storage precision; existing saved keys stay intact.
	const expected =
		zoom === 1.2
			? {
					x: 0.3681640625,
					y: 0.083333333333,
					w: 0.263671875,
					h: 0.833333333333,
				}
			: zoom === 2
				? { x: 0.4208984375, y: 0.25, w: 0.158203125, h: 0.5 }
				: {
						x: 0.447265625,
						y: 0.333333333333,
						w: 0.10546875,
						h: 0.333333333333,
					};
	const sourcePixels = (rect: typeof original) =>
		resolveCompositionGeometry({
			sourceWidth: source.width,
			sourceHeight: source.height,
			width: document.canvas.width,
			height: document.canvas.height,
			frame: 0,
			framing: { mode: "CROP", rect },
		}).sourceRect;
	expect(sourcePixels(part.rect)).toEqual(sourcePixels(original));
	expect(part.rect).toEqual(expected);
	expect(clip?.videoFit).toBe("FILL");
	expect(layerValue().layoutRect).toEqual({ x: 0, y: 346, w: 1080, h: 1228 });
	expect(layerValue().zoom).toBeCloseTo(zoom, 10);
	expect(
		JSON.parse(
			screen.getByLabelText("Preview source rectangle").textContent ?? "null",
		),
	).toEqual(layerValue().sourceRect);
	overlay();
	expect(documentValue().clips).toEqual(saved.clips);
	expect(Number((zoomControl() as HTMLInputElement).value)).toBeCloseTo(
		zoom,
		10,
	);
	expect(layerValue().cropRect).toEqual(expected);
});
it("keeps existing canonical keys when zooming and moving the subject inside BANDS", () => {
	const { document, source } = fixture(),
		clip = document.clips[0];
	if (!clip) throw new Error("Missing fixture clip");
	const canonical = (centerX: number, zoom: number) =>
		suggestFixedCrop({
			sourceWidth: source.width,
			sourceHeight: source.height,
			targetWidth: document.canvas.width,
			targetHeight: document.canvas.height,
			centerX,
			centerY: 0.5,
			zoom,
		});
	const first = {
			frame: 0,
			rect: canonical(0.4, 1.5),
			easing: "LINEAR" as const,
		},
		last = { frame: 150, rect: canonical(0.6, 2.5), easing: "SMOOTH" as const };
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: 300,
			mode: "CROP",
			origin: "MANUAL",
			rect: first.rect,
		},
	];
	clip.cropKeyframes = [first, last];
	tree(document);
	fireEvent.click(
		screen.getByRole("button", { name: "Move playhead to frame 75" }),
	);
	fireEvent.change(zoomControl(), { target: { value: "2" } });
	expect(Number((zoomControl() as HTMLInputElement).value)).toBeCloseTo(2, 10);
	expect(layerValue().zoom).toBeCloseTo(2, 10);
	fireEvent.change(
		screen.getByRole("slider", { name: "Subject horizontal position" }),
		{ target: { value: "0.62" } },
	);
	const expected = canonical(0.62, 2),
		saved = documentValue(),
		keys = saved.clips[0]?.cropKeyframes;
	expect(keys?.map((key) => key.frame)).toEqual([0, 75, 150]);
	expect(keys?.[0]).toEqual(first);
	expect(keys?.[2]).toEqual(last);
	expect(keys?.[1]?.rect).toEqual(expected);
	expect(layerValue().zoom).toBeCloseTo(2, 10);
	overlay();
	expect(documentValue().clips).toEqual(saved.clips);
	expect(layerValue().cropRect).toEqual(expected);
	const plan = compileComposition(documentValue(), [source], {
		allowUnconfirmed: true,
	});
	expect(evaluateCompositionFrame(plan, 0).layers[0]?.cropRect).toEqual(
		first.rect,
	);
	expect(evaluateCompositionFrame(plan, 150).layers[0]?.cropRect).toEqual(
		last.rect,
	);
});
