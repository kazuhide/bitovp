import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	buildSpeechContextWindow,
	createPortraitSelectionSearchBudget,
	refinePortraitSelectionBySpeech,
	selectAutoPortraitClips,
	selectSemanticPortraitClips,
} from "./index";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const frameUs = (frame: number) =>
	Number((BigInt(frame) * 1_000_000n + 29n) / 30n);
function fixture(
	shots: readonly (readonly [number, number])[],
	options: { origin?: number; frames?: number; editingStart?: number } = {},
) {
	const origin = options.origin ?? 0;
	const frames = options.frames ?? 600;
	const timeMap = {
		id: a,
		mediaVersionId: b,
		kind: "CFR" as const,
		sourceStartUs: origin,
		sourceEndUs: origin + frameUs(frames),
		editingStartFrame: options.editingStart ?? 0,
		editingEndFrame: (options.editingStart ?? 0) + frames,
		fps: { num: 30, den: 1 },
	};
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "speech-boundary-test" },
		duration: timeMap.sourceEndUs / 1_000_000,
		scenes: [
			{
				id: c,
				type: "MAIN_CONTENT",
				title: "Goal",
				startInSeconds: origin / 1_000_000,
				endInSeconds: timeMap.sourceEndUs / 1_000_000,
				shots: shots.map(([from, to]) => ({
					startInSeconds: origin / 1_000_000 + from / 30,
					endInSeconds: origin / 1_000_000 + to / 30,
				})),
			},
		],
	});
	return { analysis, timeMap };
}
function setup(
	input: ReturnType<typeof fixture>,
	targetDurationFrames: number,
	policy: "DURATION" | "COHESION" = "DURATION",
	query?: string,
) {
	const searchBudget = createPortraitSelectionSearchBudget();
	const anchor =
		policy === "DURATION"
			? selectAutoPortraitClips({
					...input,
					targetDurationFrames,
					searchBudget,
				})
			: selectSemanticPortraitClips({
					...input,
					targetDurationFrames,
					searchBudget,
					query,
				});
	return {
		...input,
		targetDurationFrames,
		policy,
		query,
		anchor,
		context: buildSpeechContextWindow({
			selection: anchor,
			timeMap: input.timeMap,
		}),
		searchBudget,
	};
}
const span = (from: number, to: number, origin = 0) => ({
	startUs: origin + frameUs(from),
	endUs: origin + frameUs(to),
});

describe("bounded, prepared-local speech context", () => {
	it("adds sixty frames at each side and subtracts canonical endpoint microseconds", () => {
		const input = fixture([[61, 62]], { origin: 111_111, editingStart: 900 });
		const { context } = setup(input, 1);
		expect(context).toEqual({
			fromFrame: 1,
			toFrame: 122,
			mediaStartUs: 33_334,
			durationUs: 4_033_333,
			clipped: false,
		});
	});
	it.each([
		1, 2, 164,
	])("keeps frame %s context indices independent from nonzero origins", (from) => {
		const { context } = setup(
			fixture([[from, from + 1]], { origin: 123_457, editingStart: 900 }),
			1,
		);
		const start = Math.max(0, from - 60);
		const end = from + 61;
		expect(context.fromFrame).toBe(start);
		expect(context.toFrame).toBe(end);
		expect(context.mediaStartUs).toBe(frameUs(start));
		expect(context.durationUs).toBe(frameUs(end) - frameUs(start));
	});
	it("caps a 180-second anchor at 5400 frames using the stated centered clamp", () => {
		const { context } = setup(fixture([[300, 5700]], { frames: 9000 }), 5400);
		expect(context).toEqual({
			fromFrame: 300,
			toFrame: 5700,
			mediaStartUs: 10_000_000,
			durationUs: 180_000_000,
			clipped: true,
		});
	});
	it("clips source edges and retains the partial final microsecond without extrapolating", () => {
		const { context } = setup(fixture([[30, 31]], { frames: 31 }), 1);
		expect(context).toEqual({
			fromFrame: 0,
			toFrame: 31,
			mediaStartUs: 0,
			durationUs: 1_033_334,
			clipped: true,
		});
	});
	it("keeps canonical context arithmetic exact near the safe original-us limit", () => {
		const origin = 9_000_000_000_000_000;
		const { context } = setup(
			fixture([[61, 62]], { origin, editingStart: 900 }),
			1,
		);
		expect(context.mediaStartUs).toBe(33_334);
		expect(context.durationUs).toBe(4_033_333);
	});
});

