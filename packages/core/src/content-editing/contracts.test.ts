import { describe, expect, it } from "vitest";
import {
	cfrTimeMapSchema,
	compileEditDocument,
	type EditDocument,
	editingDocumentSchema,
	MAX_EDIT_FRAMING_SEGMENTS,
	originalTimeToCfrFrame,
} from "./index";

function first<T>(items: T[]): T {
	const item = items[0];
	if (item === undefined) throw new Error("Missing test fixture element");
	return item;
}

const mediaVersionId = "11111111-1111-4111-8111-111111111111";
const timeMapId = "22222222-2222-4222-8222-222222222222";
const clipId = "33333333-3333-4333-8333-333333333333";
const fixture = (): EditDocument => ({
	schemaVersion: 1,
	mediaVersionId,
	analysisRevisionId: null,
	locale: "ja",
	sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
	timeMapId,
	canvas: { width: 1080, height: 1920 },
	fps: { num: 30, den: 1 },
	clips: [
		{
			id: clipId,
			sourceInUs: 42_000_000,
			durationFrames: 360,
			timelineStartFrame: 0,
			framing: [{ fromFrame: 0, toFrame: 360, mode: "FIT", origin: "MANUAL" }],
			audio: { mode: "SOURCE" },
		},
	],
});
const timeMap = () => ({
	id: timeMapId,
	mediaVersionId,
	kind: "CFR" as const,
	sourceStartUs: 42_000_000,
	sourceEndUs: 54_000_000,
	editingStartFrame: 0,
	editingEndFrame: 360,
	fps: { num: 30 as const, den: 1 as const },
});

describe("editing document contract", () => {
	it("round-trips an explicit manual fit without accepting an untyped override", () => {
		const input = fixture();
		first(input.clips).framing = [
			{ ...first(first(input.clips).framing), manualOverride: true },
		];
		const parsed = editingDocumentSchema.parse(
			JSON.parse(JSON.stringify(input)),
		);
		expect(first(first(parsed.clips).framing)).toMatchObject({
			mode: "FIT",
			origin: "MANUAL",
			manualOverride: true,
		});
		expect(
			editingDocumentSchema.safeParse({
				...input,
				clips: [
					{
						...first(input.clips),
						framing: [
							{ ...first(first(input.clips).framing), manualOverride: "yes" },
						],
					},
				],
			}).success,
		).toBe(false);
	});
	it("shares a total framing limit across clips and the compiler", () => {
		expect(MAX_EDIT_FRAMING_SEGMENTS).toBe(128);
		const input = fixture();
		const parts = (count: number) =>
			Array.from({ length: count }, (_, frame) => ({
				fromFrame: frame,
				toFrame: frame + 1,
				mode: "FIT" as const,
				origin: "MANUAL" as const,
			}));
		input.clips = [
			{ ...first(input.clips), durationFrames: 64, framing: parts(64) },
			{
				...first(input.clips),
				id: mediaVersionId,
				timelineStartFrame: 64,
				durationFrames: 64,
				framing: parts(64),
			},
		];
		expect(editingDocumentSchema.safeParse(input).success).toBe(true);
		expect(compileEditDocument(input, timeMap()).segments).toHaveLength(128);
		input.clips[1] = {
			...first(input.clips.slice(1)),
			durationFrames: 65,
			framing: parts(65),
		};
		expect(editingDocumentSchema.safeParse(input).success).toBe(false);
		expect(() => compileEditDocument(input, timeMap())).toThrow();
	});
	it("accepts a bounded single-material edit without inventing an analysis", () => {
		expect(editingDocumentSchema.parse(fixture())).toEqual(fixture());
	});
	it("rejects unrecognised effects and locator data at every boundary", () => {
		for (const input of [
			{ ...fixture(), url: "https://private" },
			{ ...fixture(), clips: [{ ...first(fixture().clips), effect: "blur" }] },
			{ ...fixture(), canvas: { width: 1080, height: 1920, rotation: 90 } },
		]) {
			expect(editingDocumentSchema.safeParse(input).success).toBe(false);
		}
	});
	it("rejects discontinuous framing and output timelines", () => {
		const input = fixture();
		first(first(input.clips).framing).fromFrame = 1;
		expect(editingDocumentSchema.safeParse(input).success).toBe(false);
		first(first(input.clips).framing).fromFrame = 0;
		first(input.clips).timelineStartFrame = 1;
		expect(editingDocumentSchema.safeParse(input).success).toBe(false);
	});
	it("does not accept non-finite or unsafe time, unsupported fps, or long output", () => {
		for (const sourceInUs of [
			Number.NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			-1,
		]) {
			expect(
				editingDocumentSchema.safeParse({
					...fixture(),
					clips: [{ ...first(fixture().clips), sourceInUs }],
				}).success,
			).toBe(false);
		}
		expect(
			editingDocumentSchema.safeParse({
				...fixture(),
				fps: { num: 60, den: 1 },
			}).success,
		).toBe(false);
		const input = fixture();
		first(input.clips).durationFrames = 5401;
		first(first(input.clips).framing).toFrame = 5401;
		expect(editingDocumentSchema.safeParse(input).success).toBe(false);
	});
});

