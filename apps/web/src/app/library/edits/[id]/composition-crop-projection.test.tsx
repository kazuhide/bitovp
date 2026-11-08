import {
	type CompositionDocument,
	type CompositionSourceFacts,
	compileComposition,
	evaluateCompositionFrame,
	type NormalizedCropRect,
	resolveCompositionGeometry,
	resolvePresentedCompositionGeometry,
	suggestFixedCrop,
	toCompositionDocument,
} from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionInspector } from "./composition-inspector";
import { stableManualCrop } from "./manual-crop";

function fixture(
	width = 1920,
	height = 614,
	placement: "OVERLAY" | "BANDS" = "BANDS",
) {
	const project = editingProjectFixture(),
		document = toCompositionDocument(project.draft);
	if (!project.media.timeMap) throw new Error("Missing fixture map");
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: placement,
	};
	const source: CompositionSourceFacts = {
		mediaVersionId: project.media.id,
		timeMap: project.media.timeMap,
		width,
		height,
		hasAudio: true,
	};
	return { project, document, source };
}
function originalCrop(
	source: Pick<CompositionSourceFacts, "width" | "height">,
	zoom: number,
) {
	return suggestFixedCrop({
		sourceWidth: source.width,
		sourceHeight: source.height,
		targetWidth: 1080,
		targetHeight: 1920,
		centerX: 0.5,
		centerY: 0.5,
		zoom,
	});
}
function canonicalPixels(
	source: Pick<CompositionSourceFacts, "width" | "height">,
	rect: NormalizedCropRect,
) {
	return resolveCompositionGeometry({
		sourceWidth: source.width,
		sourceHeight: source.height,
		width: 1080,
		height: 1920,
		frame: 0,
		framing: { mode: "CROP", rect },
	}).sourceRect;
}
function bandProjection(
	document: CompositionDocument,
	source: CompositionSourceFacts,
) {
	const first = document.clips[0];
	if (!first) throw new Error("Missing fixture clip");
	const bands = {
		...document,
		presentation: {
			...document.presentation,
			version: "portrait-layout-v1" as const,
			captionPlacement: "BANDS" as const,
		},
	};
	return (rect: NormalizedCropRect) =>
		resolvePresentedCompositionGeometry({
			document: bands,
			clip: {
				...first,
				videoFit: "FILL",
				cropKeyframes: undefined,
				framing: [
					{
						fromFrame: 0,
						toFrame: first.durationFrames,
						mode: "CROP",
						origin: "MANUAL",
						rect,
					},
				],
			},
			sourceWidth: source.width,
			sourceHeight: source.height,
			width: document.canvas.width,
			height: document.canvas.height,
			frame: 0,
		}).sourceRect;
}
it.each([
	[2, 1080, 2],
	[2, 1080, 3],
	[1920, 614, 1.44],
	[1920, 1228, 2.88],
] as const)("retains canonical and actual BANDS pixels for %ix%i zoom %s", (width, height, zoom) => {
	const { document, source } = fixture(width, height),
		original = originalCrop(source, zoom);
	const project = bandProjection(document, source);
	const expectedBands = project(original);
	if (width === 1920)
		expect(expectedBands).toEqual({
			x: 773,
			y: height === 614 ? 94 : 401,
			w: 375,
			h: 426,
		});
	else expect(expectedBands).toMatchObject({ x: 1, w: 1 });
	let attempts = 0;
	const projected = (rect: NormalizedCropRect) => {
		attempts++;
		return project(rect);
	};
	const saved = stableManualCrop(original, source, projected);
	expect(canonicalPixels(source, saved)).toEqual(
		canonicalPixels(source, original),
	);
	expect(project(saved)).toEqual(expectedBands);
	expect(stableManualCrop(saved, source, project)).toEqual(saved);
	expect(attempts).toBeGreaterThan(0);
	expect(attempts).toBeLessThanOrEqual(626);
	for (const value of Object.values(saved))
		expect(Number(value.toFixed(12))).toBe(value);
});
it("keeps the R3 TOS producer fixed point and accepts the common projection within its bounded budget", () => {
	const { document, source } = fixture(1600, 714),
		original = originalCrop(source, 1.2),
		project = bandProjection(document, source);
	let attempts = 0;
	const saved = stableManualCrop(original, source, (rect) => {
		attempts++;
		return project(rect);
	});
	expect(saved).toEqual({
		x: 0.39541015625,
		y: 0.083333333333,
		w: 0.2091796875,
		h: 0.833333333334,
	});
	expect(project(saved)).toEqual(project(original));
	expect(attempts).toBeGreaterThan(0);
	expect(attempts).toBeLessThanOrEqual(626);
});
function tree(
	initial: CompositionDocument,
	source: CompositionSourceFacts,
	frame = 0,
) {
	function Controlled() {
		const [document, setDocument] = useState(initial);
		const bands = {
			...document,
			presentation: {
				...document.presentation,
				version: "portrait-layout-v1" as const,
				captionPlacement: "BANDS" as const,
			},
		};
		const layer = evaluateCompositionFrame(
			compileComposition(bands, [source]),
			frame,
		).layers[0];
		return (
			<>
				<CompositionInspector
					document={document}
					sources={[source]}
					catalog={[]}
					selectedId={document.clips[0]?.id ?? ""}
					frame={frame}
					disabled={false}
					onChange={(next) => {
						compileComposition(next, [source]);
						setDocument(next);
					}}
					onSelect={() => {}}
					onError={() => {
						throw new Error("Invalid edit");
					}}
					onUpload={async () => {}}
				/>
				<output aria-label="Saved projection document">
					{JSON.stringify(document)}
				</output>
				<output aria-label="Projected band source pixels">
					{JSON.stringify(layer?.sourceRect)}
				</output>
			</>
		);
	}
	renderLocalized(<Controlled />);
}
function savedDocument() {
	return JSON.parse(
		screen.getByLabelText("Saved projection document").textContent ?? "null",
	) as CompositionDocument;
}
function visibleBandPixels() {
	return JSON.parse(
		screen.getByLabelText("Projected band source pixels").textContent ?? "null",
	);
}
function placement(value: "OVERLAY" | "BANDS") {
	fireEvent.click(screen.getByRole("button", { name: "Captions & titles" }));
	fireEvent.change(screen.getByLabelText("Caption placement"), {
		target: { value },
	});
	fireEvent.click(screen.getByRole("button", { name: "Video" }));
}
it.each([
	"OVERLAY",
	"BANDS",
] as const)("preserves the actual band crop for a manual edit authored in %s and later preset roundtrips", (current) => {
	const { document, source } = fixture(1920, 614, current),
		expected = bandProjection(document, source)(originalCrop(source, 1.44));
	tree(document, source);
	fireEvent.change(screen.getByRole("slider", { name: "Crop zoom" }), {
		target: { value: "1.44" },
	});
	expect(visibleBandPixels()).toEqual(expected);
	const authored = savedDocument().clips;
	placement(current === "OVERLAY" ? "BANDS" : "OVERLAY");
	expect(visibleBandPixels()).toEqual(expected);
	placement(current);
	expect(visibleBandPixels()).toEqual(expected);
	expect(savedDocument().clips).toEqual(authored);
});
it("evaluates a new key candidate without using the old animation while preserving every other key", () => {
	const { document, source } = fixture(1920, 614, "OVERLAY"),
		clip = document.clips[0];
	if (!clip) throw new Error("Missing fixture clip");
	const original = originalCrop(source, 1.2);
	const first = { frame: 0, rect: original, easing: "LINEAR" as const };
	const last = { frame: 150, rect: original, easing: "SMOOTH" as const };
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: 300,
			mode: "CROP",
			origin: "MANUAL",
			rect: original,
		},
	];
	clip.cropKeyframes = [first, last];
	const current = evaluateCompositionFrame(
		compileComposition(document, [source]),
		75,
	).layers[0]?.cropRect;
	if (!current) throw new Error("Expected current crop");
	const requested = suggestFixedCrop({
		sourceWidth: source.width,
		sourceHeight: source.height,
		targetWidth: 1080,
		targetHeight: 1920,
		centerX: current.x + current.w / 2,
		centerY: current.y + current.h / 2,
		zoom: 1.44,
	});
	const expected = bandProjection(document, source)(requested);
	tree(document, source, 75);
	fireEvent.change(screen.getByRole("slider", { name: "Crop zoom" }), {
		target: { value: "1.44" },
	});
	const keys = savedDocument().clips[0]?.cropKeyframes;
	expect(keys?.map((key) => key.frame)).toEqual([0, 75, 150]);
	expect(keys?.[0]).toEqual(first);
	expect(keys?.[2]).toEqual(last);
	expect(visibleBandPixels()).toEqual(expected);
});