describe("whole-shot speech boundary selection", () => {
	it.each([
		"DURATION",
		"COHESION",
	] as const)("replaces a metadata winner cut inside real speech: %s", (policy) => {
		const input = setup(
			fixture([
				[60, 150],
				[150, 240],
				[240, 300],
			]),
			150,
			policy,
		);
		expect(input.anchor.actualDurationFrames).toBe(150);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(140, 160)],
		});
		expect(result.status).toBe("APPLIED");
		expect(result.selection.clips).toEqual([
			{ sourceInUs: 8_000_000, durationFrames: 60, sceneId: c, shotIndex: 2 },
		]);
		expect(result.rejectedBoundaryCount).toBe(1);
	});
	it.each([
		"DURATION",
		"COHESION",
	] as const)("continues through an unsafe internal shot boundary: %s", (policy) => {
		const input = setup(
			fixture([
				[90, 120],
				[120, 150],
			]),
			60,
			policy,
		);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(110, 130)],
		});
		expect(result.status).toBe("APPLIED");
		expect(result.selection.actualDurationFrames).toBe(60);
		expect(result.selection.clips.map((clip) => clip.shotIndex)).toEqual([
			0, 1,
		]);
		expect(result.rejectedBoundaryCount).toBe(1);
	});
	it("does not join source gaps to hide unsafe connection boundaries", () => {
		const input = setup(
			fixture([
				[90, 120],
				[150, 160],
				[165, 175],
			]),
			90,
		);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(110, 155)],
		});
		expect(result.selection.clips).toHaveLength(1);
		expect(result.selection.clips[0]?.shotIndex).toBe(2);
	});
	it("unions overlapping and touching measured spans without changing inputs", () => {
		const input = setup(fixture([[60, 90]]), 30);
		const segments = Object.freeze([
			Object.freeze({ startUs: 4_000_000, endUs: 5_000_000 }),
			Object.freeze({ startUs: 3_000_000, endUs: 4_000_000 }),
			Object.freeze({ startUs: 4_500_000, endUs: 6_000_000 }),
		]);
		const before = JSON.stringify({
			analysis: input.analysis,
			timeMap: input.timeMap,
			segments,
		});
		const result = refinePortraitSelectionBySpeech({ ...input, segments });
		expect(result.intervals).toEqual([
			{ startUs: 3_000_000, endUs: 6_000_000 },
		]);
		expect(result.status).toBe("APPLIED");
		expect(
			JSON.stringify({
				analysis: input.analysis,
				timeMap: input.timeMap,
				segments,
			}),
		).toBe(before);
	});
	it("treats a shared endpoint of touching spans as unsafe after their union", () => {
		const input = setup(fixture([[120, 150]]), 30);
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				segments: [span(100, 120), span(120, 140)],
			}),
		).toThrowError(expect.objectContaining({ code: "NO_SPEECH_SAFE_WINDOW" }));
	});
	it("falls back at an unknown context/source edge without claiming safe coverage", () => {
		const input = setup(fixture([[0, 60]], { frames: 120 }), 60);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(90, 100)],
		});
		expect(result).toMatchObject({
			status: "FALLBACK",
			reason: "BOUNDARY_COVERAGE_UNKNOWN",
			selection: input.anchor,
			rejectedBoundaryCount: 0,
		});
	});
	it("keeps a source-start anchor with an honest unknown warning instead of discarding content", () => {
		const input = setup(
			fixture([
				[0, 60],
				[90, 110],
			]),
			60,
		);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(115, 117)],
		});
		expect(result.status).toBe("FALLBACK");
		expect(result.reason).toBe("BOUNDARY_COVERAGE_UNKNOWN");
		expect(result.selection).toEqual(input.anchor);
		expect(result.selection.actualDurationFrames).toBe(60);
		expect(result.rejectedBoundaryCount).toBe(0);
	});
	it.each([
		"DURATION",
		"COHESION",
	] as const)("retains the 14-second Sintel fixture with observed ASR spans and source-edge warnings: %s", (policy) => {
		// Manual metadata reproduces the supplied real-ASR case, not provider AISA.
		const shots = [
			[0, 105],
			[105, 150],
			[150, 255],
			[255, 420],
		] as const;
		const base = fixture(shots, { frames: 420 });
		base.analysis = normalizeSceneAnalysis({
			metadata: { version: "manual-sintel-speech-regression" },
			duration: 14,
			scenes: shots.map(([from, to], index) => ({
				id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				type: "MAIN_CONTENT",
				startInSeconds: from / 30,
				endInSeconds: to / 30,
				shots: [{ startInSeconds: from / 30, endInSeconds: to / 30 }],
			})),
		});
		const input = setup(base, 450, policy);
		expect(input.anchor.actualDurationFrames).toBe(420);
		const segments = [
			{ startUs: 0, endUs: 2_500_000 },
			{ startUs: 6_500_000, endUs: 8_000_000 },
		];
		const result = refinePortraitSelectionBySpeech({ ...input, segments });
		expect(result.selection).toEqual(input.anchor);
		expect(result.selection.clips).toHaveLength(4);
		expect(result.selection.actualDurationFrames).toBe(420);
		expect(result.status).toBe("FALLBACK");
		expect(result.reason).toBe("BOUNDARY_COVERAGE_UNKNOWN");
		expect(result.intervals).toEqual(segments);
		expect(result.rejectedBoundaryCount).toBe(0);
	});
	it.each([
		"DURATION",
		"COHESION",
	] as const)("keeps strict reselection at an internal context cap instead of using the source-edge exception: %s", (policy) => {
		const input = setup(
			fixture(
				[
					[300, 5700],
					[400, 5600],
				],
				{ frames: 9000 },
			),
			5400,
			policy,
		);
		expect(input.context).toMatchObject({
			fromFrame: 300,
			toFrame: 5700,
			clipped: true,
		});
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(350, 360)],
		});
		expect(result.status).toBe("APPLIED");
		expect(result.selection.actualDurationFrames).toBe(5200);
		expect(result.selection.clips[0]?.shotIndex).toBe(1);
	});
	it.each([
		"DURATION",
		"COHESION",
	] as const)("still rejects a known speech cut when the other anchor edge is the true source start: %s", (policy) => {
		const input = setup(
			fixture(
				[
					[0, 30],
					[30, 90],
					[90, 120],
					[120, 180],
				],
				{ frames: 180 },
			),
			120,
			policy,
		);
		expect(input.anchor.actualDurationFrames).toBe(120);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(0, 15), span(45, 60), span(105, 135)],
		});
		expect(result.status).toBe("APPLIED");
		expect(result.selection.actualDurationFrames).toBe(60);
		expect(result.selection.clips[0]?.shotIndex).toBe(1);
		expect(result.rejectedBoundaryCount).toBeGreaterThan(0);
	});
	it("does not let a source-end unknown override a known unsafe start", () => {
		const input = setup(fixture([[60, 120]], { frames: 120 }), 60);
		expect(() =>
			refinePortraitSelectionBySpeech({ ...input, segments: [span(50, 70)] }),
		).toThrowError(expect.objectContaining({ code: "NO_SPEECH_SAFE_WINDOW" }));
	});
	it("checks both sides of a source gap before retaining a source-edge anchor", () => {
		const input = setup(
			fixture(
				[
					[0, 30],
					[60, 90],
				],
				{ frames: 90 },
			),
			90,
		);
		const anchor = {
			...input.anchor,
			actualDurationFrames: 60,
			clips: [
				{ sourceInUs: 0, durationFrames: 30, sceneId: c, shotIndex: 0 },
				{ sourceInUs: 2_000_000, durationFrames: 30, sceneId: c, shotIndex: 1 },
			],
		};
		const context = buildSpeechContextWindow({
			selection: anchor,
			timeMap: input.timeMap,
		});
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				anchor,
				context,
				segments: [span(20, 70)],
			}),
		).toThrowError(expect.objectContaining({ code: "NO_SPEECH_SAFE_WINDOW" }));
	});
	it("never lets an unknown edge override a known unsafe other edge", () => {
		const input = setup(fixture([[0, 60]], { frames: 120 }), 60);
		expect(() =>
			refinePortraitSelectionBySpeech({ ...input, segments: [span(50, 70)] }),
		).toThrowError(expect.objectContaining({ code: "NO_SPEECH_SAFE_WINDOW" }));
	});
	it("keeps a partial source final-frame endpoint unknown", () => {
		const input = setup(fixture([[30, 31]], { frames: 31 }), 1);
		expect(
			refinePortraitSelectionBySpeech({ ...input, segments: [span(1, 2)] }),
		).toMatchObject({
			status: "FALLBACK",
			reason: "BOUNDARY_COVERAGE_UNKNOWN",
		});
	});
	it("keeps the unchanged metadata anchor with an explicit NO_SPEECH fallback", () => {
		const input = setup(fixture([[90, 150]]), 60);
		expect(refinePortraitSelectionBySpeech({ ...input, segments: [] })).toEqual(
			{
				selection: input.anchor,
				status: "FALLBACK",
				reason: "NO_SPEECH",
				intervals: [],
				rejectedBoundaryCount: 0,
			},
		);
	});
	it("keeps excluded overlap barriers and original alternate shot indices", () => {
		const base = fixture([
			[161, 211],
			[211, 241],
		]);
		const exclusion = normalizeSceneAnalysis({
			metadata: { version: "speech-exclusion" },
			duration: 20,
			scenes: [
				{
					id: a,
					type: "ADS",
					startInSeconds: 170 / 30,
					endInSeconds: 180 / 30,
				},
			],
		}).scenes;
		base.analysis.scenes.push(...exclusion);
		const result = refinePortraitSelectionBySpeech({
			...setup(base, 90),
			segments: [span(250, 260)],
		});
		expect(result.selection.clips.map((clip) => clip.shotIndex)).toEqual([1]);
		expect(result.selection.actualDurationFrames).toBe(30);
	});
	it("preserves overlapping whole-shot alternatives without trimming", () => {
		const input = setup(
			fixture([
				[90, 150],
				[120, 180],
				[150, 210],
			]),
			120,
		);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [span(80, 100)],
		});
		expect(result.selection.clips).toEqual([
			{ sourceInUs: 4_000_000, durationFrames: 60, sceneId: c, shotIndex: 1 },
		]);
	});
	it("keeps semantic query matching and original shot indices during reselection", () => {
		const base = fixture([
			[60, 90],
			[90, 120],
			[120, 150],
		]);
		const scene = base.analysis.scenes[0];
		if (!scene) throw new Error("Missing scene");
		scene.title = "Training";
		scene.shots.forEach((shot, index) => {
			shot.detailedDescription = index ? "goal" : "wide";
		});
		const result = refinePortraitSelectionBySpeech({
			...setup(base, 60, "COHESION", "goal"),
			segments: [span(80, 100)],
		});
		expect(result.selection.clips[0]?.shotIndex).toBe(2);
		expect(result.selection.reasonCodes).toContain("QUERY_CONTEXT_MATCH");
	});
});

