import { randomUUID } from "node:crypto";
import {
	buildLocalStoryInput,
	CAPTION_ALIGNMENT_POLICY,
	compositionDocumentSchema,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	localCaptionIdentityForConfiguration,
	localStoryEvidenceSchema,
	localStoryIdentityForConfiguration,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
	resolveLocalStorySubjects,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import { authoredNormalizationReceipt } from "@bitovp/core/testing";
import type { AppTransactionClient } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type alignSelectedCaptionSegments,
	captionAlignmentInputHash,
} from "./caption-forced-alignment";
import {
	createLibraryGenerationHandler,
	generationObjectId,
} from "./generation";
import { generationDependencyFixture } from "./generation-dependency-fixture";
import type { LocalCaptionTranslator } from "./local-caption-translation";
import {
	type LocalStoryEngine,
	type LocalStoryGeneration,
	localStoryArtifactHash,
} from "./local-story-engine";
import { MediaOperationError } from "./process";
import * as tracking from "./tracking";

function fixtureItem<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture");
	return value;
}

const identity = localStoryIdentityForConfiguration({
	url: "https://192.168.68.62:11437",
	token: "authored-test-token-not-a-real-secret",
	caFile: "/authored/ca.pem",
	profile: "nvidia",
	configId: "4500e516-c776-464a-a8dc-f5f2988a1268",
});

function fixture(
	options: {
		captions?: "AUTO" | "OFF" | "ORIGINAL" | "JAPANESE";
		prepared?: boolean;
		captionTranslator?: LocalCaptionTranslator;
		captionAligner?: typeof alignSelectedCaptionSegments;
	} = {},
) {
	const f = generationDependencyFixture("TRACK");
	Object.assign(f.task.parameters.input.parameters, {
		policy: "LOCAL_STORY",
		storyMode: "AUTO",
		renderMode: "DRAFT",
		captions: options.captions ?? "OFF",
		tracking: false,
	});
	delete f.task.parameters.input.parameters.trackingTaskId;
	delete f.task.parameters.input.parameters.transcriptionTaskId;
	Object.assign(f.task.parameters.identity, { localStoryModel: identity });
	if (options.captions === "JAPANESE")
		Object.assign(f.task.parameters.identity, {
			captionTranslationModel:
				options.captionTranslator?.identity ??
				localCaptionIdentityForConfiguration({
					profile: identity.profile,
					configId: identity.configId,
				} as Parameters<typeof localCaptionIdentityForConfiguration>[0]),
			transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		});
	let normalizationReceiptHash: string | undefined;
	if (options.prepared) {
		const proof = authoredNormalizationReceipt({
			organizationId: f.task.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			sourceFrameCount: 144,
			width: f.media.width,
			height: f.media.height,
			preparedSha256: f.media.sha256,
			hasAudio: true,
		});
		normalizationReceiptHash = hashEditingEvidence(proof);
		const row = {
			id: randomUUID(),
			organizationId: f.task.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId: null,
			kind: "NORMALIZATION_CAPTURE",
			proof,
			proofHash: normalizationReceiptHash,
		};
		const transaction = f.prisma.$transaction.bind(f.prisma);
		Object.assign(f.prisma, {
			libraryEvidenceReceipt: { findMany: async () => [row] },
			$transaction: async <T>(
				callback: (tx: AppTransactionClient) => Promise<T>,
			) =>
				transaction(async (tx) => {
					Object.assign(tx, {
						libraryEvidenceReceipt: { findMany: async () => [row] },
					});
					return callback(tx);
				}),
		});
		Object.assign(f.task.parameters.identity, {
			preparedShotClock: {
				version: "aisa-prepared-clock-v3",
				normalizationReceiptHash,
			},
		});
	}
	const refresh = () => {
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
	};
	refresh();
	const selection = {
		selectedBeatIds: ["beat0"],
		selectedEventIds: ["event0"],
		reason: "COMPLETE_BEATS" as const,
	};
	const ledger = {
		version: "local-story-corpus-v1" as const,
		summaries: ["Authored local story integration evidence"],
		events: [
			{
				id: "event0",
				label: "Authored scene",
				role: "ACTION" as const,
				refs: ["s0", "s1"],
				quotes: [{ ref: "s0", quote: "Explicit authored test annotation" }],
				subjects: [],
				uncertainty: "",
			},
		],
		coveredRefs: ["s0", "s1", "s2"],
	};
	const blueprint = {
		mode: "FLOW" as const,
		message: "An authored complete scene",
		beats: [
			{
				id: "beat0",
				role: "ACTION" as const,
				eventIds: ["event0"],
				requires: [],
			},
		],
		uncertainty: "",
	};
	const hashes = {
		model: identity,
		inputHash: hashEditingEvidence({
			analysis: f.analysis.document,
			clock: f.media.timeMap,
		}),
		ledgerHash: hashEditingEvidence(ledger),
		blueprintHash: hashEditingEvidence(blueprint),
	};
	const authored: LocalStoryGeneration = {
		selection: {
			policyVersion: options.prepared
				? "aisa-prepared-local-story-window-v1"
				: "aisa-local-story-window-v1",
			requestedDurationFrames: 120,
			actualDurationFrames: 120,
			clips: [0, 1].map((shotIndex) => ({
				sceneId: f.sceneIds[0] ?? "",
				shotIndex,
				sourceInUs: shotIndex * 2_000_000,
				durationFrames: 60,
			})),
			reasonCodes: ["LOCAL_LLM_COMPLETE_BEATS"],
			...(normalizationReceiptHash ? { normalizationReceiptHash } : {}),
			localStorySelection: selection,
		},
		evidence: localStoryEvidenceSchema.parse({
			version: "local-story-evidence-v1",
			method: "LOCAL_LLM_BEAT_PLAN",
			...hashes,
			artifactHash: localStoryArtifactHash(hashes),
			ledger,
			blueprint,
			selection,
			inputCoverage: {
				totalShots: 3,
				eligibleShots: 3,
				processedShots: 3,
				excludedShots: 0,
				truncated: false,
			},
		}),
		segments: [
			{
				startUs: 100_000,
				endUs: 900_000,
				text: "Hello",
				words: [
					{
						text: "Hello",
						startChar: 0,
						endChar: 5,
						startUs: 100_000,
						endUs: 900_000,
						confidence: 0.9,
					},
				],
			},
		],
		warnings: ["LOCAL_STORY_VISUAL_GROUNDING_PENDING"],
		metrics: { localStoryStagesExecuted: 2 },
	};
	const plan = vi.fn<LocalStoryEngine["plan"]>(async () =>
		structuredClone(authored),
	);
	const engine: LocalStoryEngine = { identity, plan };
	return {
		...f,
		authored,
		engine,
		plan,
		refresh,
		normalizationReceiptHash,
		run: () =>
			createLibraryGenerationHandler({
				prisma: f.prisma,
				localStoryEngine: engine,
				captionTranslator: options.captionTranslator,
				captionAligner: options.captionAligner,
			})(f.context),
		render: vi.spyOn(f.prisma.renderRun, "create"),
		derive: vi.spyOn(f.prisma.contentDerivation, "create"),
	};
}

