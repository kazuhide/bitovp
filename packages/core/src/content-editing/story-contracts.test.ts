import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	generationTaskParametersSchema,
	mediaTaskEnvelopeSchema,
} from "../content-production/schema";
import {
	type StoryGraph,
	storyEvidenceSchema,
	storyGraphSchema,
	storyModelIdentitySchema,
} from "./story-contracts";
import { buildStoryModelInput, validateStoryGraph } from "./story-input";

const id = "00000000-0000-4000-8000-000000000001";
const map = {
	id,
	mediaVersionId: id,
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 2_000_000,
	editingStartFrame: 0,
	editingEndFrame: 60,
	fps: { num: 30, den: 1 },
};
const analysis = normalizeSceneAnalysis({
	metadata: { version: "story-test" },
	duration: 3,
	title: "Rabbit story",
	scenes: [
		{
			id,
			type: "MAIN_CONTENT",
			startInSeconds: 0,
			endInSeconds: 3,
			shots: [
				{
					startInSeconds: 0,
					endInSeconds: 1,
					detailedDescription: "The rabbit builds a trap.",
				},
				{
					startInSeconds: 1,
					endInSeconds: 2,
					detailedDescription: "The trap catches the ball.",
				},
				{
					startInSeconds: 2,
					endInSeconds: 3,
					detailedDescription: "The rabbit celebrates victory.",
				},
			],
		},
	],
});
const input = buildStoryModelInput({ analysis, timeMap: map });
const graph: StoryGraph = {
	version: "aisa-story-graph-v1",
	summary: "A rabbit builds a trap and catches a ball.",
	keyEntities: [{ id: "E1", label: "Trap", kind: "OBJECT", refs: ["i0"] }],
	events: [
		{
			id: "V1",
			label: "Prepare trap",
			role: "SETUP",
			entityIds: ["E1"],
			evidence: [{ ref: "i0", quote: "rabbit builds a trap" }],
			dependsOn: [],
			importance: 3,
		},
		{
			id: "V2",
			label: "Catch ball",
			role: "OUTCOME",
			entityIds: ["E1"],
			evidence: [{ ref: "i1", quote: "trap catches the ball" }],
			dependsOn: ["V1"],
			importance: 5,
		},
	],
	arcs: [{ id: "A1", title: "The trap works", eventIds: ["V1", "V2"] }],
};
// Historical evidence remains readable after its runtime provider is withdrawn.
const identity = storyModelIdentitySchema.parse({
	version: "aisa-story-model-v1",
	provider: "CODEX_CLI",
	model: "historical-fixture-model",
	promptVersion: "aisa-story-prompt-v1",
	schemaHash: "a".repeat(64),
	configId: id,
});

