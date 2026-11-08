import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { selectSemanticPortraitClips } from "./semantic-portrait";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const map = {
	id: a,
	mediaVersionId: b,
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 120_000_000,
	editingStartFrame: 0,
	editingEndFrame: 3600,
	fps: { num: 30, den: 1 },
};
const scene = (
	id: string,
	from: number,
	to: number,
	text: string,
	score = 0,
) => ({
	id,
	startInSeconds: from,
	endInSeconds: to,
	type: "MAIN_CONTENT",
	title: text,
	adOpportunityInformation: { score },
	shots: [{ startInSeconds: from, endInSeconds: to }],
});
const analysis = (scenes: unknown[]) =>
	normalizeSceneAnalysis({
		metadata: { version: "semantic-test" },
		duration: 120,
		scenes,
	});
describe("metadata scene-cohesion policy v2", () => {
	it("prefers a coherent 8-second scene over a 10-second cross-scene window", () => {
		const result = selectSemanticPortraitClips({
			analysis: analysis([
				scene(a, 0, 2, "Intro", 1),
				scene(b, 2, 10, "Goal", 0),
			]),
			timeMap: map,
			targetDurationFrames: 300,
		});
		expect(result.policyVersion).toBe("aisa-scene-cohesion-v2");
		expect(result.actualDurationFrames).toBe(240);
		expect(result.clips.map((clip) => clip.sceneId)).toEqual([b]);
		expect(result.reasonCodes).toContain("SCENE_COHESION");
	});
	it("retains duration fallback when a single scene is less than 80 percent", () => {
		const result = selectSemanticPortraitClips({
			analysis: analysis([scene(a, 0, 5, "Run"), scene(b, 5, 10, "Finish")]),
			timeMap: map,
			targetDurationFrames: 300,
		});
		expect(result.actualDurationFrames).toBe(300);
		expect(result.reasonCodes).toContain("DURATION_FALLBACK");
	});
	it("uses actual normalized metadata and preserves original shot indexes", () => {
		const item = {
			...scene(a, 0, 6, "Training"),
			shots: [
				{
					startInSeconds: 0,
					endInSeconds: 2,
					detailedDescription: "wide shot",
				},
				{
					startInSeconds: 2,
					endInSeconds: 4,
					detailedDescription: "GOAL 瞬間",
				},
				{ startInSeconds: 4, endInSeconds: 6, detailedDescription: "crowd" },
			],
		};
		const result = selectSemanticPortraitClips({
			analysis: analysis([item, scene(b, 6, 10, "広告 goal", 1)]),
			timeMap: map,
			targetDurationFrames: 120,
			query: "ｇｏａｌ 瞬間",
		});
		expect(result.clips).toEqual([
			{ sceneId: a, shotIndex: 1, sourceInUs: 2_000_000, durationFrames: 60 },
		]);
		expect(result.reasonCodes).toContain("QUERY_CONTEXT_MATCH");
	});
	it("does not use ad scores as semantic quality or admit excluded scenes", () => {
		const scenes = [
			scene(a, 0, 3, "猫", 0),
			scene(b, 3, 6, "犬", 1),
			{ ...scene(c, 6, 9, "猫", 1), type: "ADS" },
		];
		expect(
			selectSemanticPortraitClips({
				analysis: analysis(scenes),
				timeMap: map,
				targetDurationFrames: 90,
				query: "猫",
			}).clips.map((clip) => clip.sceneId),
		).toEqual([a]);
		expect(() =>
			selectSemanticPortraitClips({
				analysis: analysis(scenes),
				timeMap: map,
				targetDurationFrames: 90,
				query: "存在しない",
			}),
		).toThrow("NO_ELIGIBLE_WINDOW");
	});
	it("keeps excluded overlap barriers even when other scenes are filtered", () => {
		const input = analysis([
			scene(a, 0, 6, "goal"),
			{ ...scene(b, 2, 3, "ad"), type: "ADS" },
		]);
		expect(() =>
			selectSemanticPortraitClips({
				analysis: input,
				timeMap: map,
				targetDurationFrames: 180,
				query: "goal",
			}),
		).toThrow("NO_ELIGIBLE_WINDOW");
	});
	it("explicitly bounds scenes and query terms instead of silently truncating search", () => {
		const scenes = Array.from({ length: 129 }, (_, index) =>
			scene(
				`00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
				index / 30,
				(index + 1) / 30,
				"x",
			),
		);
		expect(() =>
			selectSemanticPortraitClips({
				analysis: analysis(scenes),
				timeMap: map,
				targetDurationFrames: 30,
			}),
		).toThrow(RangeError);
		expect(() =>
			selectSemanticPortraitClips({
				analysis: analysis([scene(a, 0, 3, "x")]),
				timeMap: map,
				targetDurationFrames: 90,
				query: Array.from({ length: 33 }, (_, i) => `a${i}`).join(" "),
			}),
		).toThrow(RangeError);
	});
});