function document(f: ReturnType<typeof fixture>) {
	return compositionDocumentSchema.parse(f.projects[0]?.draft);
}
function expectNoPublication(f: ReturnType<typeof fixture>) {
	expect(f.projects).toEqual([]);
	expect(f.revisions).toEqual([]);
	expect(f.render).not.toHaveBeenCalled();
	expect(f.derive).not.toHaveBeenCalled();
}

describe("local story project generation", () => {
	it.each([
		undefined,
		"f".repeat(64),
	])("rejects a fresh task with stale or missing GENERATE policy %s before model work", async (pin) => {
		const f = fixture();
		if (pin === undefined)
			delete f.task.parameters.identity.generationPolicyFingerprint;
		else f.task.parameters.identity.generationPolicyFingerprint = pin;
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "GENERATION_POLICY_CHANGED",
		});
		expect(f.plan).not.toHaveBeenCalled();
		expectNoPublication(f);
	});
	it("pins published results and rejects a forged policy during replay", async () => {
		const f = fixture(),
			result = await f.run();
		expect(result.generationPolicyFingerprint).toBe(
			GENERATION_POLICY_FINGERPRINT,
		);
		Object.assign(f.task, {
			state: "SUCCEEDED",
			result: { ...result, generationPolicyFingerprint: "f".repeat(64) },
		});
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
	});
	it("keeps an unpinned succeeded result readable as history without producing another project", async () => {
		const f = fixture(),
			result = await f.run();
		delete f.task.parameters.identity.generationPolicyFingerprint;
		const legacy = { ...result };
		delete legacy.generationPolicyFingerprint;
		f.refresh();
		Object.assign(f.task, { state: "SUCCEEDED", result: legacy });
		await expect(f.run()).resolves.toEqual(legacy);
		expect(f.projects).toHaveLength(1);
	});
	it("hands the selected key object's identity to tracking without launching an export", async () => {
		const track = vi.spyOn(tracking, "trackShotSubjects").mockResolvedValue({
			schemaVersion: 1,
			algorithm: LOCAL_TRACKING_ALGORITHM_VERSION,
			frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
			mediaSha256: "a".repeat(64),
			cacheKey: "b".repeat(64),
			sampleFps: 3,
			observations: [],
			fallbacks: [],
		});
		try {
			const f = fixture();
			f.task.parameters.input.parameters.tracking = true;
			fixtureItem(f.authored.evidence.ledger.events[0]).subjects = ["person"];
			f.authored.evidence.ledgerHash = hashEditingEvidence(
				f.authored.evidence.ledger,
			);
			f.authored.evidence.artifactHash = localStoryArtifactHash(
				f.authored.evidence,
			);
			f.refresh();
			await f.run();
			expect(track).toHaveBeenCalledWith(
				expect.objectContaining({
					adaptiveRecovery: true,
					shots: expect.arrayContaining([
						expect.objectContaining({
							targetId: expect.stringMatching(/^target-[a-f0-9]{64}$/),
							seed: expect.objectContaining({
								box: { x: 0.4, y: 0.1, w: 0.2, h: 0.7 },
							}),
						}),
					]),
				}),
			);
			expect(f.render).not.toHaveBeenCalled();
		} finally {
			track.mockRestore();
		}
	});
	it("keeps ungrounded selected objects FIT and does not track a convenient unrelated person", async () => {
		const track = vi.spyOn(tracking, "trackShotSubjects").mockResolvedValue({
			schemaVersion: 1,
			algorithm: LOCAL_TRACKING_ALGORITHM_VERSION,
			frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
			mediaSha256: "a".repeat(64),
			cacheKey: "b".repeat(64),
			sampleFps: 3,
			observations: [],
			fallbacks: [],
		});
		try {
			const f = fixture();
			f.task.parameters.input.parameters.tracking = true;
			fixtureItem(f.authored.evidence.ledger.events[0]).subjects = [
				"unseen object",
			];
			f.authored.evidence.ledgerHash = hashEditingEvidence(
				f.authored.evidence.ledger,
			);
			f.authored.evidence.artifactHash = localStoryArtifactHash(
				f.authored.evidence,
			);
			f.refresh();
			await f.run();
			expect(track).not.toHaveBeenCalled();
			expect(
				document(f).clips.every((clip) =>
					clip.framing.every((part) => part.mode === "FIT"),
				),
			).toBe(true);
			expect(f.render).not.toHaveBeenCalled();
		} finally {
			track.mockRestore();
		}
	});
	it("publishes no project when translation of a later alternative fails", async () => {
		let calls = 0;
		const translator: LocalCaptionTranslator = {
			identity: localCaptionIdentityForConfiguration({
				profile: identity.profile,
				configId: identity.configId,
			} as Parameters<typeof localCaptionIdentityForConfiguration>[0]),
			translate: async (context) => {
				if (++calls === 2)
					throw Object.assign(new Error("LOCAL_CAPTION_TRANSLATION_INVALID"), {
						code: "LOCAL_CAPTION_TRANSLATION_INVALID",
					});
				return {
					document: {
						...context.document,
						captionDisplayLanguage: "ja",
						captions: context.document.captions?.map((c) => ({
							...c,
							translation: {
								targetLanguage: "ja",
								text: "こんにちは",
								sourceText: c.text,
								sourceTextHash: hashEditingEvidence(c.text),
								origin: "LOCAL_LLM",
								evidenceHash: "b".repeat(64),
							},
						})),
					},
					artifactHashes: ["b".repeat(64)],
					metrics: {},
				};
			},
		};
		const f = fixture({ captions: "JAPANESE", captionTranslator: translator });
		f.task.parameters.input.parameters.variants = 3;
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_TRANSLATION_INVALID",
		});
		expect(calls).toBe(2);
		expectNoPublication(f);
	});
	it("builds measured originals before translating, then publishes a Japanese draft without rendering", async () => {
		const translate = vi.fn<LocalCaptionTranslator["translate"]>(
			async (context) => ({
				document: {
					...context.document,
					captionDisplayLanguage: "ja",
					captions: context.document.captions?.map((c) => ({
						...c,
						translation: {
							targetLanguage: "ja",
							text: "こんにちは",
							sourceText: c.text,
							sourceTextHash: hashEditingEvidence(c.text),
							origin: "LOCAL_LLM",
							evidenceHash: "b".repeat(64),
						},
					})),
				},
				artifactHashes: ["b".repeat(64)],
				metrics: { captionTranslationMs: 3 },
			}),
		);
		const translator = {
			identity: localCaptionIdentityForConfiguration({
				profile: identity.profile,
				configId: identity.configId,
			} as Parameters<typeof localCaptionIdentityForConfiguration>[0]),
			translate,
		};
		const f = fixture({ captions: "JAPANESE", captionTranslator: translator });
		const result = await f.run();
		expect(translate.mock.calls[0]?.[0].document.captions?.[0]).toMatchObject({
			text: "Hello",
			fromFrame: 3,
			toFrame: 27,
		});
		expect(document(f)).toMatchObject({
			captionDisplayLanguage: "ja",
			captions: [
				{
					text: "Hello",
					translation: { text: "こんにちは", origin: "LOCAL_LLM" },
				},
			],
		});
		expect(result.captionTranslation).toMatchObject({
			model: translator.identity,
			captionCount: 1,
			artifactHashes: ["b".repeat(64)],
		});
		expect(f.render).not.toHaveBeenCalled();
	});
	it("rejects unavailable explicit Japanese translation before source planning or publication", async () => {
		const f = fixture({ captions: "JAPANESE" });
		await expect(f.run()).rejects.toMatchObject({
			code: "LOCAL_CAPTION_TRANSLATION_UNAVAILABLE",
		});
		expect(f.plan).not.toHaveBeenCalled();
		expectNoPublication(f);
	});
	it.each([
		false,
		true,
	])("publishes a reviewable draft without a draft policy marker (prepared=%s)", async (prepared) => {
		const f = fixture({ prepared });
		const result = await f.run();
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			actualFrames: 120,
			requestedFrames: 120,
			policyVersion: prepared
				? "aisa-prepared-local-story-window-v1"
				: "aisa-local-story-window-v1",
			localStoryEvidence: f.authored.evidence,
			metrics: { localStoryStagesExecuted: 2 },
		});
		expect(result.draftPolicyVersion).toBeUndefined();
		expect(result.selectionEvidence).toBeUndefined();
		expect(result.storyEvidence).toBeUndefined();
		expect(result.semanticEvidence).toBeUndefined();
		expect(document(f).autoGeneration).toMatchObject({
			renderMode: "DRAFT",
			localStoryEvidence: f.authored.evidence,
		});
		expect(document(f).autoGeneration?.normalizationReceiptHash).toBe(
			f.normalizationReceiptHash,
		);
		expect(
			document(f).clips.map((clip) => [clip.sourceInUs, clip.durationFrames]),
		).toEqual([
			[0, 60],
			[2_000_000, 60],
		]);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.projects[0]?.currentRevisionId).toBe(f.revisions[0]?.id);
		expect(f.plan.mock.calls[0]?.[0]).toMatchObject({
			hasAudio: true,
			sourcePath: f.context.sourcePath,
		});
		expect(
			f.plan.mock.calls[0]?.[0]?.preparedPartition?.normalizationReceiptHash,
		).toBe(f.normalizationReceiptHash);
		expect(f.render).not.toHaveBeenCalled();
		expect(f.derive).not.toHaveBeenCalled();
		await expect(
			createLibraryGenerationHandler({ prisma: f.prisma })(f.context),
		).resolves.toEqual(result);
		expect(f.plan).toHaveBeenCalledTimes(1);
	});
	it.each([
		"AUTO",
		"ORIGINAL",
		"OFF",
	] as const)("uses the engine transcript only for visible captions=%s", async (captions) => {
		const f = fixture({ captions });
		const result = await f.run();
		expect(f.plan).toHaveBeenCalledTimes(1);
		expect(result.selectionEvidence).toBeUndefined();
		expect(result.warnings).not.toContain("ASR_MODEL_NOT_CONFIGURED");
		expect((document(f).captions ?? []).map((caption) => caption.text)).toEqual(
			captions !== "OFF" ? ["Hello"] : [],
		);
		expect(document(f).clips.map((clip) => clip.sourceInUs)).toEqual([
			0, 2_000_000,
		]);
		expect(f.render).not.toHaveBeenCalled();
	});
	it("binds the generated timeline request to the model artifacts and selected beats", async () => {
		const f = fixture();
		await f.run();
		const targets = resolveLocalStorySubjects({
			analysis: f.analysis.document,
			input: buildLocalStoryInput({
				analysis: f.analysis.document,
				timeMap: f.media.timeMap,
				segments: f.authored.segments,
			}),
			ledger: f.authored.evidence.ledger,
			selection: f.authored.evidence.selection,
			geometry: {
				sourceWidth: f.binding.width,
				sourceHeight: f.binding.height,
				targetWidth: 1080,
				targetHeight: 1920,
			},
		});
		expect(document(f).autoGeneration?.requestHash).toBe(
			hashEditingEvidence({
				taskRequestHash: f.task.requestHash,
				generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
				subjectTargetsHash: hashEditingEvidence(targets),
				subjectProtectionHash: hashEditingEvidence([null, null]),
				presetId: "portrait-clean",
				mediaSha256: f.media.sha256,
				analysisDocumentHash: f.task.parameters.identity.analysisDocumentHash,
				bindingHash: hashEditingEvidence(f.binding),
				modelSha256: f.task.parameters.identity.modelSha256,
				localStoryArtifactHash: f.authored.evidence.artifactHash,
				localStorySelectionHash: hashEditingEvidence(
					f.authored.evidence.selection,
				),
			}),
		);
	});
	it("rejects an unavailable engine before publishing any project", async () => {
		const f = fixture();
		await expect(
			createLibraryGenerationHandler({ prisma: f.prisma })(f.context),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ENGINE_UNAVAILABLE" });
		expect(f.plan).not.toHaveBeenCalled();
		expectNoPublication(f);
	});
	it("rejects an unpinned local model identity before planning", async () => {
		const f = fixture();
		delete f.task.parameters.identity.localStoryModel;
		f.refresh();
		await expect(f.run()).rejects.toThrow();
		expect(f.plan).not.toHaveBeenCalled();
		expectNoPublication(f);
	});
	it.each([
		"profile",
		"configId",
		"modelDigest",
	] as const)("rejects a changed engine %s before planning", async (field) => {
		const f = fixture();
		f.engine.identity = {
			...identity,
			...(field === "profile" ? { profile: "amd" } : {}),
			...(field === "configId" ? { configId: randomUUID() } : {}),
			...(field === "modelDigest" ? { modelDigest: "e".repeat(64) } : {}),
		};
		await expect(f.run()).rejects.toMatchObject({
			code: "LOCAL_STORY_MODEL_CHANGED",
		});
		expect(f.plan).not.toHaveBeenCalled();
		expectNoPublication(f);
	});
	it("rejects an engine identity changed while planning", async () => {
		const f = fixture();
		f.plan.mockImplementationOnce(async () => {
			f.engine.identity = { ...identity, configId: randomUUID() };
			return structuredClone(f.authored);
		});
		await expect(f.run()).rejects.toMatchObject({
			code: "LOCAL_STORY_MODEL_CHANGED",
		});
		expectNoPublication(f);
	});
	it.each([
		"ledgerHash",
		"blueprintHash",
		"artifactHash",
		"model",
		"selection",
		"policy",
	] as const)("rejects invalid live engine evidence: %s", async (change) => {
		const f = fixture();
		if (change === "model") f.authored.evidence.model.configId = randomUUID();
		else if (change === "selection")
			f.authored.selection.localStorySelection.selectedEventIds = ["changed"];
		else if (change === "policy")
			f.authored.selection.policyVersion =
				"aisa-prepared-local-story-window-v1";
		else f.authored.evidence[change] = "e".repeat(64);
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expectNoPublication(f);
	});
	it.each([
		"ledgerHash",
		"blueprintHash",
		"artifactHash",
		"model",
		"missing",
		"policy",
	] as const)("rejects a forged completed replay: %s", async (change) => {
		const f = fixture();
		const result = await f.run();
		const altered = structuredClone(result);
		if (change === "missing") delete altered.localStoryEvidence;
		else if (change === "policy")
			altered.policyVersion = "aisa-content-highlight-v1";
		else if (altered.localStoryEvidence) {
			if (change === "model")
				altered.localStoryEvidence.model.configId = randomUUID();
			else altered.localStoryEvidence[change] = "e".repeat(64);
		}
		f.task.result = altered;
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expect(f.plan).toHaveBeenCalledTimes(1);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.render).not.toHaveBeenCalled();
	});
	it("verifies a completed race winner before accepting its result", async () => {
		const f = fixture();
		const valid = await f.run();
		const forged = structuredClone(valid);
		if (!forged.localStoryEvidence)
			throw new Error("Missing authored evidence");
		forged.localStoryEvidence.ledgerHash = "e".repeat(64);
		Object.assign(f.task, {
			state: "RUNNING",
			result: null,
			leaseToken: f.context.leaseToken,
			leaseUntil: new Date(Date.now() + 120_000),
		});
		const original = structuredClone(f.projects);
		f.plan.mockImplementationOnce(async () => {
			Object.assign(f.task, { state: "SUCCEEDED", result: forged });
			return structuredClone(f.authored);
		});
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expect(f.projects).toEqual(original);
		expect(f.revisions).toHaveLength(1);
		expect(f.render).not.toHaveBeenCalled();
	});
	it.each([
		"canceled",
		"leaseLost",
		"aborted",
	] as const)("does not publish after planning when %s", async (change) => {
		const f = fixture();
		const controller = new AbortController();
		f.context.signal = controller.signal;
		f.plan.mockImplementationOnce(async () => {
			if (change === "canceled")
				Object.assign(f.task, { cancelRequestedAt: new Date() });
			else if (change === "leaseLost") f.task.leaseToken = randomUUID();
			else controller.abort(new Error("Authored cancellation"));
			return structuredClone(f.authored);
		});
		await expect(f.run()).rejects.toThrow();
		expectNoPublication(f);
	});
	it("preserves an existing manually edited project when creating a new draft", async () => {
		const f = fixture();
		const manual = {
			id: randomUUID(),
			title: "Manual project",
			draft: { userEdits: ["retain"] },
			currentRevisionId: randomUUID(),
		};
		f.projects.push(structuredClone(manual));
		await f.run();
		expect(f.projects[0]).toEqual(manual);
		expect(f.projects).toHaveLength(2);
		expect(f.revisions).toHaveLength(1);
		expect(f.render).not.toHaveBeenCalled();
	});
	it("refuses to overwrite an occupied generated project ID", async () => {
		const f = fixture();
		const occupied = {
			id: generationObjectId(
				f.task.organizationId,
				f.task.id,
				"project:portrait-clean",
			),
			draft: { userEdits: ["retain"] },
			currentRevisionId: randomUUID(),
		};
		f.projects.push(structuredClone(occupied));
		await expect(f.run()).rejects.toMatchObject({
			code: "GENERATION_ID_CONFLICT",
		});
		expect(f.projects).toEqual([occupied]);
		expect(f.revisions).toEqual([]);
		expect(f.render).not.toHaveBeenCalled();
	});
});

