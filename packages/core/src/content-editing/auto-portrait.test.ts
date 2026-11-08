import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	AutoPortraitSelectionError,
	selectAutoPortraitClips,
} from "./auto-portrait";
import { compileEditDocument } from "./compile";
import { originalTimeToCfrFrame } from "./time";

const sceneA = "11111111-1111-4111-8111-111111111111";
const sceneB = "22222222-2222-4222-8222-222222222222";
const sceneC = "33333333-3333-4333-8333-333333333333";
const mapId = "44444444-4444-4444-8444-444444444444";
const mediaId = "55555555-5555-4555-8555-555555555555";
type SceneInput = {
	id: string;
	startInSeconds: number;
	endInSeconds: number;
	type?: string;
	shots?: { startInSeconds: number; endInSeconds: number }[];
	adOpportunityInformation?: { score: number };
};
const shot = (startInSeconds: number, endInSeconds: number) => ({
	startInSeconds,
	endInSeconds,
});
function scene(
	id: string,
	startInSeconds: number,
	endInSeconds: number,
	shots?: SceneInput["shots"],
): SceneInput {
	return { id, startInSeconds, endInSeconds, type: "MAIN_CONTENT", shots };
}
function analysis(scenes: SceneInput[], duration = 120) {
	return normalizeSceneAnalysis({
		metadata: { version: "auto-portrait-test" },
		duration,
		scenes,
	});
}
function timeMap() {
	return {
		id: mapId,
		mediaVersionId: mediaId,
		kind: "CFR" as const,
		sourceStartUs: 0,
		sourceEndUs: 120_000_000,
		editingStartFrame: 0,
		editingEndFrame: 3600,
		fps: { num: 30, den: 1 },
	};
}
function select(scenes: SceneInput[], targetDurationFrames: number) {
	return selectAutoPortraitClips({
		analysis: analysis(scenes),
		timeMap: timeMap(),
		targetDurationFrames,
	});
}
function expectNoWindow(run: () => unknown) {
	expect(run).toThrow(AutoPortraitSelectionError);
	try {
		run();
	} catch (error) {
		expect(error).toMatchObject({ code: "NO_ELIGIBLE_WINDOW" });
	}
}

