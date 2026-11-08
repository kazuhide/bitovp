import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CompositionDocument,
	hashEditingEvidence,
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	localPlamoCaptionIdentityForManifest,
	PLAMO_CAPTION_TEMPLATE_HASH,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfiguredLocalCaptionTranslator } from "./configured-local-caption-translation";
import { createLocalPlamoCaptionClient } from "./local-plamo-caption-client";
import {
	LocalSemanticHttpError,
	LocalSemanticTransportError,
	localSemanticJobId,
	type SemanticRpc,
} from "./local-semantic-client";
import type { LocalStoryArtifactStore } from "./local-story-artifacts";
import type { VerifiedMediaTask } from "./media-task-execution";

const mocks = vi.hoisted(() => ({ createStore: vi.fn() }));
vi.mock("./local-story-artifacts", () => ({
	createLocalStoryArtifactStore: mocks.createStore,
}));
const config = {
	url: "https://fixture.invalid",
	token: "fixture-not-secret-".repeat(3),
	caFile: "/unused",
	profile: "nvidia" as const,
	configId: randomUUID(),
};
const manifest = {
	version: "bitovp-plamo-installed-manifest-v1",
	configId: randomUUID(),
	modelId: "pfnet/plamo-3-translate-31b",
	sourceRevision: "01eac57bf80ef8114decd998f8f3a803ba795557",
	weightSha256: "a".repeat(64),
	weightBytes: 1234,
	quantization: "Q8_0",
	promptTemplateHash: PLAMO_CAPTION_TEMPLATE_HASH,
	contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	runtimes: {
		nvidia: { sourceRevision: "a".repeat(40), binarySha256: "b".repeat(64) },
	},
};
const identity = localPlamoCaptionIdentityForManifest(manifest, "nvidia");
const cache = new Map<string, unknown>();
beforeEach(() => {
	cache.clear();
	mocks.createStore.mockReturnValue({
		load: async (input: Parameters<LocalStoryArtifactStore["load"]>[0]) => {
			const key = hashEditingEvidence(input.key),
				cached = cache.has(key),
				value = input.parse(cached ? cache.get(key) : await input.build());
			if (!cached) cache.set(key, structuredClone(value));
			return { value, cached, hash: hashEditingEvidence(value) };
		},
	});
});
function fixture(
	count = 2,
	change?: (value: Record<string, unknown>, index: number) => unknown,
	selectedIdentity: ReturnType<
		typeof localPlamoCaptionIdentityForManifest
	> = identity,
) {
	const selectedConfig = { ...config, profile: selectedIdentity.profile };
	let calls = 0;
	const rpc = vi.fn<SemanticRpc>(async (method, path, raw) => {
		if (method !== "POST" || path !== "/v1/plamo-caption-jobs")
			throw new Error("unexpected request");
		const body = raw as {
			organizationId: string;
			requestKey: string;
			inputHash: string;
			schemaHash: string;
			prompt: string;
		};
		const job = {
			id: localSemanticJobId(body.organizationId, body.requestKey),
			state: "SUCCEEDED",
			stage: "LOCAL_PLAMO_CAPTION_JA_V1",
			requestHash: hashEditingEvidence(body),
			cleanupConfirmed: true,
			result: {
				content: "こんにちは。",
				receipt: {
					version: "bitovp-plamo-caption-receipt-v1",
					identity: selectedIdentity,
					profile: selectedIdentity.profile,
					manifestHash: selectedIdentity.manifestHash,
					inputHash: body.inputHash,
					promptHash: "",
					schemaHash: body.schemaHash,
					promptVersion: selectedIdentity.promptVersion,
					context: 8192,
					maxOutputTokens: 1536,
					thinking: false,
					requestHash: hashEditingEvidence(body),
					elapsedMs: 10,
					startupReadyMs: 3,
					apiStats: {
						promptEvalCount: 10,
						evalCount: 4,
						promptEvalMs: 2,
						evalMs: 4,
						doneReason: "stop",
					},
					placement: {
						backend:
							selectedIdentity.runtimeBackend ??
							(selectedIdentity.profile === "amd" ? "ROCM" : "CUDA"),
						observedOwnedGpuMemoryBytes: 100,
						source:
							selectedIdentity.profile === "amd"
								? "DRM_FDINFO"
								: "NVIDIA_PROCESS_QUERY",
						gpuLayersRequested: 10,
					},
					cleanupConfirmed: true,
					runtimeProcessStopped: true,
					schemaVerified: false,
				},
			},
		};
		const { createHash } = await import("node:crypto");
		job.result.receipt.promptHash = createHash("sha256")
			.update(body.prompt)
			.digest("hex");
		return change ? change(job, ++calls) : job;
	});
	const client = createLocalPlamoCaptionClient(
		selectedConfig,
		selectedIdentity,
		{
			rpc,
			wait: async () => {},
		},
	);
	const translator = createConfiguredLocalCaptionTranslator({
		prisma: {} as AppPrismaClient,
		config: selectedConfig,
		selection: {
			provider: "PLAMO",
			identity: selectedIdentity,
			manifestHash: selectedIdentity.manifestHash,
		},
		plamoClient: client,
	});
	const document = {
		clips: [],
		captions: Array.from({ length: count }, (_, i) => ({
			id: randomUUID(),
			text: `Hello ${i}`,
			fromFrame: i * 30,
			toFrame: i * 30 + 29,
			words: [
				{
					text: "Hello",
					startChar: 0,
					endChar: 5,
					fromFrame: i * 30,
					toFrame: i * 30 + 10,
				},
			],
		})),
	} as unknown as CompositionDocument;
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
					captionTranslationModel: selectedIdentity,
					transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
				},
			},
		} as unknown as VerifiedMediaTask,
		leaseToken: randomUUID(),
		document,
		sourceLanguage: "en" as const,
		signal: new AbortController().signal,
		onProgress: async () => {},
	};
	return {
		rpc,
		translator,
		context,
		execute: () => translator.translate(context),
	};
}
describe("configured caption provider without fallback", () => {
	it("accepts the selected AMD Vulkan receipt and rejects a forged ROCM receipt before publication", async () => {
		const selected = localPlamoCaptionIdentityForManifest(
			{
				...manifest,
				runtimes: {
					amd: { ...manifest.runtimes.nvidia, backend: "VULKAN" },
				},
			},
			"amd",
		);
		const good = fixture(1, undefined, selected);
		expect(
			(await good.execute()).document.captions?.[0]?.translation?.origin,
		).toBe("LOCAL_LLM");
		cache.clear();
		const bad = fixture(
			1,
			(raw) => {
				const job = raw as {
					result: { receipt: { placement: { backend: string } } };
				};
				job.result.receipt.placement.backend = "ROCM";
				return job;
			},
			selected,
		);
		await expect(bad.execute()).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(cache.size).toBe(0);
		expect(bad.context.document.captions?.[0]?.translation).toBeUndefined();
	});

	it("runs the actual shared-schema preflight subprocess for valid and missing installed manifests", () => {
		const directory = mkdtempSync(join(tmpdir(), "caption-preflight-")),
			file = join(directory, "manifest.json");
		try {
			writeFileSync(
				file,
				JSON.stringify({
					version: "bitovp-plamo-installed-manifest-v1",
					configId: identity.configId,
					modelId: identity.modelId,
					sourceRevision: identity.sourceRevision,
					weightSha256: identity.weightSha256,
					weightBytes: identity.weightBytes,
					quantization: identity.quantization,
					promptTemplateHash: identity.promptTemplateHash,
					contextPolicyFingerprint: identity.contextPolicyFingerprint,
					runtimes: {
						nvidia: {
							sourceRevision: identity.runtimeSourceRevision,
							binarySha256: identity.runtimeBinarySha256,
						},
					},
				}),
				{ mode: 0o600 },
			);
			const env = {
				PATH: process.env.PATH,
				BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
				BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://fixture.invalid",
				BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN:
					"synthetic_fixture_token_123456789012345",
				BITOVP_LOCAL_SEMANTIC_CA_FILE: "/unused/fixture-ca.pem",
				BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
				BITOVP_LOCAL_SEMANTIC_CONFIG_ID: config.configId,
				BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
				BITOVP_LOCAL_CAPTION_MANIFEST_FILE: file,
			};
			const cli = fileURLToPath(
					new URL(
						"../../../../tools/local-semantic-gateway/plamo-manifest-preflight.ts",
						import.meta.url,
					),
				),
				tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
			const good = spawnSync(process.execPath, [tsx, cli], {
				env,
				encoding: "utf8",
			});
			expect(good.status, good.stderr).toBe(0);
			expect(JSON.parse(good.stdout)).toMatchObject({
				provider: "PLAMO",
				identity,
			});
			const bad = spawnSync(process.execPath, [tsx, cli], {
				env: { ...env, BITOVP_LOCAL_CAPTION_MANIFEST_FILE: `${file}.missing` },
				encoding: "utf8",
			});
			expect(bad.status).toBe(1);
			expect(bad.stdout).toBe("");
			expect(bad.stderr).toContain("LOCAL_CAPTION_CONFIGURATION_INVALID");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("uses only the dedicated protocol, preserves source clocks and revalidates the aggregate cache", async () => {
		const f = fixture(),
			source = structuredClone(f.context.document.captions),
			result = await f.execute();
		expect(f.rpc).toHaveBeenCalledTimes(2);
		expect(result.artifactHashes).toHaveLength(1);
		expect(
			result.document.captions?.map(
				({ translation: _translation, ...caption }) => caption,
			),
		).toEqual(source);
		expect(
			result.document.captions?.every(
				(caption) => caption.translation?.origin === "LOCAL_LLM",
			),
		).toBe(true);
		await f.execute();
		expect(f.rpc).toHaveBeenCalledTimes(2);
		const row = [...cache.values()][0] as {
			items: { receipt: { manifestHash: string } }[];
		};
		if (!row.items[0]) throw Error("missing fixture");
		row.items[0].receipt.manifestHash = "f".repeat(64);
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_ARTIFACT_UNVERIFIED",
		});
		expect(f.rpc).toHaveBeenCalledTimes(2);
	});
	it("does not publish any partial document after a later cue fails", async () => {
		const f = fixture(2, (job, i) => {
			if (i === 2) throw new Error("native fixture failure");
			return job;
		});
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(cache.size).toBe(0);
		expect(
			f.context.document.captions?.some((caption) => caption.translation),
		).toBe(false);
	});
	it("has no model calls for no speech or current manual translations", async () => {
		const empty = fixture(0);
		await empty.execute();
		expect(empty.rpc).not.toHaveBeenCalled();
		const manual = fixture(1),
			caption = manual.context.document.captions?.[0];
		if (!caption) throw Error("missing fixture");
		caption.translation = {
			origin: "MANUAL",
			targetLanguage: "ja",
			text: "手動訳",
			sourceText: caption.text,
			sourceTextHash: hashEditingEvidence(caption.text),
		};
		const result = await manual.execute();
		expect(result.document.captions?.[0]).toEqual(caption);
		expect(manual.rpc).not.toHaveBeenCalled();
	});
	it("rejects changed provider identity before any native call", async () => {
		const f = fixture();
		f.context.verified.envelope.identity.captionTranslationModel = {
			...identity,
			weightSha256: "f".repeat(64),
		};
		await expect(f.execute()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_MODEL_CHANGED",
		});
		expect(f.rpc).not.toHaveBeenCalled();
	});
	it("requires an owned release after ambiguous acceptance and never retries create", async () => {
		const request = {
			version: "bitovp-plamo-caption-job-v1" as const,
			requestKey: randomUUID(),
			organizationId: randomUUID(),
			profile: "nvidia" as const,
			stage: "LOCAL_PLAMO_CAPTION_JA_V1" as const,
			prompt: "fixture",
			inputHash: "a".repeat(64),
			schemaHash: identity.schemaHash,
			promptVersion: identity.promptVersion,
			manifestHash: identity.manifestHash,
		};
		const rpc = vi.fn<SemanticRpc>(async (_method, path) => {
			if (path.endsWith("/cancel"))
				throw new LocalSemanticHttpError(404, "JOB_NOT_FOUND");
			throw new LocalSemanticTransportError("ETIMEDOUT");
		});
		await expect(
			createLocalPlamoCaptionClient(config, identity, { rpc }).run({
				request,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "LOCAL_SEMANTIC_UNAVAILABLE" });
		expect(rpc.mock.calls.map(([method, path]) => [method, path])).toEqual([
			["POST", "/v1/plamo-caption-jobs"],
			[
				"POST",
				`/v1/plamo-caption-jobs/${localSemanticJobId(request.organizationId, request.requestKey)}/cancel`,
			],
		]);
	});
});