it("omits unaligned automatic paragraphs instead of repeating their full text over VAD windows", async () => {
	const f = fixture({ captions: "ORIGINAL" });
	f.authored.segments = [
		{ startUs: 0, endUs: 4_000_000, text: "保存された原文" },
	];
	f.authored.speechIntervals = [{ startUs: 2_500_000, endUs: 3_000_000 }];
	const before = structuredClone(f.authored);
	const result = await f.run();
	const output = document(f);
	expect(output.captions).toEqual([]);
	expect(result.warnings).toContain("CAPTION_ALIGNMENT_UNAVAILABLE");
	expect(result.cacheable).toBe(false);
	expect(f.authored).toEqual(before);
	expect(result.generationPolicyFingerprint).toBe(
		GENERATION_POLICY_FINGERPRINT,
	);
	expect(f.render).not.toHaveBeenCalled();
});

function captionAlignmentStub() {
	return vi.fn<typeof alignSelectedCaptionSegments>(async (input) => {
		const segment = input.segments[0];
		if (!segment) throw new Error("Missing authored alignment input");
		const segments = [
			{
				...segment,
				startUs: 2_500_000,
				endUs: 3_000_000,
				words: [
					{
						text: segment.text,
						startChar: 0,
						endChar: segment.text.length,
						startUs: 2_500_000,
						endUs: 3_000_000,
						confidence: 0,
					},
				],
			},
		];
		const measurement = {
			timingSource: "MODEL_BASE" as const,
			windowIndex: 0,
			segmentIndex: 0,
			startChar: 0,
			endChar: segment.text.length,
			startUs: 2_500_000,
			endUs: 3_000_000,
		};
		return {
			segments,
			warnings: [],
			receipt: {
				version: CAPTION_ALIGNMENT_POLICY.version,
				engineVersion: CAPTION_ALIGNMENT_POLICY.engineVersion,
				modelRevision: CAPTION_ALIGNMENT_POLICY.modelRevision,
				confidence: "NOT_REPORTED" as const,
				modelManifestHash: CAPTION_ALIGNMENT_POLICY.modelManifestHash,
				mediaSha256: input.mediaSha256,
				inputHash: captionAlignmentInputHash(input),
				outputHash: hashEditingEvidence(segments),
				baseOutputHash: hashEditingEvidence(segments),
				sourceAudioUs: 4_000_000,
				modelLoadMs: 500,
				alignmentMs: 750,
				focusWindows: [],
				measurements: {
					base: [{ ...measurement }],
					focus: [],
					final: [{ ...measurement }],
				},
				windows: [
					{
						startUs: 0,
						endUs: 4_000_000,
						inputTextHash: hashEditingEvidence(segment.text),
						pcmSha256: "b".repeat(64),
					},
				],
			},
		};
	});
}