describe("whole-shot source windows", () => {
	it("selects the closest contiguous whole-shot window within the requested duration", () => {
		const result = select(
			[scene(sceneA, 0, 12, [shot(0, 3), shot(3, 7), shot(7, 12)])],
			270,
		);
		expect(result).toEqual({
			policyVersion: "aisa-shot-window-v1",
			requestedDurationFrames: 270,
			actualDurationFrames: 270,
			clips: [
				{
					sourceInUs: 3_000_000,
					durationFrames: 120,
					sceneId: sceneA,
					shotIndex: 1,
				},
				{
					sourceInUs: 7_000_000,
					durationFrames: 150,
					sceneId: sceneA,
					shotIndex: 2,
				},
			],
			reasonCodes: ["WHOLE_SHOT_WINDOW"],
		});
	});
	it("returns an under-target shot without trimming, padding or repeating it", () => {
		const result = select([scene(sceneA, 0, 2, [shot(0, 2)])], 90);
		expect(result.actualDurationFrames).toBe(60);
		expect(result.clips).toEqual([
			{ sourceInUs: 0, durationFrames: 60, sceneId: sceneA, shotIndex: 0 },
		]);
		expect(result.reasonCodes).toEqual([
			"WHOLE_SHOT_WINDOW",
			"DURATION_UNDER_TARGET",
		]);
	});
	it("keeps original shot indexes while exploring overlapping alternatives", () => {
		const result = select(
			[scene(sceneA, 0, 5, [shot(0, 3), shot(1, 2), shot(3, 5)])],
			150,
		);
		expect(result.actualDurationFrames).toBe(150);
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([0, 2]);
		expect(result.clips.map((clip) => clip.sourceInUs)).toEqual([0, 3_000_000]);
	});
	it("orders source intervals without rewriting their original shot indexes", () => {
		const result = select(
			[scene(sceneA, 0, 12, [shot(7, 12), shot(0, 3), shot(3, 7)])],
			270,
		);
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([2, 0]);
		expect(result.clips.map((clip) => clip.sourceInUs)).toEqual([
			3_000_000, 7_000_000,
		]);
	});
	it("does not replay duplicate intervals or duplicate same-scene evidence", () => {
		const result = select(
			[scene(sceneA, 0, 6, [shot(0, 3), shot(0, 3), shot(3, 6)])],
			180,
		);
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([0, 2]);
		expect(result.actualDurationFrames).toBe(180);
	});
	it("preserves a whole shot crossing its owning scene and joins the following scene", () => {
		const result = select(
			[scene(sceneA, 0, 3, [shot(0, 4)]), scene(sceneB, 3, 8, [shot(4, 8)])],
			240,
		);
		expect(result.actualDurationFrames).toBe(240);
		expect(result.clips).toEqual([
			{ sourceInUs: 0, durationFrames: 120, sceneId: sceneA, shotIndex: 0 },
			{
				sourceInUs: 4_000_000,
				durationFrames: 120,
				sceneId: sceneB,
				shotIndex: 0,
			},
		]);
	});
	it("breaks windows at uncovered gaps instead of filling or jumping across them", () => {
		const result = select([scene(sceneA, 0, 7, [shot(0, 3), shot(4, 7)])], 180);
		expect(result.actualDurationFrames).toBe(90);
		expect(result.clips).toHaveLength(1);
		expect(result.clips[0]?.sourceInUs).toBe(0);
	});
	it("uses an entire shotless scene as evidence without inventing a shot index", () => {
		const result = select(
			[scene(sceneA, 0, 3), scene(sceneB, 3, 7, [shot(3, 7)])],
			210,
		);
		expect(result.clips).toEqual([
			{ sourceInUs: 0, durationFrames: 90, sceneId: sceneA },
			{
				sourceInUs: 3_000_000,
				durationFrames: 120,
				sceneId: sceneB,
				shotIndex: 0,
			},
		]);
		expect(result.reasonCodes).toEqual([
			"WHOLE_SHOT_WINDOW",
			"SCENE_INTERVAL_FALLBACK",
		]);
	});
	it("does not replace partial shot coverage with a fabricated whole-scene shot", () => {
		const result = select([scene(sceneA, 0, 10, [shot(2, 4)])], 300);
		expect(result.actualDurationFrames).toBe(60);
		expect(result.clips).toEqual([
			{
				sourceInUs: 2_000_000,
				durationFrames: 60,
				sceneId: sceneA,
				shotIndex: 0,
			},
		]);
	});
	it.each([
		"ADS",
		"LOGO_IDENT",
		"OPENING_CREDITS",
		"END_CREDITS",
		"BREAK_BUMPER",
		"PROMOTION_OTHER_TITLE",
		"PREVIEW_THIS_TITLE",
	])("excludes the default scene type %s regardless of case", (type) => {
		expectNoWindow(() =>
			select([{ ...scene(sceneA, 0, 2), type: type.toLowerCase() }], 60),
		);
	});
	it("does not let a cross-scene shot include an excluded interval", () => {
		const result = select(
			[
				scene(sceneA, 0, 12, [shot(0, 4), shot(4, 8), shot(8, 12)]),
				{ ...scene(sceneB, 5, 7), type: "ADS" },
			],
			240,
		);
		expect(result.actualDurationFrames).toBe(120);
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([0]);
	});
	it("does not repurpose ad-break suitability as a highlight score", () => {
		const first = {
			...scene(sceneA, 0, 6, [shot(0, 3), shot(3, 6)]),
			adOpportunityInformation: { score: 0 },
		};
		const second = {
			...scene(sceneB, 10, 15, [shot(10, 15)]),
			adOpportunityInformation: { score: 1 },
		};
		expect(
			select([second, first], 180).clips.map((clip) => clip.sceneId),
		).toEqual([sceneA, sceneA]);
	});
});

