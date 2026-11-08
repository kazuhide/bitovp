import { describe, expect, it } from "vitest";
import { createPortraitSelectionSearchBudget } from "./auto-portrait";
import {
	buildPreparedShotPartition,
	selectPreparedPortraitClips,
} from "./prepared-shot-partition";
import {
	fixtureItem,
	preparedClockFixture,
	preparedSceneId,
} from "./prepared-shot-partition.test-fixtures";
import {
	buildSpeechContextWindow,
	refinePortraitSelectionBySpeech,
} from "./speech-boundaries";
import { buildStoryModelInput, validateStoryGraph } from "./story-input";

function fixture() {
	const f = preparedClockFixture();
	const shots = fixtureItem(f.analysis.scenes[0]).shots;
	shots.forEach((shot, index) => {
		shot.detailedDescription = `The bird's story, observed shot ${index}`;
	});
	const input = buildStoryModelInput(f);
	const graph = validateStoryGraph({
		input,
		graph: {
			version: "aisa-story-graph-v1",
			summary: "Authored prepared-clock graph",
			keyEntities: [],
			events: [0, 2, 4].map((shotIndex, index) => ({
				id: `event${index}`,
				label: "A grounded event",
				role: ["SETUP", "CHANGE", "OUTCOME"][index],
				entityIds: [],
				evidence: [
					{
						ref: `i${shotIndex}`,
						quote: fixtureItem(
							input.intervals.find((item) => item.shotIndex === shotIndex),
						).text,
					},
				],
				dependsOn: index ? [`event${index - 1}`] : [],
				importance: 3,
			})),
			arcs: [
				{
					id: "arc",
					title: "The bird's arc",
					eventIds: ["event0", "event1", "event2"],
				},
			],
		},
	});
	return {
		...f,
		story: { input, graph },
		partition: buildPreparedShotPartition({ ...f, normalization: f.proof }),
	};
}

describe("model-story selection on the factory-owned prepared clock", () => {
	it("retains raw cut adjacency, original shot indices and the immutable clock receipt", () => {
		const f = fixture();
		const selected = selectPreparedPortraitClips({
			partition: f.partition,
			targetDurationFrames: 60,
			policy: "STORY",
			story: f.story,
		});
		expect(selected.policyVersion).toBe("aisa-prepared-story-window-v1");
		expect(selected.normalizationReceiptHash).toBe(
			f.partition.normalizationReceiptHash,
		);
		expect(selected.clips.map((clip) => clip.sceneId)).toEqual(
			Array(5).fill(preparedSceneId),
		);
		expect(selected.clips.map((clip) => clip.shotIndex)).toEqual([
			0, 1, 2, 3, 4,
		]);
		expect(selected.clips.map((clip) => clip.durationFrames)).toEqual([
			2, 1, 1, 1, 55,
		]);
		expect(selected.reasonCodes).toContain("BOUNDARY_FIT_GUARD");
		expect(selected.storySelection).toEqual({
			selectedArcId: "arc",
			selectedEventIds: ["event0", "event1", "event2"],
			reason: "CONNECTED_ARC",
		});
	});
	it("rejects a copied partition and requires explicit story metadata without a query", () => {
		const f = fixture();
		expect(() =>
			selectPreparedPortraitClips({
				partition: { ...f.partition },
				targetDurationFrames: 60,
				policy: "STORY",
				story: f.story,
			}),
		).toThrow("PREPARED_PARTITION_FACTORY_REQUIRED");
		expect(() =>
			selectPreparedPortraitClips({
				partition: f.partition,
				targetDurationFrames: 60,
				policy: "STORY",
			}),
		).toThrow("PREPARED_STORY_REQUIRED");
		expect(() =>
			selectPreparedPortraitClips({
				partition: f.partition,
				targetDurationFrames: 60,
				policy: "STORY",
				story: f.story,
				query: "",
			}),
		).toThrow("PREPARED_STORY_QUERY_FORBIDDEN");
	});
	it("keeps STORY evidence and its clock through observed no-speech refinement", () => {
		const f = fixture(),
			searchBudget = createPortraitSelectionSearchBudget();
		const anchor = selectPreparedPortraitClips({
			partition: f.partition,
			targetDurationFrames: 60,
			policy: "STORY",
			story: f.story,
			searchBudget,
		});
		const input = {
			analysis: f.analysis,
			timeMap: f.timeMap,
			targetDurationFrames: 60,
			policy: "STORY" as const,
			story: f.story,
			anchor,
			searchBudget,
			preparedPartition: f.partition,
			context: buildSpeechContextWindow({
				selection: anchor,
				timeMap: f.timeMap,
			}),
			segments: [],
		};
		expect(refinePortraitSelectionBySpeech(input)).toMatchObject({
			selection: anchor,
			status: "FALLBACK",
			reason: "NO_SPEECH",
		});
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				anchor: { ...anchor, normalizationReceiptHash: "f".repeat(64) },
			}),
		).toThrow("Prepared speech anchor clock mismatch");
	});
});
