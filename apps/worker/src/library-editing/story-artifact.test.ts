import { randomUUID } from "node:crypto";
import {
	buildStoryModelInput,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
	type StoryGraph,
	type StoryModelInput,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";
import { verifyMediaTaskEvidence } from "./media-task-execution";
import { loadStoryArtifact, storyArtifactReceiptId } from "./story-artifact";

const identity = {
	version: "aisa-story-model-v1" as const,
	provider: "CODEX_CLI" as const,
	model: "authored-artifact-test-model",
	promptVersion: "aisa-story-prompt-v1" as const,
	schemaHash: "f".repeat(64),
	configId: "b8d98e2e-a309-430a-9d91-e134c523064e",
};

export function graphForStoryInput(input: StoryModelInput): StoryGraph {
	const events = input.intervals.slice(0, 3).map((interval, index) => ({
		id: `event-${index}`,
		label: `Authored test event ${index}`,
		role: (["SETUP", "CHANGE", "OUTCOME"] as const)[index] ?? "CHANGE",
		entityIds: [],
		evidence: [{ ref: interval.ref, quote: interval.text.slice(0, 240) }],
		dependsOn: index ? [`event-${index - 1}`] : [],
		importance: 3,
	}));
	return {
		version: "aisa-story-graph-v1",
		summary: "Authored test evidence, never a claimed provider response",
		keyEntities: [],
		events,
		arcs: [
			{
				id: "arc",
				title: "Authored test arc",
				eventIds: events.map((e) => e.id),
			},
		],
	};
}

async function fixture() {
	const f = generationDependencyFixture("TRACK");
	const receipts: Array<Record<string, unknown>> = [];
	const prisma = {
		...f.prisma,
		libraryEvidenceReceipt: {
			findUnique: vi.fn(
				async ({ where }: { where: { id: string } }) =>
					receipts.find((row) => row.id === where.id) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				if (
					receipts.some(
						(row) =>
							row.organizationId === data.organizationId &&
							row.kind === data.kind &&
							row.proofHash === data.proofHash,
					)
				)
					throw new Error("Duplicate organization/kind/proofHash receipt");
				receipts.push(data);
				return data;
			}),
		},
		$transaction: async <T>(fn: (tx: AppPrismaClient) => Promise<T>) =>
			fn(prisma as unknown as AppPrismaClient),
	} as unknown as AppPrismaClient;
	const verified = await prisma.$transaction((tx) =>
		verifyMediaTaskEvidence(tx, f.task as never),
	);
	const input = buildStoryModelInput({
		analysis: f.analysis.document,
		timeMap: f.media.timeMap,
	});
	const graph = graphForStoryInput(input),
		extract = vi.fn(async () => structuredClone(graph)),
		signal = new AbortController();
	const options = {
		prisma,
		task: f.task as never,
		verified,
		leaseToken: f.task.leaseToken,
		input,
		model: { identity, extract },
		signal: signal.signal,
	};
	return { ...f, prisma, input, graph, extract, receipts, options, signal };
}