it("adds caption-only aligned times once while preserving the accepted story transcript and framing selection", async () => {
	const aligner = captionAlignmentStub();
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = "ja";
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	f.authored.speechIntervals = [
		{ startUs: 0, endUs: 320_000 },
		{ startUs: 2_500_000, endUs: 3_000_000 },
	];
	const before = structuredClone(f.authored);
	const result = await f.run();
	expect(aligner).toHaveBeenCalledTimes(1);
	expect(aligner.mock.calls[0]?.[0].language).toBe("ja");
	expect(f.authored).toEqual(before);
	expect(result.localStoryEvidence).toEqual(before.evidence);
	expect(
		document(f).captions?.map(({ text, fromFrame, toFrame }) => ({
			text,
			fromFrame,
			toFrame,
		})),
	).toEqual([{ text: "次のセリフ", fromFrame: 75, toFrame: 90 }]);
	expect(
		document(f).captions?.[0]?.sourceEvidence?.transcriptSegmentsHash,
	).toBe(hashEditingEvidence(aligner.mock.settledResults[0]?.value.segments));
	expect(result.captionAlignment?.outputHash).toBe(
		hashEditingEvidence(aligner.mock.settledResults[0]?.value.segments),
	);
	expect(result.metrics.captionAlignmentModelLoadMs).toBe(500);
	expect(result.metrics.captionAlignmentInferenceMs).toBe(750);
	expect(f.render).not.toHaveBeenCalled();
});

