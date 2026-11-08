import { randomUUID } from "node:crypto";
import {
	editingAnalysisBindingSchema,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	LOCAL_ASR_ENGINE_VERSION,
	LOCAL_SPEECH_SELECTION_POLICY_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	type MediaTaskIdentity,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { matchesWhere, orderRows } from "@bitovp/core/testing";
import type { AppPrismaClient, LibraryMediaVersion } from "@bitovp/db";
import { vi } from "vitest";
import { createLibraryGenerationHandler } from "./generation";

type Row = Record<string, unknown>;
export function generationDependencyFixture(
	kind: "TRANSCRIBE" | "TRACK" = "TRANSCRIBE",
	materialSeconds: 4 | 6 = 6,
) {
	const organizationId = randomUUID(),
		mediaId = randomUUID(),
		sourceId = randomUUID(),
		analysisId = randomUUID(),
		contentId = randomUUID(),
		sceneIds = [randomUUID(), randomUUID()],
		dependencyId = randomUUID(),
		credentialId = randomUUID();
	const map = {
		id: mediaId,
		mediaVersionId: mediaId,
		kind: "CFR" as const,
		sourceStartUs: 0,
		sourceEndUs: materialSeconds * 1_000_000,
		editingStartFrame: 0,
		editingEndFrame: materialSeconds * 30,
		fps: { num: 30 as const, den: 1 as const },
	};
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
			source: { credentialId, bucket: "source", key: "fixture.mp4" },
			output: { credentialId, bucket: "output", prefix: "bitovp-editing/" },
		},
	};
	const raw = {
		metadata: { version: "authored-dependency-regression" },
		duration: materialSeconds,
		scenes: [
			[0, 4],
			[4, 6],
		]
			.filter(([start = 0]) => start < materialSeconds)
			.map(([start = 0, end = 0], index) => ({
				id: sceneIds[index],
				type: "MAIN_CONTENT",
				title: index ? "Closing scene" : "Interview",
				startInSeconds: start,
				endInSeconds: end,
				shots: Array.from({ length: (end - start) / 2 }, (_, shotIndex) => ({
					startInSeconds: start + shotIndex * 2,
					endInSeconds: start + shotIndex * 2 + 2,
					mainSubjects: [
						{
							classification: "person",
							description: "Explicit authored test annotation",
							appearanceTimeInSeconds: 0,
							centerX: 50,
							centerY: 50,
							box2d: [100, 400, 800, 600],
						},
					],
				})),
			})),
	};
	const analysis = {
		id: analysisId,
		organizationId,
		sourceId,
		locale: "ja",
		rawHash: hashEditingEvidence(raw),
		document: normalizeSceneAnalysis(raw),
	};
	const binding = editingAnalysisBindingSchema.parse({
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
		sourceStartUs: map.sourceStartUs,
		sourceEndUs: map.sourceEndUs,
		width: media.width,
		height: media.height,
	});
	const input = mediaTaskCreateSchema.parse({
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: randomUUID(),
		parameters: {
			contentId,
			targetDurationFrames: 120,
			policy: "DURATION",
			language: "ja",
			captions: kind === "TRANSCRIBE" ? "AUTO" : "OFF",
			tracking: kind === "TRACK",
			...(kind === "TRANSCRIBE"
				? { transcriptionTaskId: dependencyId }
				: { trackingTaskId: dependencyId }),
		},
	});
	if (input.kind !== "GENERATE") throw new Error("Expected generation");
	const identity: MediaTaskIdentity = {
		generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
		organizationId,
		mediaSha256: media.sha256,
		modelSha256: kind === "TRANSCRIBE" ? "b".repeat(64) : null,
		...(kind === "TRANSCRIBE"
			? { speechSelectionPolicyVersion: LOCAL_SPEECH_SELECTION_POLICY_VERSION }
			: {}),
		analysisDocumentHash: binding.analysisDocumentHash,
		analysisRawHash: analysis.rawHash,
		timeMapHash: binding.timeMapHash,
		bindingHash: hashEditingEvidence(binding),
		bindingSnapshot: binding,
		...(kind === "TRACK"
			? {
					trackingAlgorithmVersion: LOCAL_TRACKING_ALGORITHM_VERSION,
					trackingFrameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
				}
			: {}),
	};
	const dependencyInput = mediaTaskCreateSchema.parse({
		kind,
		mediaVersionId: mediaId,
		requestKey: randomUUID(),
		...(kind === "TRACK" ? { analysisRevisionId: analysisId } : {}),
		parameters:
			kind === "TRANSCRIBE"
				? {
						language: "ja",
						sourceStartUs: 0,
						durationUs: materialSeconds * 1_000_000,
					}
				: {},
	});
	const dependencyIdentity: MediaTaskIdentity =
		kind === "TRACK"
			? { ...identity }
			: {
					organizationId,
					mediaSha256: media.sha256,
					modelSha256: "b".repeat(64),
					analysisDocumentHash: null,
					analysisRawHash: null,
					timeMapHash: binding.timeMapHash,
					bindingHash: null,
				};
	// Independent ASR/track work is deliberately outside GENERATE policy.
	delete dependencyIdentity.generationPolicyFingerprint;
	const transcript = {
		schemaVersion: 1,
		engine: "whisper.cpp",
		engineVersion: LOCAL_ASR_ENGINE_VERSION,
		modelSha256: "b".repeat(64),
		mediaSha256: media.sha256,
		language: "ja",
		segments: [{ startUs: 0, endUs: 1_000_000, text: "こんにちは" }],
		warnings: [],
		cacheKey: "c".repeat(64),
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
	};
	const tracked = {
		schemaVersion: 1,
		algorithm: LOCAL_TRACKING_ALGORITHM_VERSION,
		frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
		mediaSha256: media.sha256,
		cacheKey: "d".repeat(64),
		sampleFps: 3,
		observations: [0, 1_000_000].map((sourceTimeUs) => ({
			sceneId: sceneIds[0],
			shotIndex: 0,
			sourceTimeUs,
			box: { x: 0.4, y: 0.2, w: 0.15, h: 0.4 },
			confidence: 0.95,
		})),
		fallbacks: [],
		bindingKind: "FIXTURE_AUTHORED",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
	};
	const dependency = {
		id: dependencyId,
		organizationId,
		mediaVersionId: mediaId,
		analysisRevisionId: kind === "TRACK" ? analysisId : null,
		kind,
		state: "SUCCEEDED",
		requestKey: dependencyInput.requestKey,
		requestHash: mediaTaskIntentHash(dependencyInput),
		cacheKey: mediaTaskCacheKey(dependencyInput, dependencyIdentity),
		parentTaskId: null,
		parameters: {
			schemaVersion: 1,
			input: dependencyInput,
			identity: dependencyIdentity,
		},
		result: (kind === "TRACK" ? tracked : transcript) as Row,
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
		leaseToken: randomUUID(),
		leaseUntil: new Date(Date.now() + 120_000),
		cancelRequestedAt: null,
		createdBy: "fixture",
		parameters: { schemaVersion: 1, input, identity },
		result: null as unknown,
	};
	const projects: Row[] = [],
		revisions: Row[] = [],
		runs: Row[] = [];
	const rows: Row[] = [task, dependency];
	const tx = {
		libraryMediaTask: {
			findUnique: async ({ where }: { where: Row }) =>
				rows.find((row) => matchesWhere(row, where)) ?? null,
			findFirst: async ({ where }: { where: Row }) =>
				rows.find((row) => matchesWhere(row, where)) ?? null,
			findMany: async ({
				where,
				orderBy,
				take,
			}: {
				where: Row;
				orderBy: Row[];
				take: number;
			}) =>
				orderRows(
					rows.filter((row) => matchesWhere(row, where)),
					orderBy,
				)
					.slice(0, take)
					.map((row) => ({ ...row })),
			updateMany: async ({ where, data }: { where: Row; data: Row }) => {
				let count = 0;
				for (const row of rows)
					if (matchesWhere(row, where)) {
						for (const [key, value] of Object.entries(data))
							row[key] =
								value && typeof value === "object" && "increment" in value
									? Number(row[key]) + Number(value.increment)
									: value;
						count++;
					}
				return { count };
			},
		},
		libraryMediaVersion: { findUnique: async () => media },
		sceneAnalysisRevision: { findUnique: async () => analysis },
		$queryRaw: async () => [{ proof: binding }],
		$executeRaw: async () => 1,
		contentRevision: {
			findFirst: async () => ({ content: { id: contentId, title: "Fixture" } }),
		},
		editProject: {
			findUnique: async ({ where }: { where: Row }) =>
				projects.find((row) => row.id === where.id) ?? null,
			create: async ({ data }: { data: Row }) => {
				projects.push(data);
				return data;
			},
			update: async ({ where, data }: { where: Row; data: Row }) => {
				const row = projects.find((item) => item.id === where.id);
				if (row) Object.assign(row, data);
				return row;
			},
		},
		editRevision: {
			create: async ({ data }: { data: Row }) => {
				const row = { id: randomUUID(), ...data };
				revisions.push(row);
				return row;
			},
		},
		contentDerivation: { create: async ({ data }: { data: Row }) => data },
		renderRun: {
			create: async ({ data }: { data: Row }) => {
				runs.push(data);
				return data;
			},
		},
	};
	const prisma = {
		...tx,
		$transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
	} as unknown as AppPrismaClient;
	const context = {
		taskId: task.id,
		organizationId,
		leaseToken: task.leaseToken,
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		parameters: input.parameters,
		sourcePath: "/owned/fixture.mp4",
		media: media as unknown as LibraryMediaVersion,
		createdBy: "fixture",
		signal: new AbortController().signal,
		onProgress: vi.fn(async () => {}),
	};
	const refresh = () => {
		dependency.requestHash = mediaTaskIntentHash(dependency.parameters.input);
		dependency.cacheKey = mediaTaskCacheKey(
			dependency.parameters.input,
			dependency.parameters.identity,
		);
	};
	return {
		dependency,
		task,
		projects,
		revisions,
		runs,
		sceneIds,
		context,
		refresh,
		prisma,
		rows,
		media,
		analysis,
		binding,
		run: () => createLibraryGenerationHandler({ prisma })(context),
	};
}