describe("server-owned story graph artifacts", () => {
	it("caches one grounded graph independently of requested project duration", async () => {
		const f = await fixture(),
			first = await loadStoryArtifact(f.options);
		f.task.parameters.input.parameters.targetDurationFrames = 60;
		const second = await loadStoryArtifact(f.options);
		expect(second).toEqual({ ...first, cached: true });
		expect(first.artifact.graph).toEqual(f.graph);
		expect(first.artifactHash).toBe(hashEditingEvidence(first.artifact));
		expect(f.receipts).toHaveLength(1);
		expect(f.receipts[0]).toMatchObject({
			kind: "STORY_GRAPH_V1",
			organizationId: f.task.organizationId,
			mediaVersionId: f.task.mediaVersionId,
			analysisRevisionId: f.task.analysisRevisionId,
			proofHash: hashEditingEvidence(f.receipts[0]?.proof),
		});
		expect(f.extract).toHaveBeenCalledTimes(1);
		expect(f.projects).toEqual([]);
		expect(f.runs).toEqual([]);
	});
	it.each([
		"hash",
		"model",
		"tuple",
		"evidence",
	] as const)("rejects a cached artifact with altered %s", async (change) => {
		const f = await fixture();
		await loadStoryArtifact(f.options);
		const row = f.receipts[0];
		if (!row) throw new Error("Missing test receipt");
		if (change === "hash") row.proofHash = "0".repeat(64);
		else if (change === "tuple") row.mediaVersionId = randomUUID();
		else {
			const proof = structuredClone(row.proof) as {
				artifact: { identity: typeof identity; graph: StoryGraph };
			};
			if (change === "model") proof.artifact.identity.model = "another-model";
			else if (proof.artifact.graph.events[0]?.evidence[0])
				proof.artifact.graph.events[0].evidence[0].ref = "invented-evidence";
			row.proof = proof;
			row.proofHash = hashEditingEvidence(proof);
		}
		await expect(loadStoryArtifact(f.options)).rejects.toMatchObject({
			code: "STORY_ARTIFACT_UNVERIFIED",
		});
		expect(f.extract).toHaveBeenCalledTimes(1);
	});
	it("rejects ungrounded model output before persisting evidence", async () => {
		const f = await fixture();
		const event = f.graph.events[0];
		if (!event) throw new Error("Missing authored test event");
		f.extract.mockResolvedValue({
			...f.graph,
			events: [
				{
					...event,
					evidence: [{ ref: "missing", quote: "invented" }],
				},
			],
		});
		await expect(loadStoryArtifact(f.options)).rejects.toMatchObject({
			code: "STORY_GRAPH_INVALID",
		});
		expect(f.receipts).toEqual([]);
	});
	it.each([
		"lease",
		"cancel",
		"binding",
		"abort",
	] as const)("does not publish a graph after losing %s during extraction", async (change) => {
		const f = await fixture();
		f.extract.mockImplementation(async () => {
			if (change === "lease") f.task.leaseToken = randomUUID();
			else if (change === "cancel")
				Object.assign(f.task, { cancelRequestedAt: new Date() });
			else if (change === "binding") f.binding.mediaSha256 = "e".repeat(64);
			else f.signal.abort();
			return f.graph;
		});
		await expect(loadStoryArtifact(f.options)).rejects.toBeDefined();
		expect(f.receipts).toEqual([]);
		expect(f.projects).toEqual([]);
	});
	it("uses a different receipt identity for another tenant or model configuration", async () => {
		const f = await fixture(),
			key = {
				organizationId: f.task.organizationId,
				mediaVersionId: f.task.mediaVersionId,
				analysisRevisionId: f.task.analysisRevisionId,
				inputHash: hashEditingEvidence(f.input),
				identity,
			};
		expect(storyArtifactReceiptId(key)).toBe(
			storyArtifactReceiptId({ ...key }),
		);
		expect(storyArtifactReceiptId(key)).not.toBe(
			storyArtifactReceiptId({ ...key, organizationId: randomUUID() }),
		);
		expect(storyArtifactReceiptId(key)).not.toBe(
			storyArtifactReceiptId({
				...key,
				identity: { ...identity, configId: randomUUID() },
			}),
		);
	});
	it("rejects a model configuration changed while its response is pending", async () => {
		const f = await fixture();
		f.options.model.identity = { ...identity };
		f.extract.mockImplementation(async () => {
			f.options.model.identity.model = "new-configuration";
			return f.graph;
		});
		await expect(loadStoryArtifact(f.options)).rejects.toMatchObject({
			code: "STORY_MODEL_CHANGED",
		});
		expect(f.receipts).toEqual([]);
	});
	it.each([
		"media version",
		"analysis revision",
	] as const)("retains the same artifact for another %s without colliding with receipt proof uniqueness", async (change) => {
		const f = await fixture(),
			first = await loadStoryArtifact(f.options),
			mediaId = change === "media version" ? randomUUID() : f.media.id,
			analysisId =
				change === "analysis revision" ? randomUUID() : f.analysis.id,
			map = { ...f.media.timeMap, id: mediaId, mediaVersionId: mediaId },
			media = { ...f.media, id: mediaId, timeMap: map },
			analysis = { ...f.analysis, id: analysisId },
			binding = {
				...f.binding,
				mediaVersionId: mediaId,
				analysisRevisionId: analysisId,
				timeMapId: mediaId,
				timeMapHash: hashEditingEvidence(map),
			},
			input = {
				...f.task.parameters.input,
				mediaVersionId: mediaId,
				analysisRevisionId: analysisId,
				requestKey: randomUUID(),
			},
			taskIdentity = {
				...f.task.parameters.identity,
				timeMapHash: binding.timeMapHash,
				bindingSnapshot: binding,
				bindingHash: hashEditingEvidence(binding),
			},
			task = {
				...f.task,
				id: randomUUID(),
				mediaVersionId: mediaId,
				analysisRevisionId: analysisId,
				requestKey: input.requestKey,
				requestHash: mediaTaskIntentHash(input),
				cacheKey: mediaTaskCacheKey(input, taskIdentity),
				parameters: {
					schemaVersion: 1 as const,
					input,
					identity: taskIdentity,
				},
			};
		f.rows.push(task);
		const prisma = {
			...f.prisma,
			libraryMediaVersion: { findUnique: async () => media },
			sceneAnalysisRevision: { findUnique: async () => analysis },
			$queryRaw: async () => [{ proof: binding }],
			$transaction: async <T>(fn: (tx: AppPrismaClient) => Promise<T>) =>
				fn(prisma as unknown as AppPrismaClient),
		} as unknown as AppPrismaClient;
		const verified = await prisma.$transaction((tx) =>
			verifyMediaTaskEvidence(tx, task as never),
		);
		const second = await loadStoryArtifact({
			...f.options,
			prisma,
			task: task as never,
			verified,
		});
		expect(second.artifact).toEqual(first.artifact);
		expect(second.artifactHash).toBe(first.artifactHash);
		expect(f.receipts).toHaveLength(2);
		expect(f.receipts[0]?.proofHash).not.toBe(f.receipts[1]?.proofHash);
	});
	it.each([
		"extra",
		"identity",
		"version",
		"missing",
		"artifact",
		"legacy",
	] as const)("rejects a rehashed receipt with a malformed %s wrapper", async (change) => {
		const f = await fixture();
		await loadStoryArtifact(f.options);
		const row = f.receipts[0];
		if (!row) throw new Error("Missing test receipt");
		let proof = structuredClone(row.proof) as Record<string, unknown>;
		if (change === "extra") proof.unexpected = true;
		else if (change === "identity") proof.cacheIdentityHash = "0".repeat(64);
		else if (change === "version") proof.version = "aisa-story-receipt-v2";
		else if (change === "missing") delete proof.artifact;
		else if (change === "artifact")
			proof.artifact = {
				...(proof.artifact as Record<string, unknown>),
				unexpected: true,
			};
		else proof = proof.artifact as Record<string, unknown>;
		row.proof = proof;
		row.proofHash = hashEditingEvidence(proof);
		await expect(loadStoryArtifact(f.options)).rejects.toMatchObject({
			code: "STORY_ARTIFACT_UNVERIFIED",
		});
		expect(f.extract).toHaveBeenCalledTimes(1);
	});
});