it("passes immutable raw timing evidence only to the caption aligner, without changing semantic input or cache identity", async () => {
	const aligner = vi
		.fn<typeof alignSelectedCaptionSegments>()
		.mockRejectedValue(
			new MediaOperationError("CAPTION_ALIGNMENT_UNAVAILABLE"),
		);
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = "ja";
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	f.authored.captionTimingEvidence = {
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		mediaSha256: f.media.sha256,
		modelSha256: "b".repeat(64),
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		transcriptHash: hashEditingEvidence({
			stored: "whole-transcript",
			segments: f.authored.segments,
		}),
		rawSegments: [],
		speechIntervals: [{ startUs: 2_500_000, endUs: 3_000_000 }],
	};
	const before = structuredClone(f.authored);
	const taskIdentity = structuredClone(f.task.parameters.identity);
	const result = await f.run();
	expect(aligner).toHaveBeenCalledTimes(1);
	expect(aligner.mock.calls[0]?.[0].captionTimingEvidence).toEqual(
		before.captionTimingEvidence,
	);
	expect(aligner.mock.calls[0]?.[0].captionTimingEvidence).not.toBe(
		f.authored.captionTimingEvidence,
	);
	expect(f.authored).toEqual(before);
	expect(f.task.parameters.identity).toEqual(taskIdentity);
	expect(result.localStoryEvidence).toEqual(before.evidence);
	expect(result).not.toHaveProperty("captionTimingEvidence");
	expect(document(f).autoGeneration).not.toHaveProperty(
		"captionTimingEvidence",
	);
	expect(f.render).not.toHaveBeenCalled();
});

