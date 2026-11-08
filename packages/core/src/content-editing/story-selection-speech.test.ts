import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	createPortraitSelectionSearchBudget,
	selectAutoPortraitClips,
} from "./auto-portrait";
import {
	buildSpeechContextWindow,
	refinePortraitSelectionBySpeech,
} from "./speech-boundaries";
import { buildStoryModelInput, validateStoryGraph } from "./story-input";
import { selectStoryPortraitClips } from "./story-selection";

function fixture() {
	const sceneId = "11111111-1111-4111-8111-111111111111";
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-story-speech" },
		duration: 5,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 5,
				shots: [
					"The sky is still",
					"The bird is trapped",
					"The robot opens the gate",
					"The bird flies free",
					"Clouds drift",
				].map((detailedDescription, index) => ({
					startInSeconds: index,
					endInSeconds: index + 1,
					detailedDescription,
				})),
			},
		],
	});
	const timeMap = {
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 5_000_000,
		editingStartFrame: 0,
		editingEndFrame: 150,
		fps: { num: 30, den: 1 },
	};
	const input = buildStoryModelInput({ analysis, timeMap });
	const graph = validateStoryGraph({
		input,
		graph: {
			version: "aisa-story-graph-v1",
			summary: "A bird is freed",
			keyEntities: [],
			events: [1, 2, 3].map((shotIndex, index) => ({
				id: `event${index}`,
				label: "A grounded event",
				role: ["SETUP", "CHANGE", "OUTCOME"][index],
				entityIds: [],
				evidence: [
					{ ref: `i${shotIndex}`, quote: input.intervals[shotIndex]?.text },
				],
				dependsOn: index ? [`event${index - 1}`] : [],
				importance: 3,
			})),
			arcs: [
				{
					id: "arc",
					title: "A bird is freed",
					eventIds: ["event0", "event1", "event2"],
				},
			],
		},
	});
	const story = { input, graph },
		searchBudget = createPortraitSelectionSearchBudget(),
		targetDurationFrames = 90;
	const anchor = selectStoryPortraitClips({
		analysis,
		timeMap,
		story,
		searchBudget,
		targetDurationFrames,
	});
	return {
		analysis,
		timeMap,
		story,
		searchBudget,
		targetDurationFrames,
		anchor,
		policy: "STORY" as const,
		context: buildSpeechContextWindow({ selection: anchor, timeMap }),
	};
}

describe("speech-safe model-story reselection", () => {
	it("reselects through STORY and rebuilds the actual partial causal coverage", () => {
		const f = fixture();
		expect(f.anchor.clips.map((clip) => clip.shotIndex)).toEqual([1, 2, 3]);
		const result = refinePortraitSelectionBySpeech({
			...f,
			segments: [{ startUs: 3_500_000, endUs: 4_500_000 }],
		});
		expect(result.status).toBe("APPLIED");
		expect(result.selection.policyVersion).toBe("aisa-story-window-v1");
		expect(result.selection.clips.map((clip) => clip.shotIndex)).toEqual([
			1, 2,
		]);
		expect(
			"storySelection" in result.selection && result.selection.storySelection,
		).toEqual({
			selectedArcId: "arc",
			selectedEventIds: ["event0", "event1"],
			reason: "PARTIAL_ARC",
		});
		expect(result.rejectedBoundaryCount).toBeGreaterThan(0);
	});
	it("retains unchanged story evidence when ASR observes no speech", () => {
		const f = fixture();
		expect(refinePortraitSelectionBySpeech({ ...f, segments: [] })).toEqual({
			selection: f.anchor,
			status: "FALLBACK",
			reason: "NO_SPEECH",
			intervals: [],
			rejectedBoundaryCount: 0,
		});
	});
	it("requires the story intent and forbids even an empty query during reselection", () => {
		const f = fixture();
		expect(() =>
			refinePortraitSelectionBySpeech({ ...f, story: undefined, segments: [] }),
		).toThrow("anchor intent");
		expect(() =>
			refinePortraitSelectionBySpeech({ ...f, query: "", segments: [] }),
		).toThrow("anchor intent");
	});
	it("retains observed intervals in a typed STORY failure when the shared search cap is exhausted", () => {
		const f = fixture(),
			searchBudget = createPortraitSelectionSearchBudget();
		const sceneId = f.analysis.scenes[0]?.id;
		const analysis = normalizeSceneAnalysis({
			metadata: { version: "search-budget-drain" },
			duration: 1000 / 30,
			scenes: [
				{
					id: sceneId,
					type: "MAIN_CONTENT",
					startInSeconds: 0,
					endInSeconds: 1000 / 30,
					shots: Array.from({ length: 1000 }, (_, i) => ({
						startInSeconds: i / 30,
						endInSeconds: (i + 1) / 30,
					})),
				},
			],
		});
		const timeMap = {
			...f.timeMap,
			sourceEndUs: 33_333_334,
			editingEndFrame: 1000,
		};
		for (let i = 0; i < 10; i++)
			selectAutoPortraitClips({
				analysis,
				timeMap,
				targetDurationFrames: 20,
				searchBudget,
			});
		const single = normalizeSceneAnalysis({
			metadata: { version: "remaining-budget" },
			duration: 1,
			scenes: [
				{
					id: sceneId,
					type: "MAIN_CONTENT",
					startInSeconds: 0,
					endInSeconds: 1,
					shots: [{ startInSeconds: 0, endInSeconds: 1 }],
				},
			],
		});
		const remaining = 199_999 - searchBudget.usedExpansions;
		expect(remaining).toBeGreaterThan(0);
		for (let i = 0; i < remaining; i++)
			selectAutoPortraitClips({
				analysis: single,
				timeMap: { ...f.timeMap, sourceEndUs: 1_000_000, editingEndFrame: 30 },
				targetDurationFrames: 30,
				searchBudget,
			});
		const segments = [{ startUs: 3_500_000, endUs: 4_500_000 }];
		expect(() =>
			refinePortraitSelectionBySpeech({ ...f, searchBudget, segments }),
		).toThrowError(
			expect.objectContaining({
				code: "SPEECH_SELECTION_SEARCH_LIMIT",
				evidence: { intervals: segments, rejectedBoundaryCount: 1 },
			}),
		);
		expect(searchBudget.usedExpansions).toBe(200_000);
	});
});