describe("exact rational speech clocks and evidence limits", () => {
	it.each([
		1, 2, 164,
	])("does not round genuine speech across boundary frame %s", (frame) => {
		const origin = 111_111;
		const input = setup(
			fixture([[frame, frame + 1]], { origin, editingStart: 900 }),
			1,
		);
		const floor = Number((BigInt(frame) * 1_000_000n) / 30n);
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				segments: [{ startUs: origin + floor, endUs: origin + floor + 1 }],
			}),
		).toThrowError(expect.objectContaining({ code: "NO_SPEECH_SAFE_WINDOW" }));
	});
	it("retains genuine between-frame speech and accepts its exact outer endpoints", () => {
		const input = setup(fixture([[1, 2]]), 1);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [{ startUs: 33_334, endUs: 66_666 }],
		});
		expect(result.status).toBe("APPLIED");
		expect(result.rejectedBoundaryCount).toBe(0);
		expect(result.intervals).toEqual([{ startUs: 33_334, endUs: 66_666 }]);
	});
	it("compares strict speech interiors exactly at a very large original origin", () => {
		const origin = 9_000_000_000_000_000;
		const input = setup(fixture([[1, 2]], { origin }), 1);
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				segments: [{ startUs: origin + 33_333, endUs: origin + 33_334 }],
			}),
		).toThrowError(expect.objectContaining({ code: "NO_SPEECH_SAFE_WINDOW" }));
	});
	it("does not classify exact segment starts or ends as their strict interior", () => {
		const input = setup(fixture([[3, 6]]), 3);
		const result = refinePortraitSelectionBySpeech({
			...input,
			segments: [{ startUs: 100_000, endUs: 200_000 }],
		});
		expect(result.status).toBe("APPLIED");
	});
	it("rejects a fabricated extraction clock and invalid segment times", () => {
		const input = setup(fixture([[90, 120]]), 30);
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				context: { ...input.context, durationUs: input.context.durationUs + 1 },
				segments: [span(80, 85)],
			}),
		).toThrow(RangeError);
		for (const segments of [
			[{ startUs: -1, endUs: 1 }],
			[{ startUs: 2, endUs: 1 }],
			[{ startUs: 0.5, endUs: 1 }],
			[{ startUs: 0, endUs: Number.MAX_SAFE_INTEGER + 1 }],
		])
			expect(() =>
				refinePortraitSelectionBySpeech({ ...input, segments }),
			).toThrow(RangeError);
	});
	it("rejects excess ASR evidence instead of truncating it", () => {
		const input = setup(fixture([[90, 120]]), 30);
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				segments: Array.from({ length: 5001 }, () => ({
					startUs: 0,
					endUs: 1,
				})),
			}),
		).toThrowError(expect.objectContaining({ code: "SPEECH_EVIDENCE_LIMIT" }));
	});
	it("accepts exactly 5000 measured segments and unions a copy", () => {
		const input = setup(fixture([[90, 120]]), 30);
		const segments = Object.freeze(
			Array.from({ length: 5000 }, () =>
				Object.freeze({ startUs: 0, endUs: 1 }),
			),
		);
		expect(
			refinePortraitSelectionBySpeech({ ...input, segments }).intervals,
		).toEqual([{ startUs: 0, endUs: 1 }]);
		expect(segments).toHaveLength(5000);
	});
	it("does not truncate excessive whole-shot candidates during refinement", () => {
		const input = setup(fixture([[90, 120]]), 30);
		const scene = input.analysis.scenes[0];
		if (!scene) throw new Error("Missing scene");
		const analysis = {
			...input.analysis,
			scenes: [
				{
					...scene,
					shots: Array.from({ length: 10_001 }, () => scene.shots[0]),
				},
			],
		};
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				analysis,
				segments: [span(60, 70)],
			}),
		).toThrow(/candidate limit/i);
	});
});