it("does not invoke caption alignment or expose raw timing evidence when captions are OFF", async () => {
	const aligner = captionAlignmentStub();
	const f = fixture({ captions: "OFF", captionAligner: aligner });
	f.authored.captionTimingEvidence = {
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		mediaSha256: f.media.sha256,
		modelSha256: "b".repeat(64),
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		transcriptHash: "c".repeat(64),
		rawSegments: [],
		speechIntervals: [],
	};
	const before = structuredClone(f.authored.evidence);
	const result = await f.run();
	expect(aligner).not.toHaveBeenCalled();
	expect(result.localStoryEvidence).toEqual(before);
	expect(result).not.toHaveProperty("captionTimingEvidence");
	expect(document(f).captions).toEqual([]);
});

it.each([
	"qwen3-caption-alignment-v5",
	"qwen3-caption-alignment-v6",
])("does not admit historical %s alignment into a fresh current generation", async (version) => {
	const base = captionAlignmentStub();
	const aligner = vi.fn<typeof alignSelectedCaptionSegments>(async (input) => {
		const aligned = await base(input);
		Object.assign(aligned.receipt, { version });
		return aligned;
	});
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = "ja";
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	await expect(f.run()).rejects.toMatchObject({
		issues: expect.arrayContaining([
			expect.objectContaining({ path: ["version"] }),
		]),
	});
	expectNoPublication(f);
});

