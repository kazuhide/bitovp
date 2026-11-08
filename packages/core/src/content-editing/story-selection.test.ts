import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	AutoPortraitSelectionError,
	createPortraitSelectionSearchBudget,
	selectAutoPortraitClips,
} from "./auto-portrait";
import type { StoryGraph, StoryModelInput } from "./story-contracts";
import { validateStoryGraph } from "./story-input";
import {
	buildStorySelection,
	selectStoryPortraitClips,
} from "./story-selection";

const sceneId = "11111111-1111-4111-8111-111111111111";
const mapId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";
function fixture(
	shots: readonly (readonly [number, number, string])[],
	options: { origin?: number; end?: number; editingStart?: number } = {},
) {
	const origin = options.origin ?? 0,
		end = options.end ?? Math.max(...shots.map((shot) => shot[1]));
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-story-selection-test" },
		duration: Math.max(end, ...shots.map((shot) => shot[1])),
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				startInSeconds: Math.min(...shots.map((shot) => shot[0])),
				endInSeconds: Math.max(...shots.map((shot) => shot[1])),
				shots: shots.map(([startInSeconds, endInSeconds, text]) => ({
					startInSeconds,
					endInSeconds,
					detailedDescription: text,
				})),
			},
		],
	});
	const input: StoryModelInput = {
		version: "aisa-story-input-v1",
		asset: { title: "", description: "" },
		coverage: {
			totalIntervals: shots.length,
			includedIntervals: shots.length,
			truncated: false,
		},
		intervals: shots.map(([startInSeconds, endInSeconds, text], shotIndex) => ({
			ref: `i${shotIndex}`,
			sceneId,
			shotIndex,
			startInSeconds,
			endInSeconds,
			text,
			entities: [],
		})),
	};
	return {
		analysis,
		timeMap: {
			id: mapId,
			mediaVersionId: mediaId,
			kind: "CFR",
			sourceStartUs: Math.round(origin * 1_000_000),
			sourceEndUs: Math.ceil(end * 1_000_000),
			editingStartFrame: options.editingStart ?? 0,
			editingEndFrame:
				(options.editingStart ?? 0) + Math.floor((end - origin) * 30),
			fps: { num: 30, den: 1 },
		},
		input,
	};
}
function event(
	index: number,
	role: StoryGraph["events"][number]["role"],
	dependsOn: string[] = [],
	importance = 3,
): StoryGraph["events"][number] {
	return {
		id: `event-${index}`,
		label: role,
		role,
		entityIds: [],
		evidence: [{ ref: `i${index}`, quote: "" }],
		dependsOn,
		importance,
	};
}
function story(
	input: StoryModelInput,
	events: StoryGraph["events"],
): {
	input: StoryModelInput;
	graph: StoryGraph;
} {
	return {
		input,
		graph: validateStoryGraph({
			input,
			graph: {
				version: "aisa-story-graph-v1",
				summary: "Authored semantic graph, not a provider result",
				keyEntities: [],
				events: events.map((item) => ({
					...item,
					evidence: item.evidence.map((ref) => ({
						...ref,
						quote:
							input.intervals.find((interval) => interval.ref === ref.ref)
								?.text ?? "missing",
					})),
				})),
				arcs: events.length
					? [
							{
								id: "arc",
								title: "A coherent arc",
								eventIds: events.map((e) => e.id),
							},
						]
					: [],
			},
		}),
	};
}

