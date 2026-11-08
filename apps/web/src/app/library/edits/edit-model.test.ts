import {
	type CfrTimeMap,
	compileEditDocument,
	type EditDocument,
	editingDocumentSchema,
	normalizeSceneAnalysis,
	type RenderRecipe,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	changeClipRange,
	clipOutUs,
	mergeShotFramingSuggestions,
	moveClip,
	removeClip,
	shotFramingForClip,
	splitClip,
} from "./edit-model";

const id = "11111111-1111-4111-8111-111111111111";
function first<T>(items: readonly T[]): T {
	const item = items[0];
	if (item === undefined) throw new Error("Missing test fixture element");
	return item;
}
const clip = (clipId: string, start = 0) => ({
	id: clipId,
	sourceInUs: 0,
	durationFrames: 300,
	timelineStartFrame: start,
	framing: [
		{
			fromFrame: 0,
			toFrame: 300,
			mode: "FIT" as const,
			origin: "MANUAL" as const,
		},
	],
	audio: { mode: "SOURCE" as const },
});
const fixture = (): EditDocument => ({
	schemaVersion: 1,
	mediaVersionId: id,
	analysisRevisionId: null,
	locale: "ja",
	sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
	timeMapId: id,
	canvas: { width: 1080, height: 1920 },
	fps: { num: 30, den: 1 },
	clips: [clip(id), clip("22222222-2222-4222-8222-222222222222", 300)],
});