describe("original presentation CFR grid", () => {
	it.each([
		[1_250_000, 0, 37n, 38n],
		[1_270_000, 0, 38n, 39n],
		[43_270_000, 42_000_000, 38n, 39n],
		[41_999_999, 42_000_000, -1n, 0n],
	])("quantizes %i us relative to %i with explicit boundary rounding", (us, sourceStartUs, floor, ceil) => {
		expect(originalTimeToCfrFrame(us, sourceStartUs, "FLOOR")).toBe(floor);
		expect(originalTimeToCfrFrame(us, sourceStartUs, "CEIL")).toBe(ceil);
	});
});

describe("edit compiler", () => {
	it("maps original 42s to frame zero of a trimmed editing material", () => {
		const before = JSON.stringify(fixture());
		const recipe = compileEditDocument(fixture(), timeMap());
		expect(recipe).toMatchObject({
			durationFrames: 360,
			segments: [
				{
					clipId,
					editingStartFrame: 0,
					editingEndFrame: 360,
					timelineStartFrame: 0,
					durationFrames: 360,
					framing: { mode: "FIT" },
					audio: { mode: "SOURCE" },
				},
			],
		});
		expect(JSON.stringify(fixture())).toBe(before);
	});
	it("splits shot framing into half-open render segments", () => {
		const input = fixture();
		first(input.clips).framing = [
			{ fromFrame: 0, toFrame: 120, mode: "FIT", origin: "MANUAL" },
			{
				fromFrame: 120,
				toFrame: 360,
				mode: "CROP",
				rect: { x: 0.5, y: 0, w: 0.25, h: 1 },
				origin: "EDITOR_CONFIRMED",
			},
		];
		expect(compileEditDocument(input, timeMap()).segments).toMatchObject([
			{
				editingStartFrame: 0,
				editingEndFrame: 120,
				timelineStartFrame: 0,
				durationFrames: 120,
				framing: { mode: "FIT" },
			},
			{
				editingStartFrame: 120,
				editingEndFrame: 360,
				timelineStartFrame: 120,
				durationFrames: 240,
				framing: { mode: "CROP", rect: { x: 0.5, y: 0, w: 0.25, h: 1 } },
			},
		]);
	});
	it("rejects another material, a mismatching map, and uncovered time", () => {
		expect(() =>
			compileEditDocument(fixture(), { ...timeMap(), mediaVersionId: clipId }),
		).toThrow();
		expect(() =>
			compileEditDocument(fixture(), { ...timeMap(), id: clipId }),
		).toThrow();
		expect(() =>
			compileEditDocument(fixture(), {
				...timeMap(),
				sourceStartUs: 43_000_000,
				editingEndFrame: 330,
			}),
		).toThrow();
	});
	it("rejects unsupported or inconsistent maps instead of assuming source fps", () => {
		expect(
			cfrTimeMapSchema.safeParse({ ...timeMap(), kind: "VFR" }).success,
		).toBe(false);
		expect(
			cfrTimeMapSchema.safeParse({ ...timeMap(), editingEndFrame: 359 })
				.success,
		).toBe(false);
	});
	it("uses source intervals independently of the reordered output timeline", () => {
		const input = fixture();
		input.clips = [
			{
				...first(input.clips),
				sourceInUs: 245_000_000,
				durationFrames: 240,
				framing: [
					{ fromFrame: 0, toFrame: 240, mode: "FIT", origin: "MANUAL" },
				],
			},
			{
				...first(input.clips),
				id: timeMapId,
				sourceInUs: 42_000_000,
				timelineStartFrame: 240,
			},
			{
				...first(input.clips),
				id: mediaVersionId,
				sourceInUs: 130_000_000,
				timelineStartFrame: 600,
				durationFrames: 300,
				framing: [
					{ fromFrame: 0, toFrame: 300, mode: "FIT", origin: "MANUAL" },
				],
			},
		];
		const recipe = compileEditDocument(input, {
			...timeMap(),
			sourceStartUs: 0,
			sourceEndUs: 300_000_000,
			editingEndFrame: 9000,
		});
		expect(recipe.durationFrames).toBe(900);
		expect(
			recipe.segments.map((part) => [
				part.editingStartFrame,
				part.editingEndFrame,
				part.timelineStartFrame,
			]),
		).toEqual([
			[7350, 7590, 0],
			[1260, 1620, 240],
			[3900, 4200, 600],
		]);
	});
	it("allows proposal drafts but refuses their unconfirmed rendering", () => {
		const input = fixture();
		first(first(input.clips).framing).origin = "AISA_PROPOSAL";
		expect(editingDocumentSchema.safeParse(input).success).toBe(true);
		expect(() => compileEditDocument(input, timeMap())).toThrow(
			"UNCONFIRMED_FRAMING",
		);
		first(first(input.clips).framing).origin = "EDITOR_CONFIRMED";
		expect(compileEditDocument(input, timeMap()).durationFrames).toBe(360);
	});
	it("does not lose precision near the safe integer limit", () => {
		const start = Number.MAX_SAFE_INTEGER - 12_000_000;
		const input = fixture();
		first(input.clips).sourceInUs = start;
		const map = {
			...timeMap(),
			sourceStartUs: start,
			sourceEndUs: Number.MAX_SAFE_INTEGER,
		};
		expect(compileEditDocument(input, map).segments[0]).toMatchObject({
			editingStartFrame: 0,
			editingEndFrame: 360,
		});
		first(input.clips).sourceInUs = start + 1;
		expect(compileEditDocument(input, map).segments[0]?.editingStartFrame).toBe(
			0,
		);
		first(input.clips).sourceInUs = start + 33_334;
		expect(() => compileEditDocument(input, map)).toThrow(
			"SOURCE_OUT_OF_BOUNDS",
		);
	});
	it("checks snapped frame bounds when an integer microsecond marks the last frames", () => {
		const input = fixture();
		first(input.clips).sourceInUs = 53_933_334;
		first(input.clips).durationFrames = 2;
		first(input.clips).framing = [
			{ fromFrame: 0, toFrame: 2, mode: "FIT", origin: "MANUAL" },
		];
		expect(compileEditDocument(input, timeMap()).segments[0]).toMatchObject({
			editingStartFrame: 358,
			editingEndFrame: 360,
			durationFrames: 2,
		});
		first(input.clips).durationFrames = 3;
		first(first(input.clips).framing).toFrame = 3;
		expect(() => compileEditDocument(input, timeMap())).toThrow(
			"SOURCE_OUT_OF_BOUNDS",
		);
	});
	it("keeps mute and nonzero editing frame offsets in the shared recipe", () => {
		const input = fixture();
		first(input.clips).audio.mode = "MUTE";
		expect(
			compileEditDocument(input, {
				...timeMap(),
				editingStartFrame: 90,
				editingEndFrame: 450,
			}).segments[0],
		).toMatchObject({
			editingStartFrame: 90,
			editingEndFrame: 450,
			audio: { mode: "MUTE" },
		});
	});
});