describe("experimental contiguous model-story selection", () => {
	it("retains causal setup, change and outcome ahead of an isolated spectacular event", () => {
		const f = fixture([
			[0, 5, "A flash fills the sky"],
			[5, 10, "Clouds move"],
			[10, 15, "A bird is trapped behind a closed gate"],
			[15, 20, "The robot opens the gate for the trapped bird"],
			[20, 25, "The freed bird flies away"],
		]);
		const value = story(f.input, [
			event(0, "REACTION", [], 5),
			event(2, "SETUP"),
			event(3, "CHANGE", ["event-2"]),
			event(4, "OUTCOME", ["event-3"]),
		]);
		value.graph.arcs = [
			{ id: "spectacle", title: "A flash", eventIds: ["event-0"] },
			{
				id: "rescue",
				title: "A bird is freed",
				eventIds: ["event-2", "event-3", "event-4"],
			},
		];
		const before = JSON.stringify({ f, value });
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 450,
		});
		expect(selected.policyVersion).toBe("aisa-story-window-v1");
		expect(selected.clips.map((clip) => clip.shotIndex)).toEqual([2, 3, 4]);
		expect(selected.actualDurationFrames).toBe(450);
		expect(selected.storySelection).toEqual({
			selectedArcId: "rescue",
			selectedEventIds: ["event-2", "event-3", "event-4"],
			reason: "CONNECTED_ARC",
		});
		expect(JSON.stringify({ f, value })).toBe(before);
	});
	it("reports partial coverage when a full arc cannot fit one contiguous whole-shot window", () => {
		const f = fixture([
			[0, 5, "The bird is trapped"],
			[20, 25, "The gate is opened"],
			[40, 45, "The bird is free"],
		]);
		const value = story(f.input, [
			event(0, "SETUP"),
			event(1, "CHANGE", ["event-0"]),
			event(2, "OUTCOME", ["event-1"]),
		]);
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 450,
		});
		expect(selected.clips).toHaveLength(1);
		expect(selected.actualDurationFrames).toBe(150);
		expect(selected.storySelection.reason).toBe("PARTIAL_ARC");
		expect(selected.storySelection.selectedEventIds).toHaveLength(1);
	});
	it("rebuilds coverage from final clips without retaining absent dependencies or arc claims", () => {
		const f = fixture([
			[0, 1, "The bird is trapped"],
			[1, 2, "The gate is opened"],
			[2, 3, "The bird is free"],
		]);
		const value = story(f.input, [
			event(0, "SETUP"),
			event(1, "CHANGE", ["event-0"]),
			event(2, "OUTCOME", ["event-1"]),
		]);
		expect(
			buildStorySelection({
				...value,
				clips: [
					{ sceneId, shotIndex: 2, sourceInUs: 2_000_000, durationFrames: 30 },
				],
			}),
		).toEqual({
			selectedArcId: "arc",
			selectedEventIds: ["event-2"],
			reason: "PARTIAL_ARC",
		});
	});
	it("rejects model interval references that do not exist in the original analysis", () => {
		const f = fixture([[0, 1, "A gate opens"]]);
		const value = story(f.input, [event(0, "CHANGE")]);
		value.input.intervals = value.input.intervals.map((interval) => ({
			...interval,
			shotIndex: 4,
		}));
		expect(() =>
			selectStoryPortraitClips({
				...f,
				story: value,
				targetDurationFrames: 30,
			}),
		).toThrow("STORY_REFERENCE_INVALID");
	});
	it("skips raw intervals ten milliseconds outside the source before consulting prepared bounds", () => {
		const f = fixture(
			[
				[9.99, 10.5, "The locked gate is found"],
				[10, 10.5, "The gate is opened"],
				[10.5, 11.01, "The bird leaves"],
			],
			{ origin: 10, end: 11 },
		);
		const value = story(f.input, [
			event(0, "SETUP"),
			event(1, "CHANGE"),
			event(2, "OUTCOME", ["event-1"]),
		]);
		const calls: number[] = [];
		const selected = selectStoryPortraitClips(
			{ ...f, story: value, targetDurationFrames: 30 },
			(_id, index) => {
				if (index !== 1) throw new Error("Out-of-source resolver call");
				calls.push(index);
				return { fromFrame: 0, toFrame: 15 };
			},
		);
		expect(selected.clips).toEqual([
			{ sceneId, shotIndex: 1, sourceInUs: 10_000_000, durationFrames: 15 },
		]);
		expect(new Set(calls)).toEqual(new Set([1]));
		expect(selected.storySelection.selectedEventIds).toEqual(["event-1"]);
	});
	it("retains nonzero source and editing origins and rejects serialized search budgets", () => {
		const f = fixture(
			[[2.111111, 4.111111, "The gate opens and the bird leaves"]],
			{ origin: 0.111111, end: 6.111111, editingStart: 900 },
		);
		const value = story(f.input, [event(0, "OUTCOME")]);
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 60,
			searchBudget: createPortraitSelectionSearchBudget(),
		});
		expect(selected.clips).toEqual([
			{ sceneId, shotIndex: 0, sourceInUs: 2_111_111, durationFrames: 60 },
		]);
		expect(() =>
			selectStoryPortraitClips({
				...f,
				story: value,
				targetDurationFrames: 60,
				searchBudget: { usedExpansions: 0 },
			}),
		).toThrow("factory-owned");
	});
	it("does not claim a connected arc for independent roles or a reversed causal sequence", () => {
		const f = fixture([
			[0, 1, "The gate is closed"],
			[1, 2, "The gate opens"],
			[2, 3, "The bird is free"],
		]);
		for (const events of [
			[event(0, "SETUP"), event(1, "CHANGE"), event(2, "OUTCOME")],
			[
				event(0, "OUTCOME", ["event-1"]),
				event(1, "CHANGE", ["event-2"]),
				event(2, "SETUP"),
			],
		]) {
			const selected = selectStoryPortraitClips({
				...f,
				story: story(f.input, events),
				targetDurationFrames: 90,
			});
			expect(selected.clips.map((clip) => clip.shotIndex)).toEqual([0, 1, 2]);
			expect(selected.storySelection.reason).toBe("PARTIAL_ARC");
		}
	});
	it("keeps excluded overlays and caller predicates authoritative over the model arc", () => {
		const f = fixture([
			[0, 2, "A bright flash"],
			[2, 4, "A hidden gate"],
			[4, 6, "A bird escapes"],
		]);
		const value = story(f.input, [
			event(0, "SETUP"),
			event(1, "CHANGE", ["event-0"]),
			event(2, "OUTCOME", ["event-1"]),
		]);
		const excluded = normalizeSceneAnalysis({
			metadata: { version: "overlay" },
			duration: 6,
			scenes: [{ id: mapId, type: "ADS", startInSeconds: 1, endInSeconds: 2 }],
		});
		f.analysis.scenes.push(...excluded.scenes);
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 180,
			acceptWindow: (window) => window.fromFrame >= 120,
		});
		expect(selected.clips.map((clip) => clip.shotIndex)).toEqual([2]);
		expect(selected.actualDurationFrames).toBe(60);
		expect(selected.storySelection.reason).toBe("PARTIAL_ARC");
	});
	it("retains an honest metadata-insufficient baseline and never fabricates an eligible window", () => {
		const f = fixture([[0, 2, "A quiet sky"]]);
		const value = story(f.input, []);
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 60,
		});
		expect(selected.storySelection).toEqual({
			selectedEventIds: [],
			reason: "METADATA_INSUFFICIENT",
		});
		expect(() =>
			selectStoryPortraitClips({
				...f,
				story: value,
				targetDurationFrames: 30,
			}),
		).toThrow(AutoPortraitSelectionError);
	});
	it("does not replace a useful full-length baseline with a much shorter model arc", () => {
		const f = fixture([
			[0, 10, "A quiet sky"],
			[20, 21, "The closed gate"],
			[21, 22, "The gate opens"],
			[22, 23, "The bird is free"],
		]);
		const value = story(f.input, [
			event(1, "SETUP"),
			event(2, "CHANGE", ["event-1"]),
			event(3, "OUTCOME", ["event-2"]),
		]);
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 300,
		});
		expect(selected.clips.map((clip) => clip.shotIndex)).toEqual([0]);
		expect(selected.actualDurationFrames).toBe(300);
		expect(selected.storySelection.reason).toBe("METADATA_INSUFFICIENT");
	});
	it("includes dependencies outside an arc's event list in connected coverage", () => {
		const f = fixture([
			[0, 1, "The gate is closed"],
			[1, 2, "The gate opens"],
			[2, 3, "The bird is free"],
		]);
		const value = story(f.input, [
			event(0, "SETUP"),
			event(1, "CHANGE", ["event-0"]),
			event(2, "OUTCOME", ["event-1"]),
		]);
		value.graph.arcs = [
			{ id: "arc", title: "A bird is freed", eventIds: ["event-2"] },
		];
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 90,
		});
		expect(selected.storySelection).toEqual({
			selectedArcId: "arc",
			selectedEventIds: ["event-0", "event-1", "event-2"],
			reason: "CONNECTED_ARC",
		});
	});
	it("honors the canonical twenty-clip and 5400-frame caps without trimming or repeating an event", () => {
		const f = fixture(
			Array.from(
				{ length: 21 },
				(_, index) =>
					[index, index + 1, `Observed story interval ${index}`] as const,
			),
		);
		const value = story(f.input, [
			event(0, "SETUP"),
			event(10, "CHANGE", ["event-0"]),
			event(20, "OUTCOME", ["event-10"]),
		]);
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 630,
		});
		expect(selected.clips.map((clip) => clip.shotIndex)).toEqual(
			Array.from({ length: 20 }, (_, index) => index),
		);
		expect(selected.actualDurationFrames).toBe(600);
		expect(selected.reasonCodes).toContain("CLIP_LIMIT_REACHED");
		expect(selected.storySelection.reason).toBe("PARTIAL_ARC");
		expect(() =>
			selectStoryPortraitClips({
				...f,
				story: value,
				targetDurationFrames: 5401,
			}),
		).toThrow("1..5400");
	});
	it("falls back to the validated baseline when optional model ranking exhausts the shared search budget", () => {
		const f = fixture([
			[0, 1, "The gate is closed"],
			[1, 2, "The gate opens"],
		]);
		const value = story(f.input, [
			event(0, "SETUP"),
			event(1, "CHANGE", ["event-0"]),
		]);
		const probeBudget = createPortraitSelectionSearchBudget();
		const baseline = selectAutoPortraitClips({
			...f,
			targetDurationFrames: 30,
			searchBudget: probeBudget,
		});
		const searchBudget = createPortraitSelectionSearchBudget();
		const chain = fixture(
			Array.from(
				{ length: 1000 },
				(_, i) => [i / 30, (i + 1) / 30, "A quiet frame"] as const,
			),
		);
		for (let i = 0; i < 10; i++)
			selectAutoPortraitClips({
				...chain,
				targetDurationFrames: 20,
				searchBudget,
			});
		const single = fixture([[0, 1, "A quiet sky"]]);
		const remaining =
			199_999 - probeBudget.usedExpansions - searchBudget.usedExpansions;
		expect(remaining).toBeGreaterThan(0);
		for (let i = 0; i < remaining; i++)
			selectAutoPortraitClips({
				...single,
				targetDurationFrames: 30,
				searchBudget,
			});
		const selected = selectStoryPortraitClips({
			...f,
			story: value,
			targetDurationFrames: 30,
			searchBudget,
		});
		expect(selected.clips).toEqual(baseline.clips);
		expect(selected.storySelection.reason).toBe("SEARCH_BUDGET");
		expect(searchBudget.usedExpansions).toBe(200_000);
	});
});
