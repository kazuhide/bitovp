import { randomUUID } from "node:crypto";
import {
	compositionDocumentSchema,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
	type StoryGraph,
	type StoryModelInput,
} from "@bitovp/core";
import { authoredNormalizationReceipt } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { createLibraryGenerationHandler } from "./generation";
import { generationDependencyFixture } from "./generation-dependency-fixture";

const modelIdentity = {
	version: "aisa-story-model-v1" as const,
	provider: "CODEX_CLI" as const,
	model: "fixture-story-model",
	promptVersion: "aisa-story-prompt-v1" as const,
	schemaHash: "f".repeat(64),
	configId: "b8d98e2e-a309-430a-9d91-e134c523064e",
};

function graphFor(input: StoryModelInput): StoryGraph {
	const events = input.intervals.slice(0, 3).map((interval, index) => ({
		id: `event-${index}`,
		label: interval.text.slice(0, 160),
		role: (["SETUP", "CHANGE", "OUTCOME"] as const)[index] ?? "CHANGE",
		entityIds: [],
		evidence: [{ ref: interval.ref, quote: interval.text.slice(0, 240) }],
		dependsOn: index ? [`event-${index - 1}`] : [],
		importance: 3,
	}));
	return {
		version: "aisa-story-graph-v1",
		summary: "Authored story-generation test graph",
		keyEntities: [],
		events,
		arcs: [
			{ id: "rescue", title: "Bird rescue", eventIds: events.map((e) => e.id) },
		],
	};
}
function fixture(captions: "OFF" | "AUTO" = "OFF") {
	const f = generationDependencyFixture(
		captions === "AUTO" ? "TRANSCRIBE" : "TRACK",
	);
	const descriptions = [
		"A bird is trapped behind the gate.",
		"A robot opens the gate for the trapped bird.",
		"The freed bird flies away.",
	];
	for (const [index, shot] of f.analysis.document.scenes
		.flatMap((scene) => scene.shots)
		.entries())
		shot.detailedDescription = descriptions[index] ?? "The bird is free.";
	f.analysis.rawHash = hashEditingEvidence(f.analysis.document);
	Object.assign(f.binding, {
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(f.analysis.document),
	});
	Object.assign(f.task.parameters.input.parameters, {
		policy: "STORY",
		renderMode: "DRAFT",
		targetDurationFrames: 180,
		captions,
		tracking: false,
	});
	delete f.task.parameters.input.parameters.trackingTaskId;
	Object.assign(f.task.parameters.identity, {
		storyModel: modelIdentity,
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: f.binding.analysisDocumentHash,
		bindingHash: hashEditingEvidence(f.binding),
	});
	f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
	f.task.cacheKey = mediaTaskCacheKey(
		f.task.parameters.input,
		f.task.parameters.identity,
	);
	const receipts: Array<Record<string, unknown>> = [];
	const prisma = {
		...f.prisma,
		libraryEvidenceReceipt: {
			findMany: async () =>
				receipts.filter((row) => row.kind === "NORMALIZATION_CAPTURE"),
			findUnique: async ({ where }: { where: { id: string } }) =>
				receipts.find((row) => row.id === where.id) ?? null,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				receipts.push(data);
				return data;
			},
		},
		$transaction: async <T>(fn: (tx: AppPrismaClient) => Promise<T>) =>
			fn(prisma as unknown as AppPrismaClient),
	} as unknown as AppPrismaClient;
	const extract = vi.fn(async ({ input }: { input: StoryModelInput }) =>
			graphFor(input),
		),
		storyModel = { identity: modelIdentity, extract };
	return {
		...f,
		prisma,
		receipts,
		extract,
		storyModel,
		run: () => createLibraryGenerationHandler({ prisma })(f.context),
		generate: () =>
			createLibraryGenerationHandler({ prisma, storyModel })(f.context),
		exports: vi.spyOn(f.prisma.renderRun, "create"),
	};
}