describe("editing controls preserve source times", () => {
	it.each([
		0, 42_000_000,
	])("aligns exact CFR shot times without a one-frame flash at origin %i", (origin) => {
		const cuts = [0, 164, 281, 569, 741, 831, 900];
		const shots = cuts.slice(0, -1).map((from, index) => ({
			startInSeconds: origin / 1_000_000 + from / 30,
			endInSeconds: origin / 1_000_000 + (cuts[index + 1] ?? 900) / 30,
			mainSubjects: [{ centerX: 20 + index * 10, centerY: 50 }],
		}));
		const geometry = {
			sourceWidth: 1280,
			sourceHeight: 720,
			targetWidth: 1080,
			targetHeight: 1920,
		};
		const sourceClip = {
			...clip(id),
			sourceInUs: origin,
			durationFrames: 900,
			framing: [
				{
					fromFrame: 0,
					toFrame: 900,
					mode: "FIT" as const,
					origin: "MANUAL" as const,
				},
			],
		};
		const whole = shotFramingForClip(sourceClip, shots, geometry, true, origin);
		expect(whole.map((part) => part.fromFrame)).toEqual(cuts.slice(0, -1));
		expect(whole.map((part) => part.toFrame)).toEqual(cuts.slice(1));
		for (const [index, shot] of shots.entries()) {
			const from = cuts[index] ?? 0;
			const duration = (cuts[index + 1] ?? 900) - from;
			const own = shotFramingForClip(
				{
					...sourceClip,
					sourceInUs: origin + Math.round((from * 1_000_000) / 30),
					durationFrames: duration,
					framing: [
						{ fromFrame: 0, toFrame: duration, mode: "FIT", origin: "MANUAL" },
					],
				},
				[shot],
				geometry,
				true,
				origin,
			);
			expect(own).toHaveLength(1);
			expect(own[0]).toMatchObject({
				fromFrame: 0,
				toFrame: duration,
				mode: "CROP",
			});
		}
	});

	it.each([
		{ delta: -1e-8, expected: 164 },
		{ delta: 0, expected: 164 },
		{ delta: 1e-8, expected: 165 },
	])("keeps sub-microsecond shot precision before ceiling: $delta", ({
		delta,
		expected,
	}) => {
		const sourceClip = {
			...clip(id),
			durationFrames: 600,
			framing: [
				{
					fromFrame: 0,
					toFrame: 600,
					mode: "FIT" as const,
					origin: "MANUAL" as const,
				},
			],
		};
		const result = shotFramingForClip(
			sourceClip,
			[
				{
					startInSeconds: 164 / 30 + delta,
					endInSeconds: 10,
					mainSubjects: [{ centerX: 20, centerY: 50 }],
				},
			],
			{
				sourceWidth: 1280,
				sourceHeight: 720,
				targetWidth: 1080,
				targetHeight: 1920,
			},
			true,
		);
		expect(result.find((part) => part.mode === "CROP")?.fromFrame).toBe(
			expected,
		);
	});
	it("carries normalized subject sizes into per-shot framing and the saved render recipe", () => {
		const analysis = normalizeSceneAnalysis({
			metadata: { version: "manual-box-test" },
			duration: 10,
			scenes: [
				{
					id,
					startInSeconds: 0,
					endInSeconds: 10,
					shots: [
						{
							startInSeconds: 0,
							endInSeconds: 5,
							mainSubjects: [
								{
									classification: "Llama",
									description: "Small subject on the left",
									appearanceTimeInSeconds: 0,
									centerX: 15,
									centerY: 50,
									box2d: [400, 100, 600, 200],
								},
							],
						},
						{
							startInSeconds: 5,
							endInSeconds: 10,
							mainSubjects: [
								{
									classification: "Llama",
									description: "Larger subject on the right",
									appearanceTimeInSeconds: 0,
									centerX: 70,
									centerY: 50,
									box2d: [100, 600, 900, 800],
								},
							],
						},
					],
				},
			],
		});
		const input = fixture();
		input.analysisRevisionId = id;
		const firstClip = clip(id);
		const proposals = shotFramingForClip(
			firstClip,
			first(analysis.scenes).shots,
			{
				sourceWidth: 1920,
				sourceHeight: 1080,
				targetWidth: 1080,
				targetHeight: 1920,
			},
			true,
		);
		expect(proposals).toHaveLength(2);
		const [left, right] = proposals;
		if (left?.mode !== "CROP" || right?.mode !== "CROP")
			throw new Error("Expected box-based crop proposals");
		expect(left.toFrame).toBe(150);
		expect(right.fromFrame).toBe(150);
		expect(left.rect.h).toBeLessThan(right.rect.h);
		expect(left.rect.x).toBeLessThan(right.rect.x);
		input.clips = [
			{
				...firstClip,
				framing: proposals.map((part) => ({
					...part,
					origin: "EDITOR_CONFIRMED",
				})),
			},
		];
		const saved = editingDocumentSchema.parse(
			JSON.parse(JSON.stringify(input)),
		);
		const recipe = compileEditDocument(saved, {
			id,
			mediaVersionId: id,
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 10_000_000,
			editingStartFrame: 0,
			editingEndFrame: 300,
			fps: { num: 30, den: 1 },
		});
		expect(recipe.segments.map((segment) => segment.framing)).toEqual([
			{ mode: "CROP", rect: left.rect },
			{ mode: "CROP", rect: right.rect },
		]);
	});
	it("keeps explicit manual fit through serialization, re-proposal, and split", () => {
		const input = fixture();
		input.clips = [
			{
				...clip(id),
				framing: [
					{
						fromFrame: 0,
						toFrame: 300,
						mode: "FIT",
						origin: "MANUAL",
						manualOverride: true,
					},
				],
			},
		];
		const saved = editingDocumentSchema.parse(
			JSON.parse(JSON.stringify(input)),
		);
		const proposed = shotFramingForClip(
			first(saved.clips),
			[
				{
					startInSeconds: 0,
					endInSeconds: 10,
					mainSubjects: [{ centerX: 80, centerY: 50 }],
				},
			],
			{
				sourceWidth: 1920,
				sourceHeight: 1080,
				targetWidth: 1080,
				targetHeight: 1920,
			},
			true,
		);
		expect(proposed).toEqual(first(saved.clips).framing);
		const map: CfrTimeMap = {
			id,
			mediaVersionId: id,
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 10_000_000,
			editingStartFrame: 0,
			editingEndFrame: 300,
			fps: { num: 30, den: 1 },
		};
		const split = splitClip(
			saved,
			0,
			123,
			"33333333-3333-4333-8333-333333333333",
			map,
		);
		expect(
			split.clips.every((part) =>
				part.framing.every(
					(frame) => frame.manualOverride === true && frame.mode === "FIT",
				),
			),
		).toBe(true);
	});
	it.each([
		0, 42_000_000,
	])("places non-aligned shot starts on the shared source grid at %i us", (sourceStartUs) => {
		const input = fixture();
		const selected = {
			...clip(id),
			sourceInUs: sourceStartUs + 1_250_000,
			durationFrames: 30,
			framing: [
				{
					fromFrame: 0,
					toFrame: 30,
					mode: "FIT" as const,
					origin: "MANUAL" as const,
				},
			],
		};
		const framing = shotFramingForClip(
			selected,
			[
				{
					startInSeconds: sourceStartUs / 1_000_000 + 1.27,
					endInSeconds: sourceStartUs / 1_000_000 + 1.37,
					mainSubjects: [{ centerX: 70, centerY: 50 }],
				},
			],
			{
				sourceWidth: 1920,
				sourceHeight: 1080,
				targetWidth: 1080,
				targetHeight: 1920,
			},
			true,
			sourceStartUs,
		);
		expect(framing.find((part) => part.mode === "CROP")).toMatchObject({
			fromFrame: 2,
			toFrame: 5,
		});
		input.clips = [
			{
				...selected,
				framing: framing.map((part) => ({
					...part,
					origin: "EDITOR_CONFIRMED",
				})),
			},
		];
		const recipe = compileEditDocument(input, {
			id,
			mediaVersionId: id,
			kind: "CFR",
			sourceStartUs,
			sourceEndUs: sourceStartUs + 20_000_000,
			editingStartFrame: 90,
			editingEndFrame: 690,
			fps: { num: 30, den: 1 },
		});
		expect(
			recipe.segments.find((part) => part.framing.mode === "CROP"),
		).toMatchObject({ editingStartFrame: 129, editingEndFrame: 132 });
	});
	it("reflows the output when clips move or are removed without changing source ranges", () => {
		const input = fixture();
		input.clips[1] = {
			...clip("22222222-2222-4222-8222-222222222222", 300),
			sourceInUs: 30_000_000,
			durationFrames: 180,
			framing: [{ fromFrame: 0, toFrame: 180, mode: "FIT", origin: "MANUAL" }],
		};
		const result = moveClip(input, 1, -1);
		expect(
			result.clips.map((x) => [x.sourceInUs, x.timelineStartFrame]),
		).toEqual([
			[30_000_000, 0],
			[0, 180],
		]);
		expect(input.clips[1]?.timelineStartFrame).toBe(300);
		expect(removeClip(result, 0).clips[0]?.timelineStartFrame).toBe(0);
	});
	it("snaps a requested range down and resets framing explicitly", () => {
		const result = changeClipRange(fixture(), 0, 1.25, 4.76, 60_000_000);
		expect(result.clips[0]).toMatchObject({
			sourceInUs: 1_233_334,
			durationFrames: 105,
			framing: [{ fromFrame: 0, toFrame: 105, mode: "FIT", origin: "MANUAL" }],
		});
		expect(result.clips[1]?.timelineStartFrame).toBe(105);
		expect(() => changeClipRange(fixture(), 0, 4, 3, 60_000_000)).toThrow();
		expect(() => changeClipRange(fixture(), 0, 0, 61, 60_000_000)).toThrow();
		const reapplied = changeClipRange(
			result,
			0,
			first(result.clips).sourceInUs / 1_000_000,
			clipOutUs(first(result.clips)) / 1_000_000,
			60_000_000,
		);
		expect(reapplied).toEqual(result);
	});
	it("covers shot gaps and ambiguous subjects with fit proposals", () => {
		const input = clip(id);
		const framing = shotFramingForClip(
			input,
			[
				{
					startInSeconds: 2,
					endInSeconds: 4,
					mainSubjects: [{ centerX: 70, centerY: 50 }],
				},
				{
					startInSeconds: 4,
					endInSeconds: 8,
					mainSubjects: [
						{ centerX: 20, centerY: 50 },
						{ centerX: 70, centerY: 50 },
					],
				},
			],
			{
				sourceWidth: 1920,
				sourceHeight: 1080,
				targetWidth: 1080,
				targetHeight: 1920,
			},
			true,
		);
		expect(framing.map((x) => [x.fromFrame, x.toFrame, x.mode])).toEqual([
			[0, 60, "FIT"],
			[60, 120, "CROP"],
			[120, 240, "FIT"],
			[240, 300, "FIT"],
		]);
		expect(framing.every((x) => x.origin === "AISA_PROPOSAL")).toBe(true);
	});
	it("preserves a manual crop when shot framing is proposed again", () => {
		const input = {
			...clip(id),
			framing: [
				{
					fromFrame: 0,
					toFrame: 300,
					mode: "CROP" as const,
					origin: "MANUAL" as const,
					rect: { x: 0.2, y: 0, w: 0.3, h: 1 },
				},
			],
		};
		const result = shotFramingForClip(
			input,
			[
				{
					startInSeconds: 2,
					endInSeconds: 8,
					mainSubjects: [{ centerX: 80, centerY: 50 }],
				},
			],
			{
				sourceWidth: 1920,
				sourceHeight: 1080,
				targetWidth: 1080,
				targetHeight: 1920,
			},
			true,
		);
		expect(result).toEqual(input.framing);
	});
	it("preserves confirmed fit and crop framing when proposals change", () => {
		const input = {
			...clip(id),
			framing: [
				{
					fromFrame: 0,
					toFrame: 120,
					mode: "FIT" as const,
					origin: "EDITOR_CONFIRMED" as const,
				},
				{
					fromFrame: 120,
					toFrame: 300,
					mode: "CROP" as const,
					origin: "EDITOR_CONFIRMED" as const,
					rect: { x: 0.1, y: 0, w: 0.3, h: 1 },
				},
			],
		};
		const result = shotFramingForClip(
			input,
			[
				{
					startInSeconds: 1,
					endInSeconds: 9,
					mainSubjects: [{ centerX: 80, centerY: 50 }],
				},
			],
			{
				sourceWidth: 1920,
				sourceHeight: 1080,
				targetWidth: 1080,
				targetHeight: 1920,
			},
			true,
		);
		expect(result).toEqual(input.framing);
	});
	it("merges proposals into unadjusted ranges without crossing protected framing", () => {
		const protectedCrop = {
			fromFrame: 0,
			toFrame: 150,
			mode: "CROP" as const,
			origin: "MANUAL" as const,
			rect: { x: 0.2, y: 0, w: 0.3, h: 1 },
		};
		const input = {
			...clip(id),
			framing: [
				protectedCrop,
				{
					fromFrame: 150,
					toFrame: 300,
					mode: "FIT" as const,
					origin: "MANUAL" as const,
				},
			],
		};
		const proposals = [
			{
				fromFrame: 0,
				toFrame: 60,
				mode: "FIT" as const,
				origin: "AISA_PROPOSAL" as const,
			},
			{
				fromFrame: 60,
				toFrame: 240,
				mode: "CROP" as const,
				origin: "AISA_PROPOSAL" as const,
				rect: { x: 0.6, y: 0, w: 0.3, h: 1 },
			},
			{
				fromFrame: 240,
				toFrame: 300,
				mode: "FIT" as const,
				origin: "AISA_PROPOSAL" as const,
			},
		];
		expect(mergeShotFramingSuggestions(input, proposals)).toEqual([
			protectedCrop,
			{ ...proposals[1], fromFrame: 150 },
			proposals[2],
		]);
		expect(input.framing[1]?.origin).toBe("MANUAL");
	});
	it("splits at a material frame without repeating or dropping source frames", () => {
		const map: CfrTimeMap = {
			id,
			mediaVersionId: id,
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 20_000_000,
			editingStartFrame: 0,
			editingEndFrame: 600,
			fps: { num: 30, den: 1 },
		};
		const frameCoverage = (recipe: RenderRecipe) =>
			recipe.segments.flatMap((segment) =>
				Array.from(
					{ length: segment.durationFrames },
					(_, offset) => segment.editingStartFrame + offset,
				),
			);
		for (const sourceInUs of [0, 33_333, 33_334, 1_250_000]) {
			const input = fixture();
			input.clips = [
				{
					...clip(id),
					sourceInUs,
					durationFrames: 7,
					framing: [
						{ fromFrame: 0, toFrame: 7, mode: "FIT", origin: "MANUAL" },
					],
				},
			];
			for (let atFrame = 1; atFrame < 7; atFrame++) {
				const result = splitClip(
					input,
					0,
					atFrame,
					"33333333-3333-4333-8333-333333333333",
					map,
				);
				expect(result.clips.map((part) => part.durationFrames)).toEqual([
					atFrame,
					7 - atFrame,
				]);
				expect(frameCoverage(compileEditDocument(result, map))).toEqual(
					frameCoverage(compileEditDocument(input, map)),
				);
			}
		}
	});
	it("preserves audio and protected crop framing across a split at the material end", () => {
		const input = fixture();
		input.clips = [
			{
				...clip(id),
				durationFrames: 3,
				audio: { mode: "MUTE" },
				framing: [
					{
						fromFrame: 0,
						toFrame: 2,
						mode: "CROP",
						origin: "EDITOR_CONFIRMED",
						rect: { x: 0.2, y: 0, w: 0.3, h: 1 },
					},
					{ fromFrame: 2, toFrame: 3, mode: "FIT", origin: "MANUAL" },
				],
			},
		];
		const map: CfrTimeMap = {
			id,
			mediaVersionId: id,
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 100_000,
			editingStartFrame: 0,
			editingEndFrame: 3,
			fps: { num: 30, den: 1 },
		};
		const result = splitClip(
			input,
			0,
			1,
			"33333333-3333-4333-8333-333333333333",
			map,
		);
		expect(result.clips[1]).toMatchObject({
			sourceInUs: 33_334,
			timelineStartFrame: 1,
			durationFrames: 2,
			audio: { mode: "MUTE" },
			framing: [
				{
					fromFrame: 0,
					toFrame: 1,
					mode: "CROP",
					origin: "EDITOR_CONFIRMED",
					rect: { x: 0.2, y: 0, w: 0.3, h: 1 },
				},
				{ fromFrame: 1, toFrame: 2, mode: "FIT", origin: "MANUAL" },
			],
		});
		expect(compileEditDocument(result, map).durationFrames).toBe(3);
		expect(clipOutUs(first(result.clips.slice(1)))).toBe(100_000);
		for (const atFrame of [0, 3, 1.5])
			expect(() =>
				splitClip(
					input,
					0,
					atFrame,
					"33333333-3333-4333-8333-333333333333",
					map,
				),
			).toThrow();
	});
});
