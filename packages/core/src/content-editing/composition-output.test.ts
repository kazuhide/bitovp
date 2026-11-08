import { expect, it } from "vitest";
import {
	compositionDurationFrames,
	compositionRenderCanvas,
} from "./composition-frame";
import { compositionFixture } from "./composition-test-fixtures";

it("keeps each accepted output aspect in preview and export", () => {
	for (const canvas of [
		{ width: 1920, height: 1080 },
		{ width: 1080, height: 1920 },
		{ width: 1080, height: 1080 },
		{ width: 1080, height: 1350 },
	]) {
		expect(compositionRenderCanvas(canvas, "EXPORT")).toEqual(canvas);
		const preview = compositionRenderCanvas(canvas, "PREVIEW");
		expect(Math.max(preview.width, preview.height)).toBe(640);
		expect(preview.width * canvas.height).toBe(preview.height * canvas.width);
	}
	expect(() =>
		compositionRenderCanvas({ width: 100, height: 100 }, "EXPORT"),
	).toThrow();
});
it("counts the actual final video/audio/caption/overlay output boundary", () => {
	const { document } = compositionFixture();
	expect(compositionDurationFrames(document)).toBe(90);
	document.captions = [
		{
			id: "77777777-7777-4777-8777-777777777777",
			fromFrame: 90,
			toFrame: 120,
			text: "end",
		},
	];
	expect(compositionDurationFrames(document)).toBe(120);
});