it("skips extra alignment when selected words already have measured timing", async () => {
	const aligner = captionAlignmentStub();
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	await f.run();
	expect(aligner).not.toHaveBeenCalled();
	expect(document(f).captions?.[0]?.text).toBe("Hello");
});

it("resolves selected observed language windows even without a full-source unanimous language", async () => {
	const aligner = captionAlignmentStub();
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = undefined;
	f.authored.transcriptLanguageWindows = [
		{
			startUs: f.media.timeMap.sourceStartUs,
			endUs: f.media.timeMap.sourceEndUs,
			language: "ja",
		},
	];
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	await f.run();
	expect(aligner).toHaveBeenCalledTimes(1);
	expect(aligner.mock.calls[0]?.[0].language).toBe("ja");
	expect(document(f).captions?.[0]?.text).toBe("次のセリフ");
});

it("does not override missing observed context with a global language fallback", async () => {
	const aligner = captionAlignmentStub();
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = "ja";
	f.authored.transcriptLanguageWindows = [];
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	const result = await f.run();
	expect(aligner).not.toHaveBeenCalled();
	expect(document(f).captions).toEqual([]);
	expect(result.cacheable).toBe(false);
});

it.each([
	"mediaSha256",
	"inputHash",
	"outputHash",
] as const)("rejects caption alignment with a mismatched %s before publishing a draft", async (field) => {
	const adapter = captionAlignmentStub();
	const aligner: typeof alignSelectedCaptionSegments = async (input) => {
		const result = await adapter(input);
		return {
			...result,
			receipt: { ...result.receipt, [field]: "f".repeat(64) },
		};
	};
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = "ja";
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	await expect(f.run()).rejects.toMatchObject({
		code: "CAPTION_ALIGNMENT_UNVERIFIED",
	});
	expectNoPublication(f);
});

it("rejects a final alignment trace changed by one microsecond before publishing a draft", async () => {
	const adapter = captionAlignmentStub();
	const aligner: typeof alignSelectedCaptionSegments = async (input) => {
		const result = await adapter(input);
		const measurement = result.receipt.measurements.final[0];
		if (!measurement) throw new Error("Missing authored final measurement");
		measurement.startUs += 1;
		return result;
	};
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = "ja";
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	await expect(f.run()).rejects.toMatchObject({
		code: "CAPTION_ALIGNMENT_UNVERIFIED",
	});
	expectNoPublication(f);
});

it("propagates cancellation during caption alignment without creating a captionless success", async () => {
	const aligner: typeof alignSelectedCaptionSegments = async () => {
		throw new DOMException("Canceled", "AbortError");
	};
	const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
	f.authored.transcriptLanguage = "ja";
	f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "次のセリフ" }];
	await expect(f.run()).rejects.toMatchObject({ name: "AbortError" });
	expectNoPublication(f);
});

