import {
	compileComposition,
	evaluateCompositionFrame,
	toCompositionDocument,
} from "@bitovp/core";
import { expect, it } from "vitest";
import { editingProjectFixture } from "../editing-fixtures";
import { paintCompositionFrame } from "./composition-preview";

/** Independent one-pixel premultiplied compositor for constant-color crossfade invariants. */
class PixelCanvas {
	width = 16;
	height = 9;
	pixel = [0, 0, 0, 0];
	globalAlpha = 1;
	globalCompositeOperation = "source-over";
	fillStyle = "black";
	clearRect() {
		this.pixel = [0, 0, 0, 0];
	}
	fillRect() {
		this.blend([0, 0, 0, 1]);
	}
	drawImage(source: { pixel: number[] }) {
		this.blend(source.pixel);
	}
	blend(source: number[]) {
		const alpha = (source[3] ?? 0) * this.globalAlpha;
		this.pixel = this.pixel.map((value, index) =>
			Math.min(
				1,
				(source[index] ?? 0) * this.globalAlpha +
					value * (this.globalCompositeOperation === "lighter" ? 1 : 1 - alpha),
			),
		);
	}
	getContext() {
		return this;
	}
}

it("keeps a constant white image white through a crossfade, and applies user opacity once", () => {
	const project = editingProjectFixture();
	if (!project.media.timeMap) throw new Error("Missing time map");
	const document = toCompositionDocument(project.draft),
		clip = document.clips[0];
	if (!clip) throw new Error("Missing clip");
	document.canvas = { width: 1920, height: 1080 };
	const secondId = "88888888-8888-4888-8888-888888888888";
	document.clips = [
		{
			...clip,
			durationFrames: 30,
			framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
		},
		{
			...clip,
			id: secondId,
			timelineStartFrame: 19,
			durationFrames: 30,
			transitionIn: { type: "CROSSFADE", durationFrames: 11 },
			framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
		},
	];
	const sources = [
		{
			mediaVersionId: document.mediaVersionId,
			timeMap: project.media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
	];
	const videos = new Map(
		document.clips.map((item) => [
			item.id,
			{ readyState: 2, pixel: [1, 1, 1, 1] } as unknown as HTMLVideoElement,
		]),
	);
	for (const opacity of [1, 0.5]) {
		const plan = compileComposition(
			{
				...document,
				clips: document.clips.map((item) => ({ ...item, opacity })),
			},
			sources,
		);
		for (const frame of [19, 24, 29]) {
			const output = new PixelCanvas(),
				track = new PixelCanvas(),
				layer = new PixelCanvas();
			paintCompositionFrame(
				output as unknown as CanvasRenderingContext2D,
				evaluateCompositionFrame(plan, frame, { width: 16, height: 9 }),
				videos,
				new Map(),
				track as unknown as HTMLCanvasElement,
				layer as unknown as HTMLCanvasElement,
			);
			expect(output.pixel.slice(0, 3)).toEqual([opacity, opacity, opacity]);
		}
	}
});

class TextPixelCanvas extends PixelCanvas {
	save() {}
	restore() {}
	beginPath() {}
	rect() {}
	clip() {}
	measureText(text: string) {
		return { width: text.length };
	}
	fillText(text: string, x: number) {
		if (!text.length || Math.floor(x) !== 0) return;
		const color = this.fillStyle,
			rgba = color.startsWith("#")
				? [
						Number.parseInt(color.slice(1, 3), 16) / 255,
						Number.parseInt(color.slice(3, 5), 16) / 255,
						Number.parseInt(color.slice(5, 7), 16) / 255,
						color.length === 9
							? Number.parseInt(color.slice(7, 9), 16) / 255
							: 1,
					]
				: [0, 0, 0, 1];
		const alpha = rgba[3] ?? 0;
		this.blend([
			(rgba[0] ?? 0) * alpha,
			(rgba[1] ?? 0) * alpha,
			(rgba[2] ?? 0) * alpha,
			alpha,
		]);
	}
}
it.each([
	"00",
	"80",
])("paints an active word once with its own %s alpha, over the caption background", (alpha) => {
	const project = editingProjectFixture();
	if (!project.media.timeMap) throw new Error("Missing map");
	const document = toCompositionDocument(project.draft);
	document.canvas = { width: 1920, height: 1080 };
	document.captionLayout = { x: 0, y: 0, w: 1, h: 1 };
	document.captionStyle = { align: "LEFT", emphasisColor: `#FFE04B${alpha}` };
	document.captions = [
		{
			id: "99999999-9999-4999-8999-999999999998",
			text: "AA BB",
			fromFrame: 0,
			toFrame: 30,
			words: [
				{ text: "AA", startChar: 0, endChar: 2, fromFrame: 0, toFrame: 15 },
			],
		},
	];
	const plan = compileComposition(document, [
		{
			mediaVersionId: document.mediaVersionId,
			timeMap: project.media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
	]);
	const output = new TextPixelCanvas();
	paintCompositionFrame(
		output as unknown as CanvasRenderingContext2D,
		evaluateCompositionFrame(plan, 0, { width: 16, height: 9 }),
		new Map(),
		new Map(),
		new PixelCanvas() as unknown as HTMLCanvasElement,
		new PixelCanvas() as unknown as HTMLCanvasElement,
	);
	const a = Number.parseInt(alpha, 16) / 255;
	expect(output.pixel[0]).toBeCloseTo(a);
	expect(output.pixel[1]).toBeCloseTo((224 / 255) * a);
	expect(output.pixel[2]).toBeCloseTo((75 / 255) * a);
});