describe("experimental story generation", () => {
	it("rejects an unavailable story model without creating projects or exports", async () => {
		const f = fixture();
		await expect(f.run()).rejects.toMatchObject({
			code: "STORY_ENGINE_UNAVAILABLE",
		});
		expect(f.projects).toEqual([]);
		expect(f.revisions).toEqual([]);
		expect(f.exports).not.toHaveBeenCalled();
	});
	it("rejects changed model identity before extracting or publishing", async () => {
		const f = fixture(),
			extract = vi.fn();
		await expect(
			createLibraryGenerationHandler({
				prisma: f.prisma,
				storyModel: {
					identity: { ...modelIdentity, model: "a-different-model" },
					extract,
				},
			})(f.context),
		).rejects.toMatchObject({ code: "STORY_MODEL_CHANGED" });
		expect(extract).not.toHaveBeenCalled();
		expect(f.projects).toEqual([]);
		expect(f.exports).not.toHaveBeenCalled();
	});
	it("publishes a reviewable story timeline and immutable model evidence without exporting", async () => {
		const f = fixture(),
			result = await f.generate(),
			document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			policyVersion: "aisa-story-window-v1",
			storyEvidence: {
				version: "aisa-story-evidence-v1",
				method: "MODEL_EVENT_GRAPH",
				model: modelIdentity,
				selection: {
					selectedArcId: "rescue",
					selectedEventIds: ["event-0", "event-1", "event-2"],
					reason: "CONNECTED_ARC",
				},
			},
		});
		expect(result.semanticEvidence).toBeUndefined();
		expect(result.actualFrames).toBeLessThanOrEqual(result.requestedFrames);
		expect(document.autoGeneration?.storyEvidence).toEqual(
			result.storyEvidence,
		);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.receipts).toHaveLength(1);
		expect(f.exports).not.toHaveBeenCalled();
		await expect(f.run()).resolves.toEqual(result);
		expect(f.extract).toHaveBeenCalledTimes(1);
		expect(f.projects).toHaveLength(1);
	});
	it("replays an arc whose setup and change are reached through the outcome dependencies", async () => {
		const f = fixture();
		f.extract.mockImplementation(async ({ input }) => {
			const graph = graphFor(input),
				arc = graph.arcs[0];
			if (!arc) throw new Error("Missing authored test arc");
			arc.eventIds = ["event-2"];
			return graph;
		});
		const result = await f.generate();
		expect(result.storyEvidence?.selection).toEqual({
			selectedArcId: "rescue",
			selectedEventIds: ["event-0", "event-1", "event-2"],
			reason: "CONNECTED_ARC",
		});
		await expect(f.run()).resolves.toEqual(result);
		expect(f.extract).toHaveBeenCalledTimes(1);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.exports).not.toHaveBeenCalled();
	});
	it("replays a complete arc with an incidental selected event whose external dependency is unselected", async () => {
		const f = fixture();
		f.task.parameters.input.parameters.targetDurationFrames = 120;
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
		f.extract.mockImplementation(async ({ input }) => {
			const graph = graphFor(input),
				setup = graph.events[0],
				change = graph.events[1],
				outside = input.intervals[0],
				opening = input.intervals[1],
				ending = input.intervals[2];
			if (!setup || !change || !outside || !opening || !ending)
				throw new Error("Missing authored story evidence");
			setup.evidence = [
				{ ref: opening.ref, quote: opening.text.slice(0, 240) },
			];
			change.evidence = [
				{ ref: opening.ref, quote: opening.text.slice(0, 240) },
			];
			graph.events.push(
				{
					id: "outside",
					label: "Earlier context outside the selected arc",
					role: "CONTEXT",
					entityIds: [],
					evidence: [{ ref: outside.ref, quote: outside.text.slice(0, 240) }],
					dependsOn: [],
					importance: 1,
				},
				{
					id: "incidental",
					label: "Incidental reaction retained in the selected ending shot",
					role: "REACTION",
					entityIds: [],
					evidence: [{ ref: ending.ref, quote: ending.text.slice(0, 240) }],
					dependsOn: ["outside"],
					importance: 1,
				},
			);
			return graph;
		});
		const result = await f.generate();
		expect(result.storyEvidence?.selection).toEqual({
			selectedArcId: "rescue",
			selectedEventIds: ["event-0", "event-1", "event-2", "incidental"],
			reason: "CONNECTED_ARC",
		});
		await expect(f.run()).resolves.toEqual(result);
		expect(f.extract).toHaveBeenCalledTimes(1);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.exports).not.toHaveBeenCalled();
	});
	it("uses the pinned prepared clock for the story draft and successful replay", async () => {
		const f = fixture(),
			proof = authoredNormalizationReceipt({
				organizationId: f.task.organizationId,
				sourceId: f.media.sourceId,
				mediaVersionId: f.media.id,
				sourceFrameCount: 144,
				width: f.media.width,
				height: f.media.height,
				preparedSha256: f.media.sha256,
				hasAudio: true,
			}),
			proofHash = hashEditingEvidence(proof);
		f.receipts.push({
			id: randomUUID(),
			organizationId: f.task.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId: null,
			kind: "NORMALIZATION_CAPTURE",
			proof,
			proofHash,
		});
		Object.assign(f.task.parameters.identity, {
			preparedShotClock: {
				version: "aisa-prepared-clock-v3",
				normalizationReceiptHash: proofHash,
			},
		});
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
		const result = await f.generate(),
			document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(result.policyVersion).toBe("aisa-prepared-story-window-v1");
		expect(document.autoGeneration?.normalizationReceiptHash).toBe(proofHash);
		expect(document.autoGeneration?.storyEvidence).toEqual(
			result.storyEvidence,
		);
		await expect(f.run()).resolves.toEqual(result);
		expect(f.extract).toHaveBeenCalledTimes(1);
		expect(f.exports).not.toHaveBeenCalled();
	});
	it("labels valid empty model evidence as insufficient metadata while preserving the STORY policy", async () => {
		const f = fixture();
		f.extract.mockImplementation(async () => ({
			version: "aisa-story-graph-v1",
			summary: "The supplied metadata does not support a connected event arc.",
			keyEntities: [],
			events: [],
			arcs: [],
		}));
		const result = await f.generate();
		expect(result.policyVersion).toBe("aisa-story-window-v1");
		expect(result.storyEvidence?.selection).toEqual({
			selectedEventIds: [],
			reason: "METADATA_INSUFFICIENT",
		});
		expect(result.semanticEvidence).toBeUndefined();
		expect(f.exports).not.toHaveBeenCalled();
	});
	it.each([
		"policy",
		"model",
		"hash",
		"missing",
		"selection",
	] as const)("rejects a completed story replay with changed %s", async (change) => {
		const f = fixture(),
			result = await f.generate();
		const altered = structuredClone(result);
		if (change === "policy")
			Object.assign(altered, { policyVersion: "aisa-content-highlight-v1" });
		else if (change === "missing") delete altered.storyEvidence;
		else if (altered.storyEvidence) {
			if (change === "model")
				altered.storyEvidence.model.model = "another-model";
			else if (change === "selection")
				altered.storyEvidence.selection.selectedEventIds = ["invented"];
			else altered.storyEvidence.artifactHash = "e".repeat(64);
		}
		f.task.result = altered;
		await expect(f.generate()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expect(f.projects).toHaveLength(1);
		expect(f.extract).toHaveBeenCalledTimes(1);
	});
	it("records only final speech-refined event coverage in the provenance hash", async () => {
		const f = fixture("AUTO");
		f.extract.mockImplementation(async ({ input }) => {
			const graph = graphFor(input),
				setup = graph.events[0],
				change = graph.events[1];
			if (!setup || !change) throw new Error("Missing authored story events");
			setup.importance = 1;
			change.importance = 5;
			change.dependsOn = [];
			return graph;
		});
		f.task.parameters.input.parameters.targetDurationFrames = 60;
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
		f.dependency.result.segments = [
			{ startUs: 500_000, endUs: 1_000_000, text: "before" },
			{ startUs: 1_500_000, endUs: 2_500_000, text: "continuous speech" },
		];
		f.refresh();
		const result = await f.generate(),
			document = compositionDocumentSchema.parse(f.projects[0]?.draft),
			evidence = result.storyEvidence;
		if (!evidence) throw new Error("Missing story evidence");
		expect(document.clips.map((clip) => clip.sourceInUs)).toEqual([4_000_000]);
		expect(evidence.selection).toMatchObject({
			selectedEventIds: ["event-2"],
			reason: "PARTIAL_ARC",
		});
		expect(document.autoGeneration?.storyEvidence).toEqual(evidence);
		expect(document.autoGeneration?.requestHash).toBe(
			hashEditingEvidence({
				taskRequestHash: f.task.requestHash,
				generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
				presetId: "portrait-clean",
				mediaSha256: f.media.sha256,
				analysisDocumentHash: f.task.parameters.identity.analysisDocumentHash,
				bindingHash: hashEditingEvidence(f.binding),
				modelSha256: f.task.parameters.identity.modelSha256,
				storyArtifactHash: evidence.artifactHash,
				storySelectionHash: hashEditingEvidence(evidence.selection),
				speechSelectionPolicyVersion: "asr-boundary-v1",
				selectionEvidenceHash: hashEditingEvidence(result.selectionEvidence),
			}),
		);
		expect(f.exports).not.toHaveBeenCalled();
	});
});