describe("caption alignment omission diagnostics", () => {
	const sensitive =
		"synthetic-private-caption\n/never-log/source.mp4\nAuthorization: synthetic-private-token";
	afterEach(() => {
		vi.restoreAllMocks();
	});
	function failingAlignment(error: unknown, beforeThrow?: () => void) {
		const aligner = vi.fn<typeof alignSelectedCaptionSegments>(async () => {
			beforeThrow?.();
			throw error;
		});
		const f = fixture({ captions: "ORIGINAL", captionAligner: aligner });
		f.authored.transcriptLanguage = "ja";
		f.authored.segments = [{ startUs: 0, endUs: 4_000_000, text: "原文" }];
		return f;
	}

	it.each([
		"CAPTION_ALIGNMENT_UNAVAILABLE",
		"CAPTION_ALIGNMENT_LANGUAGE_UNSUPPORTED",
		"CAPTION_ALIGNMENT_TEXT_MISMATCH",
		"CAPTION_ALIGNMENT_TIMING_INVALID",
		"CAPTION_ALIGNMENT_LIMIT",
	])("records only the finite %s reason while preserving safe omission", async (errorCode) => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const f = failingAlignment(
			new MediaOperationError(errorCode, sensitive, sensitive),
		);
		const before = structuredClone(f.authored);
		const result = await f.run();
		expect(warning.mock.calls).toEqual([
			[
				JSON.stringify({
					event: "caption_alignment_omitted",
					taskId: f.task.id,
					entryPoint: "library_generation_worker",
					errorCode,
				}),
			],
		]);
		expect(JSON.stringify(warning.mock.calls)).not.toContain(
			"synthetic-private",
		);
		expect(document(f).captions).toEqual([]);
		expect(result.warnings).toContain("CAPTION_ALIGNMENT_UNAVAILABLE");
		expect(result.cacheable).toBe(false);
		expect(result.captionAlignment).toBeUndefined();
		expect(f.authored).toEqual(before);
	});

	it("reads a validated error code once even when a later getter read would expose private text", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const code = vi
			.fn()
			.mockReturnValueOnce("CAPTION_ALIGNMENT_TEXT_MISMATCH")
			.mockReturnValue(sensitive);
		const error = new MediaOperationError(
			"CAPTION_ALIGNMENT_TEXT_MISMATCH",
			sensitive,
		);
		Object.defineProperty(error, "code", { get: code });
		const f = failingAlignment(error);
		const result = await f.run();
		expect(code).toHaveBeenCalledTimes(1);
		expect(warning.mock.calls).toEqual([
			[
				JSON.stringify({
					event: "caption_alignment_omitted",
					taskId: f.task.id,
					entryPoint: "library_generation_worker",
					errorCode: "CAPTION_ALIGNMENT_TEXT_MISMATCH",
				}),
			],
		]);
		expect(result.cacheable).toBe(false);
	});

	it("does not turn a diagnostic sink failure into a different durable outcome", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {
			throw new Error(sensitive);
		});
		const f = failingAlignment(
			new MediaOperationError("CAPTION_ALIGNMENT_LIMIT", sensitive),
		);
		const result = await f.run();
		expect(warning).toHaveBeenCalledTimes(1);
		expect(result.warnings).toContain("CAPTION_ALIGNMENT_UNAVAILABLE");
		expect(result.cacheable).toBe(false);
		expect(document(f).captions).toEqual([]);
	});

	it("never reads an unknown error code getter or logs the unknown failure", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const code = vi.fn(() => {
			throw new Error(sensitive);
		});
		const error = new Error(sensitive);
		Object.defineProperty(error, "code", { get: code });
		const f = failingAlignment(error);
		await expect(f.run()).rejects.toBe(error);
		expect(code).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
		expectNoPublication(f);
	});

	it.each([
		"integrity",
		"cancellation",
	])("does not log or accept a %s failure as recoverable omission", async (kind) => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error =
			kind === "integrity"
				? new MediaOperationError("CAPTION_ALIGNMENT_UNVERIFIED", sensitive)
				: new DOMException(sensitive, "AbortError");
		const f = failingAlignment(error);
		await expect(f.run()).rejects.toBe(error);
		expect(warning).not.toHaveBeenCalled();
		expectNoPublication(f);
	});

	it("checks cancellation before reading or logging an otherwise recoverable error", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const controller = new AbortController();
		const reason = new MediaOperationError("CANCELED");
		const code = vi.fn(() => "CAPTION_ALIGNMENT_LIMIT");
		const error = new MediaOperationError("CAPTION_ALIGNMENT_LIMIT", sensitive);
		Object.defineProperty(error, "code", { get: code });
		const f = failingAlignment(error, () => controller.abort(reason));
		f.context.signal = controller.signal;
		await expect(f.run()).rejects.toBe(reason);
		expect(code).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
		expectNoPublication(f);
	});
});

it("changes only the GENERATE namespace for the new caption display policy", () => {
	const f = fixture({ captions: "ORIGINAL" });
	const previousGenerationPolicy =
		"3cb7431ddb13a44a90f1ee2dc80eb8f9582696b89c0b2bced9de3357cc25ffc7";
	expect(GENERATION_POLICY_FINGERPRINT).not.toBe(previousGenerationPolicy);
	expect(
		mediaTaskCacheKey(f.task.parameters.input, {
			...f.task.parameters.identity,
			generationPolicyFingerprint: previousGenerationPolicy,
		}),
	).not.toBe(f.task.cacheKey);
	expect(TRANSCRIPTION_POLICY_FINGERPRINT).toBe(
		"db89d5f6472018246893ab5143682bce27982898070aba68b459531adc40838f",
	);
	expect(f.task.parameters.identity.localStoryModel).toEqual(identity);
});