describe("deterministic window ranking", () => {
	it("prefers fewer scene transitions before an earlier source start", () => {
		const result = select(
			[
				scene(sceneA, 0, 2, [shot(0, 2)]),
				scene(sceneB, 2, 4, [shot(2, 4)]),
				scene(sceneC, 10, 14, [shot(10, 12), shot(12, 14)]),
			],
			120,
		);
		expect(result.clips.map((clip) => clip.sceneId)).toEqual([sceneC, sceneC]);
	});
	it("prefers the earliest source start when duration and scene transitions tie", () => {
		const result = select(
			[scene(sceneA, 0, 10, [shot(0, 2), shot(2, 4), shot(6, 8), shot(8, 10)])],
			120,
		);
		expect(result.clips.map((clip) => clip.sourceInUs)).toEqual([0, 2_000_000]);
	});
	it("prefers fewer whole clips for the same source window and scene transitions", () => {
		const result = select(
			[scene(sceneA, 0, 4, [shot(0, 2), shot(2, 4), shot(0, 4)])],
			120,
		);
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([2]);
	});
	it("keeps duplicate scene evidence as an alternative when it avoids a scene transition", () => {
		const first = scene(sceneA, 0, 2, [shot(0, 2)]);
		const second = scene(sceneB, 0, 4, [shot(0, 2), shot(2, 4)]);
		const expected = select([first, second], 120);
		expect(expected.clips.map((clip) => clip.sceneId)).toEqual([
			sceneB,
			sceneB,
		]);
		expect(select([second, first], 120)).toEqual(expected);
	});
	it("bounds a branching overlap graph without choosing inconsistent evidence", () => {
		const scenes = Array.from({ length: 20 }, (_, index) =>
			scene(
				`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				0,
				20,
				Array.from({ length: 20 }, (_, n) => shot(n, n + 1)),
			),
		);
		const result = select(scenes.reverse(), 600);
		expect(result.clips).toHaveLength(20);
		expect(result.actualDurationFrames).toBe(600);
		expect(new Set(result.clips.map((clip) => clip.sceneId))).toEqual(
			new Set(["00000000-0000-4000-8000-000000000001"]),
		);
	});
	it("accepts ten thousand observations without replaying duplicate footage", () => {
		const duplicates = Array.from({ length: 5000 }, () => shot(0, 1));
		const result = select(
			[scene(sceneA, 0, 1, duplicates), scene(sceneB, 0, 1, duplicates)],
			30,
		);
		expect(result.clips).toEqual([
			{ sourceInUs: 0, durationFrames: 30, sceneId: sceneA, shotIndex: 0 },
		]);
	});
	it("rejects excess candidates instead of slicing away a later better window", () => {
		const duplicates = Array.from({ length: 5000 }, () => shot(0, 1));
		expect(() =>
			select(
				[
					scene(sceneA, 0, 1, duplicates),
					scene(sceneB, 0, 1, duplicates),
					scene(sceneC, 0, 2, [shot(0, 2)]),
				],
				60,
			),
		).toThrow(/candidate limit/i);
	});
	it("rejects excessive search work rather than returning a partially explored optimum", () => {
		const alternatives = Array.from({ length: 100 }, (_, n) => [
			shot(n / 30, (n + 1) / 30),
			...(n < 99 ? [shot(n / 30, (n + 2) / 30)] : []),
		]).flat();
		const scenes = Array.from({ length: 20 }, (_, index) =>
			scene(
				`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				0,
				100 / 30,
				alternatives,
			),
		);
		expect(() => select(scenes, 60)).toThrow(/search limit/i);
	});
});

