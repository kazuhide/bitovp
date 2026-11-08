import { createHash, randomUUID } from "node:crypto";
import {
	type CompositionDocument,
	hashEditingEvidence,
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	type LocalSemanticReceipt,
	localCaptionIdentityForConfiguration,
	sceneAnalysisDocumentSchema,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalCaptionTranslator } from "./local-caption-translation";
import type { createLocalSemanticClient } from "./local-semantic-client";
import type { LocalStoryArtifactStore } from "./local-story-artifacts";
import type { VerifiedMediaTask } from "./media-task-execution";
import { MediaOperationError } from "./process";

const mocks = vi.hoisted(() => ({ createStore: vi.fn() }));
vi.mock("./local-story-artifacts", () => ({
	createLocalStoryArtifactStore: mocks.createStore,
}));
type Run = ReturnType<typeof createLocalSemanticClient>["run"];
const config = {
	url: "https://fixture.invalid",
	token: "fixture-token-not-a-secret-".repeat(2),
	caFile: "/unused/ca.pem",
	profile: "nvidia" as const,
	configId: "11111111-1111-4111-8111-111111111111",
};
const identity = localCaptionIdentityForConfiguration(config);
const cache = new Map<string, unknown>();
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw Error("missing test fixture");
	return value;
};
beforeEach(() => {
	cache.clear();
	mocks.createStore.mockReset();
	mocks.createStore.mockReturnValue({
		load: async (input: Parameters<LocalStoryArtifactStore["load"]>[0]) => {
			const key = hashEditingEvidence(input.key),
				cached = cache.has(key),
				value = input.parse(cached ? cache.get(key) : await input.build());
			if (!cached) cache.set(key, structuredClone(value));
			return { value, hash: hashEditingEvidence(value), cached };
		},
	});
});
function fixture(
	options: {
		count?: number;
		change?: (content: unknown, attempt: number) => unknown;
		failure?: string;
		badReceipt?: boolean;
	} = {},
) {
	let attempt = 0;
	const run = vi.fn<Run>(async (input) => {
		attempt++;
		if (options.failure) throw new MediaOperationError(options.failure);
		const { signal: _signal, ...args } = input;
		const body = {
			version: "bitovp-semantic-job-v1",
			profile: config.profile,
			promptVersion: "caption-ja-v2",
			...args,
		};
		const data = JSON.parse(
			required(
				required(input.prompt.split("\nDATA:")[1]).split("\nREPAIR:")[0],
			),
		) as { cues: { id: string; text: string }[] };
		const content = {
			translations: data.cues.map((c) => ({ id: c.id, text: `訳 ${c.text}` })),
		};
		const receipt: LocalSemanticReceipt = {
			version: "bitovp-semantic-receipt-v1",
			profile: config.profile,
			model: LOCAL_SEMANTIC_MODEL,
			modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
			runtimeVersion: "0.40.14",
			inputHash: input.inputHash,
			promptHash: createHash("sha256").update(input.prompt).digest("hex"),
			schemaHash: input.schemaHash,
			promptVersion: "caption-ja-v2",
			context: 8192,
			maxOutputTokens: 1536,
			thinking: false,
			requestHash: hashEditingEvidence(body),
			elapsedMs: 5,
			apiStats: {
				promptEvalCount: 20,
				evalCount: 10,
				doneReason: "stop",
				loadDurationNs: 1,
				promptEvalDurationNs: 1,
				evalDurationNs: 1,
			},
			placement: [
				{
					name: LOCAL_SEMANTIC_MODEL,
					size: 29_000_000_000,
					sizeVram: 14_000_000_000,
					contextLength: 8192,
				},
			],
			cleanupConfirmed: true,
			schemaVerified: false,
		};
		if (options.badReceipt) receipt.schemaHash = "f".repeat(64);
		return {
			content: options.change ? options.change(content, attempt) : content,
			receipt,
		};
	});
	const translator = createLocalCaptionTranslator({
		prisma: {} as AppPrismaClient,
		config,
		client: { run },
	});
	const captions = Array.from({ length: options.count ?? 2 }, (_, i) => ({
		id: randomUUID(),
		fromFrame: i * 30,
		toFrame: i * 30 + 29,
		text: `Spoken cue ${i}.`,
		words: [
			{
				text: "Spoken",
				startChar: 0,
				endChar: 6,
				fromFrame: i * 30,
				toFrame: i * 30 + 10,
			},
		],
	}));
	const document = { captions, clips: [] } as unknown as CompositionDocument;
	const controller = new AbortController();
	const context = {
		task: {
			id: randomUUID(),
			organizationId: randomUUID(),
		} as LibraryMediaTask,
		verified: {
			analysisDocument: { scenes: [] },
			media: { id: randomUUID() },
			map: { id: randomUUID() },
			envelope: {
				identity: {
					captionTranslationModel: identity,
					transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
				},
			},
		} as unknown as VerifiedMediaTask,
		leaseToken: randomUUID(),
		document,
		sourceLanguage: "en" as const,
		signal: controller.signal,
		onProgress: vi.fn(async () => {}),
	};
	return {
		translator,
		context,
		run,
		document,
		controller,
		execute: () => translator.translate(context),
	};
}
describe("local caption translator with immutable evidence", () => {
	it("keeps only validated cache evidence and no document changes when a later batch fails", async () => {
		const f = fixture({
			count: 10,
			change: (content, attempt) =>
				attempt === 1 ? content : { translations: [] },
		});
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_TRANSLATION_INVALID",
		});
		expect(f.run).toHaveBeenCalledTimes(3);
		expect(cache.size).toBe(1);
		expect(f.document.captions?.some((c) => c.translation)).toBe(false);
	});
	it("translates exact cues after timing is fixed and reuses validated stage artifacts", async () => {
		const f = fixture();
		const result = await f.execute();
		expect(result.document.captionDisplayLanguage).toBe("ja");
		expect(
			result.document.captions?.map((c) => ({
				id: c.id,
				text: c.text,
				fromFrame: c.fromFrame,
				toFrame: c.toFrame,
				words: c.words,
			})),
		).toEqual(f.document.captions);
		expect(
			result.document.captions?.every(
				(c) => c.translation?.origin === "LOCAL_LLM",
			),
		).toBe(true);
		await f.execute();
		expect(f.run).toHaveBeenCalledTimes(1);
		expect(result.artifactHashes).toHaveLength(1);
		expect(f.run.mock.calls[0]?.[0].stage).toBe("LOCAL_CAPTION_JA_V2");
	});
	it("preserves a current manual translation and its original clock without model calls", async () => {
		const f = fixture({ count: 1 }),
			caption = required(f.document.captions?.[0]);
		caption.translation = {
			targetLanguage: "ja",
			text: "手動の訳",
			sourceText: caption.text,
			sourceTextHash: hashEditingEvidence(caption.text),
			origin: "MANUAL",
			derivedFromEvidenceHash: "a".repeat(64),
		};
		const before = structuredClone(caption),
			result = await f.execute();
		expect(result.document.captions?.[0]).toEqual(before);
		expect(f.run).not.toHaveBeenCalled();
	});
	it("carries accepted wording across batches only for the same bound shot context", async () => {
		const f = fixture({ count: 10 }),
			clipId = randomUUID(),
			sceneId = randomUUID();
		f.document.mediaVersionId = f.context.verified.media.id;
		f.document.timeMapId = f.context.verified.map.id;
		f.document.clips = [
			{
				id: clipId,
				sourceInUs: 0,
				timelineStartFrame: 0,
				durationFrames: 300,
				evidence: { sceneId, shotIndex: 0 },
			},
		] as CompositionDocument["clips"];
		f.context.verified.analysisDocument = sceneAnalysisDocumentSchema.parse({
			providerVersion: "fixture",
			duration: 10,
			scenes: [
				{
					id: sceneId,
					startInSeconds: 0,
					endInSeconds: 10,
					title: "By the river",
					shots: [{ startInSeconds: 0, endInSeconds: 10 }],
				},
			],
		});
		for (const caption of f.document.captions ?? []) {
			caption.text = "Hello.";
			caption.anchorClipId = clipId;
			caption.words = [];
		}
		await f.execute();
		expect(f.run).toHaveBeenCalledTimes(2);
		const second = required(f.run.mock.calls[1]?.[0]);
		expect(second.prompt).toContain('"acceptedTranslation":"訳 Hello."');
		const beforeCalls = f.run.mock.calls.length;
		required(f.context.verified.analysisDocument?.scenes[0]).title =
			"At a finance counter";
		await f.execute();
		expect(f.run.mock.calls.length - beforeCalls).toBe(2);
	});
	it("rejects a changed translation context policy before inference", async () => {
		const f = fixture();
		f.context.verified.envelope.identity.captionTranslationModel = {
			...identity,
			contextPolicyFingerprint: "f".repeat(64),
		} as typeof identity;
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_MODEL_CHANGED",
		});
		expect(f.run).not.toHaveBeenCalled();
	});
	it("does not call the model or invent subtitles for an empty speech result", async () => {
		const f = fixture({ count: 0 }),
			result = await f.execute();
		expect(result.document.captions).toEqual([]);
		expect(result.artifactHashes).toEqual([]);
		expect(f.run).not.toHaveBeenCalled();
	});
	it("repairs structural failure only once and never caches invalid output", async () => {
		const f = fixture({
			change: (content, attempt) =>
				attempt === 1 ? { translations: [] } : content,
		});
		await f.execute();
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(cache.size).toBe(1);
	});
	it("fails after two unsupported outputs and publishes no partial caption mutation", async () => {
		const f = fixture({
			count: 10,
			change: () => ({ translations: [{ id: "invented", text: "架空。" }] }),
		});
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_TRANSLATION_INVALID",
		});
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(cache.size).toBe(0);
		expect(f.document.captions?.some((c) => c.translation)).toBe(false);
	});
	it("does not turn provider failure into a semantic repair", async () => {
		const f = fixture({ failure: "LOCAL_SEMANTIC_JOB_FAILED" });
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_JOB_FAILED",
		});
		expect(f.run).toHaveBeenCalledTimes(1);
	});
	it("rejects receipt mismatch and abort before invoking any model", async () => {
		const bad = fixture({ badReceipt: true });
		await expect(bad.execute()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_ARTIFACT_UNVERIFIED",
		});
		expect(bad.run).toHaveBeenCalledTimes(1);
		expect(cache.size).toBe(0);
		const canceled = fixture();
		canceled.controller.abort();
		await expect(canceled.execute()).rejects.toBeDefined();
		expect(canceled.run).not.toHaveBeenCalled();
	});
	it("rejects a modified cached output rather than silently rerunning or accepting it", async () => {
		const f = fixture();
		await f.execute();
		const [key, value] = required([...cache.entries()][0]);
		(value as { output: unknown }).output = { translations: [] };
		cache.set(key, value);
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_ARTIFACT_UNVERIFIED",
		});
		expect(f.run).toHaveBeenCalledTimes(1);
	});
});
