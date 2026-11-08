import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	editingAnalysisBindingSchema,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	type MediaTaskIdentity,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
	PLAMO_CAPTION_TEMPLATE_HASH,
} from "@bitovp/core";
import { authoredNormalizationReceipt } from "@bitovp/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import {
	createMediaTask,
	readMediaTask,
	retryMediaTask,
} from "./library-media-tasks";

function fixtureItem<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture");
	return value;
}

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
	choiceReady: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
vi.mock("./local-story-choice-readiness", () => ({
	isLocalStoryChoiceReady: holder.choiceReady,
}));
type Row = Record<string, unknown>;
const captionFixtureFolders: string[] = [];
function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "organizationId_requestKey") return matches(row, value as Row);
		return row[key] === value;
	});
}
function fixture() {
	const organizationId = randomUUID(),
		mediaId = randomUUID(),
		sourceId = randomUUID(),
		analysisId = randomUUID(),
		contentId = randomUUID();
	const map = {
		id: mediaId,
		mediaVersionId: mediaId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	const media = {
		id: mediaId,
		organizationId,
		sourceId,
		state: "READY",
		sha256: "a".repeat(64),
		width: 640,
		height: 360,
		timeMap: map,
	};
	const raw = {
		metadata: { version: "authored-generation-intake-regression" },
		duration: 2,
		scenes: [
			{
				id: randomUUID(),
				type: "MAIN_CONTENT",
				title: "Fixture",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [{ startInSeconds: 0, endInSeconds: 2, mainSubjects: [] }],
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
		timeMapId: mediaId,
		timeMapHash: hashEditingEvidence(map),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 640,
		height: 360,
	});
	const rows: Row[] = [];
	const normalizationRows: Row[] = [];
	const task = {
		findUnique: async ({ where }: { where: Row }) =>
			rows.find((row) => matches(row, where)) ?? null,
		findFirst: async ({ where }: { where: Row }) =>
			rows.find((row) => matches(row, where)) ?? null,
		create: async ({ data }: { data: Row }) => {
			const row = {
				id: randomUUID(),
				state: "PENDING",
				phase: "QUEUED",
				progress: null,
				result: null,
				error: null,
				attempts: 0,
				analysisRevisionId: null,
				parentTaskId: null,
				createdAt: new Date(),
				finishedAt: null,
				...data,
			};
			rows.push(row);
			return row;
		},
	};
	const tx = {
		libraryMediaTask: task,
		libraryEvidenceReceipt: { findMany: async () => normalizationRows },
		libraryMediaVersion: { findUnique: async () => media },
		sceneAnalysisRevision: { findUnique: async () => analysis },
		contentRevision: { findFirst: async () => ({ contentId, sourceId }) },
		$queryRaw: async () => [{ proof: binding }],
		$executeRaw: async () => 1,
	};
	const prisma = {
		...tx,
		$transaction: async <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx),
	};
	holder.context = {
		prisma,
		tenant: { organizationId },
	} as unknown as ServerContext;
	const input = (requestKey = randomUUID()) => ({
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey,
		parameters: { contentId, targetDurationFrames: 60 },
	});
	function dependency() {
		const value = mediaTaskCreateSchema.parse({
			kind: "TRACK",
			mediaVersionId: mediaId,
			analysisRevisionId: analysisId,
			requestKey: randomUUID(),
			parameters: {},
		});
		const identity: MediaTaskIdentity = {
			organizationId,
			mediaSha256: media.sha256,
			modelSha256: null,
			analysisDocumentHash: binding.analysisDocumentHash,
			analysisRawHash: analysis.rawHash,
			timeMapHash: binding.timeMapHash,
			bindingHash: hashEditingEvidence(binding),
			bindingSnapshot: binding,
			trackingAlgorithmVersion: LOCAL_TRACKING_ALGORITHM_VERSION,
			trackingFrameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
		};
		const row = {
			id: randomUUID(),
			organizationId,
			mediaVersionId: mediaId,
			analysisRevisionId: analysisId,
			kind: "TRACK",
			state: "SUCCEEDED",
			requestKey: value.requestKey,
			requestHash: mediaTaskIntentHash(value),
			cacheKey: mediaTaskCacheKey(value, identity),
			parentTaskId: null,
			parameters: { schemaVersion: 1, input: value, identity },
			result: {
				schemaVersion: 1,
				algorithm: LOCAL_TRACKING_ALGORITHM_VERSION,
				frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
				mediaSha256: media.sha256,
				cacheKey: "c".repeat(64),
				sampleFps: 3,
				observations: [],
				fallbacks: [],
				bindingKind: "FIXTURE_AUTHORED",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			} as Row,
			createdAt: new Date(),
			finishedAt: new Date(),
			phase: "COMPLETE",
			progress: null,
			error: null,
			attempts: 1,
		};
		rows.push(row);
		return row;
	}
	return { rows, input, dependency, media, organizationId, normalizationRows };
}
beforeEach(() => {
	vi.stubEnv("BITOVP_LOCAL_STORY_CHOICE_ENABLED", undefined);
	holder.choiceReady.mockReset().mockResolvedValue(true);
	vi.stubEnv("BITOVP_LOCAL_SEMANTIC_ENABLED", undefined);
	vi.stubEnv("WHISPER_MODEL_SHA256", undefined);
	vi.stubEnv("BITOVP_STORY_ENABLED", undefined);
	vi.stubEnv("BITOVP_STORY_MODEL_ID", undefined);
	vi.stubEnv("BITOVP_STORY_CONFIG_ID", undefined);
	vi.stubEnv("BITOVP_LOCAL_CAPTION_PROVIDER", undefined);
	vi.stubEnv("BITOVP_LOCAL_CAPTION_MANIFEST_FILE", undefined);
});

it("pins server-owned GENERATE output policy and does not reuse an older successful output cache", async () => {
	const f = fixture(),
		first = await createMediaTask(f.input(), "fixture");
	const row = fixtureItem(f.rows[0]);
	const envelope = row.parameters as {
		input: ReturnType<typeof mediaTaskCreateSchema.parse>;
		identity: MediaTaskIdentity;
	};
	expect(envelope.identity.generationPolicyFingerprint).toBe(
		GENERATION_POLICY_FINGERPRINT,
	);
	const legacy = { ...envelope.identity };
	delete legacy.generationPolicyFingerprint;
	row.parameters = { ...envelope, identity: legacy };
	row.cacheKey = mediaTaskCacheKey(envelope.input, legacy);
	row.state = "SUCCEEDED";
	row.result = { cacheable: true };
	const next = await createMediaTask(f.input(), "fixture");
	expect(next.taskId).not.toBe(first.taskId);
	expect(f.rows).toHaveLength(2);
});

it("does not accept a requested output-policy fingerprint from the client", async () => {
	const f = fixture();
	await expect(
		createMediaTask(
			{ ...f.input(), generationPolicyFingerprint: "f".repeat(64) },
			"fixture",
		),
	).rejects.toThrow();
	expect(f.rows).toEqual([]);
});

describe("local semantic generation intake", () => {
	function configure(profile = "nvidia") {
		for (const [key, value] of Object.entries({
			BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
			BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://192.168.68.62:11437",
			BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "test-token-value-".repeat(3),
			BITOVP_LOCAL_SEMANTIC_CA_FILE:
				"/run/bitovp-local-semantic/gateway-ca.pem",
			BITOVP_LOCAL_SEMANTIC_PROFILE: profile,
			BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "61ac833f-0aa4-4000-a000-000000000001",
		}))
			vi.stubEnv(key, value);
	}
	function japaneseInput(f: ReturnType<typeof fixture>) {
		const input = f.input();
		return {
			...input,
			parameters: {
				...input.parameters,
				policy: "LOCAL_STORY",
				renderMode: "DRAFT",
				captions: "JAPANESE",
			},
		};
	}
	it("pins the operator-selected Plamo manifest while preserving the Story model", async () => {
		configure();
		const folder = mkdtempSync(join(tmpdir(), "plamo-intake-fixture-"));
		captionFixtureFolders.push(folder);
		const file = join(folder, "installed.json");
		const manifest = {
			version: "bitovp-plamo-installed-manifest-v1",
			configId: "00000000-0000-4000-8000-000000000002",
			modelId: "pfnet/plamo-3-translate-31b",
			sourceRevision: "01eac57bf80ef8114decd998f8f3a803ba795557",
			weightSha256: hashEditingEvidence("authored fixture, no native model"),
			weightBytes: 43,
			quantization: "Q8_0",
			promptTemplateHash: PLAMO_CAPTION_TEMPLATE_HASH,
			contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
			runtimes: {
				nvidia: {
					sourceRevision: "a".repeat(40),
					binarySha256: hashEditingEvidence("authored runtime fixture"),
				},
			},
		};
		writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
		vi.stubEnv("BITOVP_LOCAL_CAPTION_PROVIDER", "PLAMO");
		vi.stubEnv("BITOVP_LOCAL_CAPTION_MANIFEST_FILE", file);
		const f = fixture();
		await createMediaTask(japaneseInput(f), "fixture");
		const envelope = fixtureItem(f.rows[0]).parameters as {
			identity: MediaTaskIdentity;
		};
		expect(envelope.identity.captionTranslationModel).toMatchObject({
			version: "local-caption-model-v3",
			provider: "LOCAL_LLAMA_CPP",
			weightSha256: manifest.weightSha256,
			manifestHash: hashEditingEvidence(manifest),
		});
		expect(envelope.identity.localStoryModel).toMatchObject({
			provider: "LOCAL_OLLAMA",
			profile: "nvidia",
			configId: "61ac833f-0aa4-4000-a000-000000000001",
		});
	});
	it("rejects an explicitly unavailable Plamo configuration before creating work instead of using Qwen", async () => {
		configure();
		vi.stubEnv("BITOVP_LOCAL_CAPTION_PROVIDER", "PLAMO");
		const f = fixture();
		await expect(
			createMediaTask(japaneseInput(f), "fixture"),
		).rejects.toMatchObject({
			status: 503,
			code: "LOCAL_CAPTION_TRANSLATION_UNAVAILABLE",
		});
		expect(f.rows).toEqual([]);
	});
	it("rejects an unconfigured local engine without creating work", async () => {
		const f = fixture(),
			input = f.input();
		await expect(
			createMediaTask(
				{
					...input,
					parameters: {
						...input.parameters,
						policy: "LOCAL_STORY",
						renderMode: "DRAFT",
					},
				},
				null,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ENGINE_UNAVAILABLE" });
		expect(f.rows).toHaveLength(0);
	});
	it("pins the fixed local model and ASR identity even when captions are off", async () => {
		configure();
		const f = fixture(),
			input = f.input();
		await createMediaTask(
			{
				...input,
				parameters: {
					...input.parameters,
					policy: "LOCAL_STORY",
					storyMode: "FLOW",
					renderMode: "DRAFT",
					captions: "OFF",
				},
			},
			null,
		);
		const envelope = f.rows[0]?.parameters as {
			identity: Record<string, unknown>;
		};
		expect(envelope.identity.localStoryModel).toMatchObject({
			provider: "LOCAL_OLLAMA",
			profile: "nvidia",
			model: "qwen3.8:27b-q8_0",
			context: 8192,
		});
		expect(envelope.identity).not.toHaveProperty("storyModel");
		expect(envelope.identity).not.toHaveProperty(
			"speechSelectionPolicyVersion",
		);
		expect(envelope.identity.modelSha256).toMatch(/^[a-f0-9]{64}$/);
	});
	it("replays the same intent without changing its pinned profile", async () => {
		configure();
		const f = fixture(),
			value = f.input();
		const input = {
			...value,
			parameters: {
				...value.parameters,
				policy: "LOCAL_STORY",
				renderMode: "DRAFT",
			},
		};
		const first = await createMediaTask(input, null);
		configure("amd");
		expect(await createMediaTask(input, null)).toMatchObject({
			taskId: first.taskId,
		});
		const envelope = f.rows[0]?.parameters as {
			identity: { localStoryModel: { profile: string } };
		};
		expect(envelope.identity.localStoryModel.profile).toBe("nvidia");
	});
	it("pins new draft requests to Choice only after the dedicated capability is ready", async () => {
		configure();
		vi.stubEnv("BITOVP_LOCAL_STORY_CHOICE_ENABLED", "1");
		const f = fixture(),
			value = f.input();
		const input = {
			...value,
			parameters: {
				...value.parameters,
				policy: "LOCAL_STORY",
				storyMode: "FLOW",
				renderMode: "DRAFT",
				captions: "OFF",
				tracking: true,
			},
		};
		await createMediaTask(input, null);
		expect(holder.choiceReady).toHaveBeenCalledTimes(1);
		const row = fixtureItem(f.rows[0]),
			envelope = row.parameters as {
				input: ReturnType<typeof mediaTaskCreateSchema.parse>;
				identity: MediaTaskIdentity;
			};
		expect(envelope.input.parameters).toMatchObject({
			storyPlanner: "FEASIBLE_CHOICE_V1",
			storyMode: "FLOW",
			renderMode: "DRAFT",
			targetDurationFrames: 60,
			captions: "OFF",
			tracking: true,
		});
		expect(envelope.identity.localStoryModel?.promptVersion).toBe(
			"local-story-v1",
		);
		expect(envelope.identity.generationPolicyFingerprint).toBe(
			GENERATION_POLICY_FINGERPRINT,
		);
		expect(row.requestHash).toBe(mediaTaskIntentHash(envelope.input));
	});
	it("does not create a Choice task when its new capability is missing", async () => {
		configure();
		vi.stubEnv("BITOVP_LOCAL_STORY_CHOICE_ENABLED", "1");
		holder.choiceReady.mockResolvedValue(false);
		const f = fixture(),
			value = f.input();
		await expect(
			createMediaTask(
				{
					...value,
					parameters: {
						...value.parameters,
						policy: "LOCAL_STORY",
						renderMode: "DRAFT",
					},
				},
				null,
			),
		).rejects.toMatchObject({
			code: "LOCAL_STORY_ENGINE_UNAVAILABLE",
			status: 503,
		});
		expect(f.rows).toEqual([]);
	});
	it("rejects an explicit new Choice intent while the operator flag is disabled", async () => {
		configure();
		const f = fixture(),
			value = f.input();
		await expect(
			createMediaTask(
				{
					...value,
					parameters: {
						...value.parameters,
						policy: "LOCAL_STORY",
						renderMode: "DRAFT",
						storyPlanner: "FEASIBLE_CHOICE_V1",
					},
				},
				null,
			),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ENGINE_UNAVAILABLE" });
		expect(holder.choiceReady).not.toHaveBeenCalled();
		expect(f.rows).toEqual([]);
	});
	it("replays an implicit old intent across a default change while rejecting explicit planner and payload changes", async () => {
		configure();
		const f = fixture(),
			value = f.input();
		const input = {
			...value,
			parameters: {
				...value.parameters,
				policy: "LOCAL_STORY",
				renderMode: "DRAFT",
				captions: "OFF",
			},
		};
		const first = await createMediaTask(input, null),
			before = structuredClone(f.rows);
		vi.stubEnv("BITOVP_LOCAL_STORY_CHOICE_ENABLED", "1");
		holder.choiceReady.mockResolvedValue(false);
		expect(await createMediaTask(input, null)).toMatchObject({
			taskId: first.taskId,
		});
		expect(holder.choiceReady).not.toHaveBeenCalled();
		for (const changed of [
			{
				...input,
				parameters: { ...input.parameters, storyPlanner: "FEASIBLE_CHOICE_V1" },
			},
			{
				...input,
				parameters: { ...input.parameters, targetDurationFrames: 90 },
			},
			{ ...input, parameters: { ...input.parameters, captions: "JAPANESE" } },
			{ ...input, mediaVersionId: randomUUID() },
			{ ...input, analysisRevisionId: randomUUID() },
		])
			await expect(createMediaTask(changed, null)).rejects.toMatchObject({
				code: "REQUEST_KEY_REUSED",
				status: 409,
			});
		expect(f.rows).toEqual(before);
	});
	it("replays a server-pinned Choice intent after the flag is disabled without rewriting it", async () => {
		configure();
		vi.stubEnv("BITOVP_LOCAL_STORY_CHOICE_ENABLED", "1");
		const f = fixture(),
			value = f.input();
		const input = {
			...value,
			parameters: {
				...value.parameters,
				policy: "LOCAL_STORY",
				renderMode: "DRAFT",
			},
		};
		const first = await createMediaTask(input, null),
			before = structuredClone(f.rows);
		vi.stubEnv("BITOVP_LOCAL_STORY_CHOICE_ENABLED", undefined);
		holder.choiceReady.mockClear().mockResolvedValue(false);
		expect(await createMediaTask(input, null)).toMatchObject({
			taskId: first.taskId,
		});
		expect(holder.choiceReady).not.toHaveBeenCalled();
		expect(f.rows).toEqual(before);
	});
	it("pins only the new retry task and leaves the failed old task and identity immutable", async () => {
		configure();
		const f = fixture(),
			value = f.input();
		const input = {
			...value,
			parameters: {
				...value.parameters,
				policy: "LOCAL_STORY",
				renderMode: "DRAFT",
			},
		};
		const first = await createMediaTask(input, null),
			old = fixtureItem(f.rows[0]);
		old.state = "ERROR";
		const before = structuredClone(old);
		vi.stubEnv("BITOVP_LOCAL_STORY_CHOICE_ENABLED", "1");
		const retried = await retryMediaTask(
			first.taskId,
			{ requestKey: randomUUID() },
			null,
		);
		expect(retried.taskId).not.toBe(first.taskId);
		expect(old).toEqual(before);
		const next = fixtureItem(f.rows[1]);
		expect(next.parentTaskId).toBe(first.taskId);
		expect(
			(next.parameters as { input: { parameters: unknown } }).input.parameters,
		).toMatchObject({ storyPlanner: "FEASIBLE_CHOICE_V1" });
	});
	it("does not enable the withdrawn coding-agent policy", async () => {
		configure();
		const f = fixture(),
			value = f.input();
		await expect(
			createMediaTask(
				{
					...value,
					parameters: {
						...value.parameters,
						policy: "STORY",
						renderMode: "DRAFT",
					},
				},
				null,
			),
		).rejects.toMatchObject({ code: "STORY_ENGINE_UNAVAILABLE" });
		expect(f.rows).toHaveLength(0);
	});
});
afterEach(() => {
	for (const folder of captionFixtureFolders.splice(0))
		rmSync(folder, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("generation intake keeps mutable projects outside result cache", () => {
	function configureStory(configId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
		vi.stubEnv("BITOVP_STORY_ENABLED", "1");
		vi.stubEnv("BITOVP_STORY_MODEL_ID", "gpt-6.1-sol");
		vi.stubEnv("BITOVP_STORY_CONFIG_ID", configId);
	}
	function historicalStoryTask(f: ReturnType<typeof fixture>) {
		const input = f.input();
		const value = mediaTaskCreateSchema.parse({
			...input,
			parameters: { ...input.parameters, policy: "STORY", renderMode: "DRAFT" },
		});
		if (value.kind !== "GENERATE") throw new Error("fixture");
		const identity: MediaTaskIdentity = {
			organizationId: f.organizationId,
			mediaSha256: f.media.sha256,
			modelSha256: null,
			analysisDocumentHash: null,
			analysisRawHash: null,
			timeMapHash: null,
			storyModel: {
				version: "aisa-story-model-v1",
				provider: "CODEX_CLI",
				model: "historical-story-model",
				promptVersion: "aisa-story-prompt-v1",
				schemaHash: "f".repeat(64),
				configId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			},
		};
		const row = {
			id: randomUUID(),
			organizationId: f.organizationId,
			mediaVersionId: value.mediaVersionId,
			analysisRevisionId: value.analysisRevisionId,
			kind: "GENERATE",
			state: "SUCCEEDED",
			phase: "COMPLETE",
			requestKey: value.requestKey,
			requestHash: mediaTaskIntentHash(value),
			cacheKey: mediaTaskCacheKey(value, identity),
			parentTaskId: null,
			parameters: { schemaVersion: 1, input: value, identity },
			result: { projectId: randomUUID() },
			createdAt: new Date(),
			finishedAt: new Date(),
			progress: null,
			error: null,
			attempts: 1,
		};
		f.rows.push(row);
		return { row, value };
	}
	it("withdraws new STORY requests even when the old model environment remains configured", async () => {
		configureStory();
		const f = fixture(),
			input = f.input();
		await expect(
			createMediaTask(
				{
					...input,
					parameters: {
						...input.parameters,
						policy: "STORY",
						renderMode: "DRAFT",
					},
				},
				null,
			),
		).rejects.toMatchObject({ status: 503, code: "STORY_ENGINE_UNAVAILABLE" });
		expect(f.rows).toHaveLength(0);
	});
	it("independently rejects STORY when the configured model is unavailable", async () => {
		const f = fixture(),
			input = f.input();
		await expect(
			createMediaTask(
				{
					...input,
					parameters: {
						...input.parameters,
						policy: "STORY",
						renderMode: "DRAFT",
					},
				},
				null,
			),
		).rejects.toMatchObject({ status: 503, code: "STORY_ENGINE_UNAVAILABLE" });
		expect(f.rows).toHaveLength(0);
	});
	it.each([
		"",
		"rabbit",
	])("rejects a crafted STORY context query %j before intake", async (query) => {
		configureStory();
		const f = fixture(),
			input = f.input();
		await expect(
			createMediaTask(
				{
					...input,
					parameters: {
						...input.parameters,
						policy: "STORY",
						renderMode: "DRAFT",
						query,
					},
				},
				null,
			),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(f.rows).toHaveLength(0);
	});
	it("keeps other generation identities free of withdrawn model settings", async () => {
		configureStory();
		const f = fixture();
		await createMediaTask(f.input(), null);
		const legacy = f.rows[0]?.parameters as { identity: MediaTaskIdentity };
		expect(legacy.identity).not.toHaveProperty("storyModel");
	});
	it("replays and reads a historical STORY receipt after the engine was withdrawn", async () => {
		const f = fixture(),
			{ row, value } = historicalStoryTask(f);
		const storedIdentity = structuredClone(row.parameters);
		configureStory();
		vi.stubEnv("WHISPER_MODEL_SHA256", "invalid-current-configuration");
		f.media.state = "ERROR";
		expect(await createMediaTask(value, null)).toEqual({
			taskId: row.id,
			state: "SUCCEEDED",
			cached: false,
		});
		expect(await readMediaTask(row.id)).toMatchObject({
			taskId: row.id,
			state: "SUCCEEDED",
			renderMode: "DRAFT",
			result: row.result,
		});
		expect(f.rows).toHaveLength(1);
		expect(row.parameters).toEqual(storedIdentity);
	});
	it("rejects a new STORY request key without reusing a historical project", async () => {
		const f = fixture(),
			{ row, value } = historicalStoryTask(f);
		const stored = structuredClone(row);
		configureStory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
		await expect(
			createMediaTask({ ...value, requestKey: randomUUID() }, null),
		).rejects.toMatchObject({ status: 503, code: "STORY_ENGINE_UNAVAILABLE" });
		expect(f.rows).toHaveLength(1);
		expect(row).toEqual(stored);
	});
	it("rejects retrying a failed historical STORY as a new task", async () => {
		const f = fixture(),
			{ row } = historicalStoryTask(f);
		row.state = "ERROR";
		configureStory();
		await expect(
			retryMediaTask(row.id, { requestKey: randomUUID() }, null),
		).rejects.toMatchObject({ status: 503, code: "STORY_ENGINE_UNAVAILABLE" });
		expect(f.rows).toHaveLength(1);
		expect(row.state).toBe("ERROR");
	});
	it("shows an explicitly requested DRAFT mode while preserving the missing legacy view field", async () => {
		const f = fixture(),
			input = f.input();
		const draft = await createMediaTask(
			{ ...input, parameters: { ...input.parameters, renderMode: "DRAFT" } },
			"fixture",
		);
		expect(await readMediaTask(draft.taskId)).toMatchObject({
			renderMode: "DRAFT",
		});
		const legacy = await createMediaTask(f.input(), "fixture");
		expect(await readMediaTask(legacy.taskId)).not.toHaveProperty("renderMode");
	});
	it("pins a verified prepared clock in the new generation identity and cache key", async () => {
		const f = fixture();
		const proof = authoredNormalizationReceipt({
			organizationId: f.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			sourceFrameCount: 48,
			width: 640,
			height: 360,
			preparedSha256: f.media.sha256,
		});
		const proofHash = hashEditingEvidence(proof);
		f.normalizationRows.push({
			organizationId: f.organizationId,
			mediaVersionId: f.media.id,
			sourceId: f.media.sourceId,
			kind: "NORMALIZATION_CAPTURE",
			analysisRevisionId: null,
			proof,
			proofHash,
		});
		await createMediaTask(f.input(), "fixture");
		const envelope = f.rows[0]?.parameters as {
			input: Parameters<typeof mediaTaskCacheKey>[0];
			identity: MediaTaskIdentity;
		};
		expect(envelope.identity.preparedShotClock).toEqual({
			version: "aisa-prepared-clock-v3",
			normalizationReceiptHash: proofHash,
		});
		const legacy = { ...envelope.identity };
		delete legacy.preparedShotClock;
		expect(f.rows[0]?.cacheKey).toBe(
			mediaTaskCacheKey(envelope.input, envelope.identity),
		);
		expect(f.rows[0]?.cacheKey).not.toBe(
			mediaTaskCacheKey(envelope.input, legacy),
		);
	});
	it("does not fall back to an older selector when a present normalization witness is invalid", async () => {
		const f = fixture();
		f.normalizationRows.push({
			organizationId: f.organizationId,
			mediaVersionId: f.media.id,
			sourceId: f.media.sourceId,
			kind: "NORMALIZATION_CAPTURE",
			analysisRevisionId: null,
			proof: {},
			proofHash: "d".repeat(64),
		});
		await expect(createMediaTask(f.input(), "fixture")).rejects.toMatchObject({
			code: "NORMALIZATION_EVIDENCE_UNVERIFIED",
		});
		expect(f.rows).toHaveLength(0);
	});
	it("queues a new request instead of returning a previously edited generated project", async () => {
		const f = fixture(),
			initial = f.input();
		const first = await createMediaTask(initial, "fixture");
		const editedProject = {
			id: randomUUID(),
			draftRevision: 3,
			title: "Operator edit",
		};
		const saved = {
			projectId: editedProject.id,
			projectIds: [editedProject.id],
			cacheable: true,
		};
		Object.assign(f.rows[0] ?? {}, {
			state: "SUCCEEDED",
			phase: "COMPLETE",
			result: saved,
			finishedAt: new Date(),
		});
		const next = await createMediaTask(
			{ ...initial, requestKey: randomUUID() },
			"fixture",
		);
		expect(next).toMatchObject({ state: "PENDING", cached: false });
		expect(next.taskId).not.toBe(first.taskId);
		expect((await readMediaTask(next.taskId)).result).toBeNull();
		expect(f.rows[0]?.result).toEqual(saved);
		expect(editedProject).toEqual({
			id: saved.projectId,
			draftRevision: 3,
			title: "Operator edit",
		});
	});
	it("still replays a completed generation for the same immutable request key", async () => {
		const f = fixture(),
			input = f.input();
		const first = await createMediaTask(input, null);
		Object.assign(f.rows[0] ?? {}, {
			state: "SUCCEEDED",
			result: { cacheable: true },
			finishedAt: new Date(),
		});
		expect(await createMediaTask(input, null)).toMatchObject({
			taskId: first.taskId,
			state: "SUCCEEDED",
		});
		expect(f.rows).toHaveLength(1);
	});
	it("rejects an explicit old tracker dependency at HTTP intake", async () => {
		const f = fixture(),
			dep = f.dependency();
		dep.parameters.identity.trackingAlgorithmVersion = "template-ncc-v1";
		dep.result.algorithm = "template-ncc-v1";
		dep.requestHash = mediaTaskIntentHash(dep.parameters.input);
		dep.cacheKey = mediaTaskCacheKey(
			dep.parameters.input,
			dep.parameters.identity,
		);
		await expect(
			createMediaTask(
				{
					...f.input(),
					parameters: {
						...f.input().parameters,
						tracking: true,
						trackingTaskId: dep.id,
					},
				},
				null,
			),
		).rejects.toMatchObject({ code: "TASK_DEPENDENCY_INVALID" });
		expect(f.rows).toHaveLength(1);
	});
});