describe("CFR bounds and rounding", () => {
	it.each([
		31, 49, 73, 1001,
	])("keeps frame/30 boundary %s despite ULP error", (frame) => {
		const result = select(
			[scene(sceneA, 0, 120, [shot(frame / 30, (frame + 3) / 30)])],
			3,
		);
		expect(result.actualDurationFrames).toBe(3);
		expect(result.clips[0]?.sourceInUs).toBe(
			Number((BigInt(frame) * 1_000_000n + 29n) / 30n),
		);
	});
	it("ceil-snaps starts and floor-snaps ends without moving real fractional boundaries", () => {
		const result = select(
			[scene(sceneA, 0, 1, [shot(1 / 30 + 1e-7, 4 / 30 - 1e-7)])],
			3,
		);
		expect(result.actualDurationFrames).toBe(1);
		expect(result.clips[0]?.sourceInUs).toBe(66_667);
	});
	it("does not fill a CFR gap between fractional shot boundaries", () => {
		const result = select(
			[scene(sceneA, 0, 2, [shot(0, 1.05), shot(1.05, 2)])],
			60,
		);
		expect(result.actualDurationFrames).toBe(31);
		expect(result.clips.map((clip) => clip.sourceInUs)).toEqual([0]);
	});
	it("keeps nonzero original and editing origins aligned with the compiler", () => {
		const map = {
			...timeMap(),
			sourceStartUs: 1_000_000,
			sourceEndUs: 11_000_000,
			editingStartFrame: 900,
			editingEndFrame: 1200,
		};
		const result = selectAutoPortraitClips({
			analysis: analysis([scene(sceneA, 1, 2, [shot(1 + 1 / 30, 1 + 4 / 30)])]),
			timeMap: map,
			targetDurationFrames: 3,
		});
		const clip = result.clips[0];
		if (!clip) throw new Error("Missing chosen clip");
		expect(clip.sourceInUs).toBe(1_033_334);
		expect(
			originalTimeToCfrFrame(clip.sourceInUs, map.sourceStartUs, "FLOOR"),
		).toBe(1n);
		const recipe = compileEditDocument(
			{
				schemaVersion: 1,
				mediaVersionId: mediaId,
				analysisRevisionId: sceneB,
				locale: "ja",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				timeMapId: mapId,
				canvas: { width: 1080, height: 1920 },
				fps: { num: 30, den: 1 },
				clips: [
					{
						id: sceneC,
						sourceInUs: clip.sourceInUs,
						durationFrames: clip.durationFrames,
						timelineStartFrame: 0,
						audio: { mode: "SOURCE" },
						framing: [
							{
								fromFrame: 0,
								toFrame: clip.durationFrames,
								mode: "FIT",
								origin: "MANUAL",
							},
						],
						evidence: { sceneId: clip.sceneId, shotIndex: clip.shotIndex },
					},
				],
			},
			map,
		);
		expect(recipe.segments[0]).toMatchObject({
			editingStartFrame: 901,
			editingEndFrame: 904,
		});
	});
	it("retains fractional-second map origins until frame snapping", () => {
		const origin = 111_111;
		const map = {
			...timeMap(),
			sourceStartUs: origin,
			sourceEndUs: origin + 10_000_000,
			editingStartFrame: 90,
			editingEndFrame: 390,
		};
		const result = selectAutoPortraitClips({
			analysis: analysis([
				scene(sceneA, 0, 10, [
					shot(origin / 1_000_000 + 31 / 30, origin / 1_000_000 + 34 / 30),
				]),
			]),
			timeMap: map,
			targetDurationFrames: 3,
		});
		expect(result.clips[0]).toMatchObject({
			sourceInUs: 1_144_445,
			durationFrames: 3,
		});
		expect(
			originalTimeToCfrFrame(
				result.clips[0]?.sourceInUs ?? -1,
				origin,
				"FLOOR",
			),
		).toBe(31n);
	});
	it("accepts a partial map but skips an entire shot that crosses its end", () => {
		const result = selectAutoPortraitClips({
			analysis: analysis([scene(sceneA, 0, 12, [shot(0, 4), shot(4, 12)])]),
			timeMap: { ...timeMap(), sourceEndUs: 10_000_000, editingEndFrame: 300 },
			targetDurationFrames: 300,
		});
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([0]);
		expect(result.actualDurationFrames).toBe(120);
	});
	it("does not disguise a partial shot before the map origin as a whole shot", () => {
		const result = selectAutoPortraitClips({
			analysis: analysis([
				scene(sceneA, 0, 2, [shot(0.999, 1.1), shot(1.1, 1.2)]),
			]),
			timeMap: {
				...timeMap(),
				sourceStartUs: 1_000_000,
				sourceEndUs: 2_000_000,
				editingEndFrame: 30,
			},
			targetDurationFrames: 30,
		});
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([1]);
		expect(result.clips[0]).toMatchObject({
			sourceInUs: 1_100_000,
			durationFrames: 3,
		});
	});
	it("rejects a raw shot end beyond the map even if FLOOR lands on its last frame", () => {
		const result = selectAutoPortraitClips({
			analysis: analysis([
				scene(sceneA, 0, 2, [shot(0, 1.001), shot(0.2, 0.4)]),
			]),
			timeMap: { ...timeMap(), sourceEndUs: 1_000_000, editingEndFrame: 30 },
			targetDurationFrames: 30,
		});
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([1]);
		expect(result.actualDurationFrames).toBe(6);
	});
	it("keeps large editing frame offsets within the safe integer domain", () => {
		const start = Number.MAX_SAFE_INTEGER - 300;
		const result = selectAutoPortraitClips({
			analysis: analysis([scene(sceneA, 1, 2, [shot(1, 2)])]),
			timeMap: {
				...timeMap(),
				sourceEndUs: 10_000_000,
				editingStartFrame: start,
				editingEndFrame: Number.MAX_SAFE_INTEGER,
			},
			targetDurationFrames: 30,
		});
		expect(result.clips[0]).toMatchObject({
			sourceInUs: 1_000_000,
			durationFrames: 30,
		});
	});
});

