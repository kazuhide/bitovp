import { randomUUID } from "node:crypto";
import {
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	LOCAL_SPEECH_SELECTION_POLICY_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient, LibraryMediaVersion } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLibraryGenerationHandler } from "./generation";

const { asr, tracking } = vi.hoisted(() => ({
	asr: vi.fn(),
	tracking: vi.fn(),
}));
vi.mock("./transcription", async (original) => ({
	...(await original<object>()),
	transcribeLocalAudio: asr,
}));
vi.mock("./tracking", async (original) => ({
	...(await original<object>()),
	trackShotSubjects: tracking,
}));
beforeEach(() => {
	asr.mockReset();
	tracking.mockReset();
});
type Row = Record<string, unknown>;
function setup(parameters: Row = {}, materialSeconds: 4 | 6 = 6) {
	const organizationId = randomUUID(),
		mediaId = randomUUID(),
		sourceId = randomUUID(),
		analysisId = randomUUID(),
		sceneId = randomUUID(),
		contentId = randomUUID();
	const map = {
		id: mediaId,
		mediaVersionId: mediaId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: materialSeconds * 1_000_000,
		editingStartFrame: 0,
		editingEndFrame: materialSeconds * 30,
		fps: { num: 30, den: 1 },
	};
	const credentialId = randomUUID();
	const media = {
		id: mediaId,
		organizationId,
		sourceId,
		state: "READY",
		durationUs: BigInt(materialSeconds * 1_000_000),
		fpsNum: 30,
		fpsDen: 1,
		sha256: "a".repeat(64),
		width: 640,
		height: 360,
		timeMap: map,
		probe: { streams: [{ codec_type: "audio" }] },
		storage: {
			source: { credentialId, bucket: "source", key: "source.mp4" },
			output: { credentialId, bucket: "output", prefix: "bitovp-editing/" },
		},
	};
	const raw = {
		metadata: { version: "generation-fixture" },
		duration: materialSeconds,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				title: "Interview",
				startInSeconds: 0,
				endInSeconds: materialSeconds,
				shots: Array.from(
					{ length: materialSeconds / 2 },
					(_, index) => index * 2,
				).map((startInSeconds) => ({
					startInSeconds,
					endInSeconds: startInSeconds + 2,
					mainSubjects: [
						{
							classification: "person",
							description: "fixture",
							appearanceTimeInSeconds: 1,
							centerX: 50,
							centerY: 50,
							box2d: [100, 400, 800, 600],
						},
					],
				})),
			},
		],
	};
	const analysis = {
		id: analysisId,
		organizationId,
		sourceId,
		locale: "ja",
		rawHash: hashEditingEvidence(raw),
		document: normalizeSceneAnalysis(raw),
	};
	const binding = {
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId,
		locale: "ja",
		analysisRevisionId: analysisId,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		mediaVersionId: mediaId,
		mediaSha256: media.sha256,
		timeMapId: map.id,
		timeMapHash: hashEditingEvidence(map),
		sourceStartUs: 0,
		sourceEndUs: materialSeconds * 1_000_000,
		width: 640,
		height: 360,
	};
	const input = mediaTaskCreateSchema.parse({
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: randomUUID(),
		parameters: { contentId, targetDurationFrames: 120, ...parameters },
	});
	if (input.kind !== "GENERATE") throw new Error("Missing generation input");
	const identity = {
		organizationId,
		generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
		mediaSha256: media.sha256,
		modelSha256: parameters.captions === "AUTO" ? "b".repeat(64) : null,
		...(input.parameters.captions === "AUTO"
			? { speechSelectionPolicyVersion: LOCAL_SPEECH_SELECTION_POLICY_VERSION }
			: {}),
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		analysisRawHash: analysis.rawHash,
		timeMapHash: hashEditingEvidence(map),
		bindingHash: hashEditingEvidence(binding),
		trackingAlgorithmVersion: LOCAL_TRACKING_ALGORITHM_VERSION,
		trackingFrameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
		bindingSnapshot: binding,
	};
	const task = {
		id: randomUUID(),
		organizationId,
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		kind: input.kind,
		requestKey: input.requestKey,
		requestHash: mediaTaskIntentHash(input),
		cacheKey: mediaTaskCacheKey(input, identity),
		parentTaskId: null,
		state: "RUNNING",
		phase: "GENERATING",
		result: null as unknown,
		cancelRequestedAt: null as Date | null,
		leaseToken: randomUUID(),
		leaseUntil: new Date(Date.now() + 120_000),
		createdBy: "fixture",
		parameters: { schemaVersion: 1, input, identity },
	};
	const projects: Row[] = [],
		revisions: Row[] = [],
		derivations: Row[] = [],
		runs: Row[] = [];
	let proofs: Row[] = [{ proof: binding }];
	const tx = {
		libraryMediaTask: {
			findUnique: vi.fn(async () => task),
			updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
				if (!matchesWhere(task, where)) return { count: 0 };
				Object.assign(task, data);
				return { count: 1 };
			}),
		},
		libraryMediaVersion: { findUnique: vi.fn(async () => media) },
		sceneAnalysisRevision: { findUnique: vi.fn(async () => analysis) },
		libraryAnalysisBinding: { findMany: vi.fn(async () => proofs) },
		contentRevision: {
			findFirst: vi.fn(async () => ({
				content: { id: contentId, title: "Interview" },
			})),
		},
		editProject: {
			findUnique: vi.fn(
				async ({ where }: { where: Row }) =>
					projects.find((p) => p.id === where.id) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Row }) => {
				projects.push(data);
				return data;
			}),
			update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
				const row = projects.find((p) => p.id === where.id);
				if (row) Object.assign(row, data);
				return row;
			}),
		},
		editRevision: {
			create: vi.fn(async ({ data }: { data: Row }) => {
				const row = { id: randomUUID(), ...data };
				revisions.push(row);
				return row;
			}),
		},
		contentDerivation: {
			create: vi.fn(async ({ data }: { data: Row }) => {
				derivations.push(data);
				return data;
			}),
		},
		renderRun: {
			create: vi.fn(async ({ data }: { data: Row }) => {
				runs.push(data);
				return data;
			}),
		},
		$queryRaw: vi.fn(async () => proofs),
	};
	const prisma = {
		...tx,
		$transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
	} as unknown as AppPrismaClient;
	const handler = createLibraryGenerationHandler({ prisma });
	const context = {
		taskId: task.id,
		organizationId,
		leaseToken: task.leaseToken,
		mediaVersionId: media.id,
		analysisRevisionId: analysis.id,
		parameters: input.parameters,
		sourcePath: "/owned/source.mp4",
		media: media as unknown as LibraryMediaVersion,
		createdBy: task.createdBy,
		signal: new AbortController().signal,
		onProgress: vi.fn(async () => {}),
	};
	return {
		task,
		context,
		prisma,
		handler,
		projects,
		revisions,
		derivations,
		runs,
		tx,
		input,
		sceneId,
		revoke: () => {
			proofs = [];
		},
	};
}
describe("actual production generation publication", () => {
	it("selects actual whole shots and atomically publishes an editable V2 revision and export", async () => {
		const f = setup();
		const result = await f.handler(f.context);
		expect(result).toMatchObject({
			requestedFrames: 120,
			actualFrames: 120,
			projectIds: [expect.any(String)],
		});
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.derivations).toHaveLength(1);
		expect(f.runs[0]).toMatchObject({
			generation: 1,
			profile: { kind: "EXPORT" },
		});
		expect(f.projects[0]?.draft).toMatchObject({
			schemaVersion: 2,
			autoGeneration: {
				policyVersion: "aisa-scene-cohesion-v2",
				binding: { kind: "FIXTURE_AUTHORED" },
			},
		});
		expect(f.task).toMatchObject({ state: "SUCCEEDED", result });
		expect(asr).not.toHaveBeenCalled();
		expect(tracking).not.toHaveBeenCalled();
	});
	it("creates deterministic distinct portrait/landscape/square variants and replays without duplicates", async () => {
		const f = setup({ variants: 3 });
		const first = await f.handler(f.context),
			second = await f.handler(f.context);
		expect(second).toEqual(first);
		expect(f.projects).toHaveLength(3);
		expect(new Set(f.projects.map((p) => p.id)).size).toBe(3);
		expect(f.projects.map((p) => p.variant)).toEqual([
			"PORTRAIT",
			"LANDSCAPE",
			"SQUARE",
		]);
		for (const project of f.projects)
			expect(JSON.stringify(project.draft)).toContain('"origin":"AUTO_POLICY"');
	});
	it("refuses revoked proof and cancellation before any publication", async () => {
		const f = setup();
		f.revoke();
		await expect(f.handler(f.context)).rejects.toMatchObject({
			code: "ANALYSIS_BINDING_UNVERIFIED",
		});
		expect(f.projects).toEqual([]);
		const canceled = setup();
		canceled.task.cancelRequestedAt = new Date();
		await expect(canceled.handler(canceled.context)).rejects.toMatchObject({
			code: "CANCELED",
		});
		expect(canceled.projects).toEqual([]);
	});
	it("reports missing ASR configuration without inventing captions", async () => {
		const f = setup({ captions: "AUTO" });
		const result = await f.handler(f.context);
		expect(result.warnings).toContain("ASR_MODEL_NOT_CONFIGURED");
		expect(f.projects[0]?.draft).toMatchObject({ captions: [] });
		expect(asr).not.toHaveBeenCalled();
	});
	it("keeps a semantic query in immutable generation evidence", async () => {
		const f = setup({ query: "Interview" });
		await f.handler(f.context);
		expect(f.projects[0]?.draft).toMatchObject({
			autoGeneration: {
				query: "Interview",
				policyVersion: "aisa-scene-cohesion-v2",
			},
		});
	});
	it("maps only actual ASR words through the shared caption mapper", async () => {
		const f = setup({ captions: "AUTO" }, 4);
		asr.mockResolvedValue({
			language: "ja",
			segments: [
				{
					startUs: 0,
					endUs: 1_000_000,
					text: "字幕",
					words: [
						{
							text: "字幕",
							startChar: 0,
							endChar: 2,
							startUs: 0,
							endUs: 1_000_000,
							confidence: 0.95,
						},
					],
				},
			],
			warnings: [],
		});
		await createLibraryGenerationHandler({
			prisma: f.prisma,
			model: { path: "/models/base.bin", sha256: "b".repeat(64) },
		})(f.context);
		expect(asr).toHaveBeenCalledWith(
			expect.objectContaining({ sourceStartUs: 0, durationUs: 4_000_000 }),
		);
		expect(f.projects[0]?.draft).toMatchObject({
			captions: [
				{
					text: "字幕",
					words: [
						{
							text: "字幕",
							startChar: 0,
							endChar: 2,
							fromFrame: 0,
							toFrame: 30,
						},
					],
				},
			],
		});
	});
	it("uses AISA appearance offsets as real tracker seeds and preserves explicit FIT intervals", async () => {
		const f = setup({ tracking: true });
		tracking.mockResolvedValue({
			observations: [1_000_000, 1_333_334].map((sourceTimeUs) => ({
				sceneId: f.sceneId,
				shotIndex: 0,
				sourceTimeUs,
				confidence: 0.95,
				box: { x: 0.4, y: 0.1, w: 0.2, h: 0.7 },
			})),
			fallbacks: [
				{
					sceneId: f.sceneId,
					shotIndex: 0,
					fromUs: 0,
					toUs: 1_000_000,
					reason: "BEFORE_SEED",
				},
			],
		});
		const result = await f.handler(f.context);
		expect(tracking).toHaveBeenCalledWith(
			expect.objectContaining({
				shots: [
					expect.objectContaining({
						seed: expect.objectContaining({ sourceTimeUs: 1_000_000 }),
					}),
					expect.objectContaining({
						seed: expect.objectContaining({ sourceTimeUs: 3_000_000 }),
					}),
				],
			}),
		);
		expect(result.warnings).toContain("TRACKING_FIT_FALLBACK");
	});
	it("does not complete publication after its lease expires inside the transaction", async () => {
		const f = setup();
		let instant = new Date();
		f.tx.renderRun.create.mockImplementationOnce(
			async ({ data }: { data: Row }) => {
				f.runs.push(data);
				instant = new Date(f.task.leaseUntil.getTime() + 1);
				return data;
			},
		);
		await expect(
			createLibraryGenerationHandler({ prisma: f.prisma, now: () => instant })(
				f.context,
			),
		).rejects.toMatchObject({ code: "LEASE_LOST" });
	});
	it("keeps completed v1 tracking results readable but refuses to execute old queued tracking under v2", async () => {
		const f = setup({ tracking: true });
		Reflect.deleteProperty(
			f.task.parameters.identity,
			"trackingAlgorithmVersion",
		);
		await expect(f.handler(f.context)).rejects.toMatchObject({
			code: "TRACKING_ALGORITHM_CHANGED",
		});
		expect(tracking).not.toHaveBeenCalled();
		const result = {
			projectId: f.context.mediaVersionId,
			projectIds: [f.context.mediaVersionId],
			requestedFrames: 120,
			actualFrames: 120,
			warnings: [],
			policyVersion: "aisa-scene-cohesion-v2",
			presetIds: ["portrait-clean"],
			metrics: {},
			cacheable: true,
		};
		Reflect.deleteProperty(
			f.task.parameters.identity,
			"generationPolicyFingerprint",
		);
		f.task.state = "SUCCEEDED";
		f.task.result = result;
		expect(await f.handler(f.context)).toEqual(result);
		expect(f.projects).toHaveLength(0);
	});
});