describe("grounded story extraction contracts", () => {
	it("validates the selected arc closure independently of incidental observed events", () => {
		const event = (
			id: string,
			role: StoryGraph["events"][number]["role"],
			dependsOn: string[],
		) => ({ ...graph.events[0], id, label: id, role, dependsOn });
		const evidence = {
			version: "aisa-story-evidence-v1",
			method: "MODEL_EVENT_GRAPH",
			model: identity,
			inputHash: "a".repeat(64),
			artifactHash: "b".repeat(64),
			inputCoverage: input.coverage,
			graph: {
				...graph,
				events: [
					event("V0", "CONTEXT", []),
					event("V1", "SETUP", []),
					event("V2", "CHANGE", ["V1"]),
					event("V3", "OUTCOME", ["V2"]),
					event("V4", "REACTION", ["V0"]),
				],
				arcs: [{ id: "A1", title: "Rescue", eventIds: ["V3"] }],
			},
			selection: {
				selectedArcId: "A1",
				selectedEventIds: ["V1", "V2", "V3", "V4"],
				reason: "CONNECTED_ARC",
			},
		};
		// V4 is observed in the same passage, without claiming its subplot is complete.
		expect(storyEvidenceSchema.safeParse(evidence).success).toBe(true);
		const missingSetup = structuredClone(evidence);
		missingSetup.selection.selectedEventIds = ["V2", "V3", "V4"];
		expect(storyEvidenceSchema.safeParse(missingSetup).success).toBe(false);
		const disconnected = structuredClone(evidence);
		const change = disconnected.graph.events[2];
		if (!change) throw new Error("fixture");
		change.dependsOn = [];
		expect(storyEvidenceSchema.safeParse(disconnected).success).toBe(false);
		for (const selection of [
			{ ...evidence.selection, selectedEventIds: ["invented"] },
			{ ...evidence.selection, selectedArcId: "invented" },
			{ ...evidence.selection, selectedEventIds: ["V1", "V1"] },
			{ ...evidence.selection, reason: "METADATA_INSUFFICIENT" },
			{ selectedEventIds: [], reason: "PARTIAL_ARC" },
		])
			expect(
				storyEvidenceSchema.safeParse({ ...evidence, selection }).success,
			).toBe(false);
	});
	it("excludes source overruns without clamping times or modifying analysis", () => {
		expect(input.intervals.map((i) => i.shotIndex)).toEqual([0, 1]);
		expect(input.intervals[1]?.endInSeconds).toBe(2);
		expect(analysis.scenes[0]?.shots[2]?.endInSeconds).toBe(3);
		expect(validateStoryGraph({ input, graph })).toEqual(graph);
	});
	it("rejects fabricated quotes, references, model timestamps and cyclic dependencies", () => {
		for (const edit of [
			(g: StoryGraph) => {
				g.events[0]?.evidence.push({ ref: "i9", quote: "not supplied" });
			},
			(g: StoryGraph) => {
				g.events[0]?.evidence.splice(0, 1, {
					ref: "i0",
					quote: "the trap explodes",
				});
			},
			(g: StoryGraph) => {
				g.events[0]?.dependsOn.push("V2");
			},
			(g: StoryGraph) => {
				g.keyEntities.push({
					id: "E1",
					label: "Other",
					kind: "OBJECT",
					refs: ["i0"],
				});
			},
		]) {
			const changed = structuredClone(graph);
			edit(changed);
			expect(() => validateStoryGraph({ input, graph: changed })).toThrow();
		}
		expect(
			storyGraphSchema.safeParse({ ...graph, inventedTime: 1.5 }).success,
		).toBe(false);
	});
	it("samples large metadata deterministically with explicit coverage and a byte bound", () => {
		const many = structuredClone(analysis);
		const scene = many.scenes[0];
		if (!scene) throw new Error("fixture");
		scene.shots = Array.from({ length: 250 }, () => ({
			...scene.shots[0],
			startInSeconds: 0,
			endInSeconds: 1,
			detailedDescription: "被写体と重要な道具の関係を記述する。".repeat(50),
			keywords: [],
			mainSubjects: [],
			shotAdvisories: undefined,
		}));
		const sampled = buildStoryModelInput({ analysis: many, timeMap: map });
		expect(sampled.coverage.totalIntervals).toBe(250);
		expect(sampled.coverage.truncated).toBe(true);
		expect(sampled.intervals.length).toBeLessThanOrEqual(192);
		expect(
			new TextEncoder().encode(JSON.stringify(sampled)).byteLength,
		).toBeLessThanOrEqual(96 * 1024);
		expect(buildStoryModelInput({ analysis: many, timeMap: map })).toEqual(
			sampled,
		);
	});
	it("is explicitly opt-in DRAFT with pinned model identity, preserving absent-policy defaults", () => {
		const parameters = { contentId: id, targetDurationFrames: 60 };
		expect(generationTaskParametersSchema.parse(parameters).policy).toBe(
			"COHESION",
		);
		const story = { ...parameters, renderMode: "DRAFT", policy: "STORY" };
		expect(generationTaskParametersSchema.parse(story).policy).toBe("STORY");
		for (const change of [
			{ query: "" },
			{ query: "  " },
			{ renderMode: "EXPORT" },
			{ renderMode: undefined },
		])
			expect(
				generationTaskParametersSchema.safeParse({ ...story, ...change })
					.success,
			).toBe(false);
		const envelope = {
			schemaVersion: 1,
			input: {
				kind: "GENERATE",
				requestKey: id,
				mediaVersionId: id,
				analysisRevisionId: id,
				parameters: story,
			},
			identity: {
				organizationId: id,
				mediaSha256: null,
				modelSha256: null,
				analysisDocumentHash: null,
				analysisRawHash: null,
				timeMapHash: null,
				storyModel: identity,
			},
		};
		expect(mediaTaskEnvelopeSchema.safeParse(envelope).success).toBe(true);
		expect(
			mediaTaskEnvelopeSchema.safeParse({
				...envelope,
				identity: { ...envelope.identity, storyModel: undefined },
			}).success,
		).toBe(false);
	});
});