describe("selection limits and failure contracts", () => {
	it("enforces twenty clips without truncating the next shot", () => {
		const result = select(
			[
				scene(
					sceneA,
					0,
					21,
					Array.from({ length: 21 }, (_, n) => shot(n, n + 1)),
				),
			],
			630,
		);
		expect(result.clips).toHaveLength(20);
		expect(result.actualDurationFrames).toBe(600);
		expect(result.clips[0]?.sourceInUs).toBe(0);
		expect(result.clips.at(-1)?.sourceInUs).toBe(19_000_000);
		expect(result.reasonCodes).toEqual([
			"WHOLE_SHOT_WINDOW",
			"DURATION_UNDER_TARGET",
			"CLIP_LIMIT_REACHED",
		]);
	});
	it("accepts exactly 180 seconds", () => {
		const result = selectAutoPortraitClips({
			analysis: analysis([scene(sceneA, 0, 180, [shot(0, 180)])], 180),
			timeMap: {
				...timeMap(),
				sourceEndUs: 180_000_000,
				editingEndFrame: 5400,
			},
			targetDurationFrames: 5400,
		});
		expect(result.actualDurationFrames).toBe(5400);
		expect(result.clips).toHaveLength(1);
	});
	it.each([
		0,
		-1,
		1.5,
		5401,
		Number.MAX_SAFE_INTEGER,
		Number.NaN,
		Infinity,
	])("rejects invalid requested frames %s", (targetDurationFrames) => {
		expect(() => select([scene(sceneA, 0, 2)], targetDurationFrames)).toThrow(
			RangeError,
		);
	});
	it("uses a dedicated error for overlong, excluded, empty and out-of-map evidence", () => {
		expectNoWindow(() => select([scene(sceneA, 0, 10, [shot(0, 10)])], 150));
		expectNoWindow(() => select([scene(sceneA, 0, 10)], 150));
		expectNoWindow(() => select([], 150));
		expectNoWindow(() =>
			select([scene(sceneA, 0, 1, [shot(0.001, 0.002)])], 30),
		);
		expectNoWindow(() =>
			selectAutoPortraitClips({
				analysis: analysis([scene(sceneA, 0, 1, [shot(0, 1)])]),
				timeMap: {
					...timeMap(),
					sourceStartUs: 2_000_000,
					sourceEndUs: 12_000_000,
					editingEndFrame: 300,
				},
				targetDurationFrames: 150,
			}),
		);
	});
	it.each([
		{ id: "not-a-time-map-id" },
		{ mediaVersionId: "not-a-media-id" },
		{ fps: { num: 24, den: 1 } },
		{ editingEndFrame: 3599 },
		{ editingEndFrame: Number.MAX_SAFE_INTEGER + 1 },
		{ sourceEndUs: -1 },
	])("rejects an invalid CFR map %#", (invalid) => {
		expect(() =>
			selectAutoPortraitClips({
				analysis: analysis([scene(sceneA, 0, 2)]),
				timeMap: { ...timeMap(), ...invalid },
				targetDurationFrames: 60,
			}),
		).toThrow();
	});
	it("rejects invalid scene evidence IDs and times outside the safe microsecond domain", () => {
		const normalized = analysis([scene(sceneA, 0, 2)]);
		expect(() =>
			selectAutoPortraitClips({
				analysis: {
					...normalized,
					scenes: [{ ...normalized.scenes[0], id: "invalid-evidence" }],
				},
				timeMap: timeMap(),
				targetDurationFrames: 60,
			}),
		).toThrow();
		expect(() =>
			selectAutoPortraitClips({
				analysis: { ...normalized, duration: Number.MAX_SAFE_INTEGER },
				timeMap: timeMap(),
				targetDurationFrames: 60,
			}),
		).toThrow(RangeError);
	});
	it("preserves inputs and never promotes caller-supplied binding claims", () => {
		const input = {
			analysis: {
				...analysis([scene(sceneA, 0, 4, [shot(0, 2), shot(2, 4)])]),
				analysisBinding: "PROVEN",
			},
			timeMap: timeMap(),
			targetDurationFrames: 120,
		};
		const before = JSON.stringify(input);
		const result = selectAutoPortraitClips(input);
		expect(JSON.stringify(input)).toBe(before);
		expect(result).not.toHaveProperty("binding");
		expect(result).not.toHaveProperty("analysisBinding");
		expect(result.clips.every((clip) => clip.sceneId === sceneA)).toBe(true);
	});
});