describe("shared search budget and legacy compatibility", () => {
	it.each([
		[
			"DURATION",
			"3a7718da1836ce8210e03a616132ebc7653937d50563b40fef7b025ce03e7a90",
		],
		[
			"COHESION",
			"40bd4a6565e623fc1fd7266009828deeab912f91f4a6a78158714507cdac3965",
		],
		[
			"QUERY",
			"e5056691529860f5fa201e9aa8dee96f52a94769d53c42849d935592ae31945e",
		],
	])("keeps the pre-change legacy JSON SHA when no new options are present: %s", (policy, expected) => {
		const analysis = normalizeSceneAnalysis({
			metadata: { version: "speech-legacy-pin" },
			duration: 120,
			scenes: [
				{
					id: a,
					type: "MAIN_CONTENT",
					title: "Intro",
					startInSeconds: 0,
					endInSeconds: 2,
					shots: [{ startInSeconds: 0, endInSeconds: 2 }],
				},
				{
					id: b,
					type: "MAIN_CONTENT",
					title: "Goal",
					startInSeconds: 2,
					endInSeconds: 10,
					shots: [
						{ startInSeconds: 2, endInSeconds: 6 },
						{ startInSeconds: 6, endInSeconds: 10 },
					],
				},
			],
		});
		const timeMap = fixture([[0, 30]], { frames: 3600 }).timeMap;
		const input = {
			analysis,
			timeMap,
			targetDurationFrames: 300,
			...(policy === "QUERY" ? { query: "goal" } : {}),
		};
		const result =
			policy === "DURATION"
				? selectAutoPortraitClips(input)
				: selectSemanticPortraitClips(input);
		expect(
			createHash("sha256").update(JSON.stringify(result)).digest("hex"),
		).toBe(expected);
	});
	it("uses one 200k budget across v1, semantic delegated searches and later reselections", () => {
		const input = {
			...fixture(
				Array.from({ length: 1000 }, (_, frame) => [frame, frame + 1] as const),
				{ frames: 1200 },
			),
			targetDurationFrames: 20,
		};
		const budget = createPortraitSelectionSearchBudget();
		const first = selectAutoPortraitClips({ ...input, searchBudget: budget });
		const used = budget.usedExpansions;
		expect(used).toBeGreaterThan(0);
		expect(selectAutoPortraitClips(input)).toEqual(first);
		selectSemanticPortraitClips({ ...input, searchBudget: budget });
		expect(budget.usedExpansions).toBeGreaterThan(used * 2);
		let threw = false;
		for (let call = 0; call < 20 && !threw; call++) {
			try {
				selectAutoPortraitClips({ ...input, searchBudget: budget });
			} catch (error) {
				expect(error).toBeInstanceOf(RangeError);
				expect(String(error)).toMatch(/search limit/i);
				threw = true;
			}
		}
		expect(threw).toBe(true);
		expect(budget.usedExpansions).toBe(200_000);
		expect(selectAutoPortraitClips(input)).toEqual(first);
	});
	it("does not let a serialized budget object bypass the factory-owned search cap", () => {
		const input = fixture([[90, 120]]);
		expect(() =>
			selectAutoPortraitClips({
				...input,
				targetDurationFrames: 30,
				searchBudget: { usedExpansions: 0 },
			}),
		).toThrow(RangeError);
	});
	it("shares the final remaining expansion between strict and unknown fallback passes", () => {
		const searchBudget = createPortraitSelectionSearchBudget();
		const chain = {
			...fixture(
				Array.from({ length: 1000 }, (_, frame) => [frame, frame + 1] as const),
				{ frames: 1200 },
			),
			targetDurationFrames: 20,
			searchBudget,
		};
		for (let call = 0; call < 10; call++) selectAutoPortraitClips(chain);
		const single = {
			...fixture([[90, 120]]),
			targetDurationFrames: 30,
			searchBudget,
		};
		const remaining = 199_999 - searchBudget.usedExpansions;
		expect(remaining).toBeGreaterThan(0);
		for (let call = 0; call < remaining; call++)
			selectAutoPortraitClips(single);
		expect(searchBudget.usedExpansions).toBe(199_999);
		const input = setup(fixture([[300, 5700]], { frames: 9000 }), 5400);
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				searchBudget,
				segments: [span(350, 360)],
			}),
		).toThrow(/search limit/i);
		expect(searchBudget.usedExpansions).toBe(200_000);
	});
});
