import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editingAnalysisBindingSchema } from "../content-editing/automatic-binding";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	type DependencySourceClip,
	verifyMediaTaskDependency,
} from "./dependencies";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import {
	LOCAL_ASR_ENGINE_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	mediaTaskEnvelopeSchema,
} from "./schema";
import { TRANSCRIPTION_POLICY_FINGERPRINT } from "./transcription-quality";

function fixture(kind: "TRANSCRIBE" | "TRACK" = "TRANSCRIBE", originUs = 0) {
	const organizationId = randomUUID(),
		mediaId = randomUUID(),
		sourceId = randomUUID(),
		analysisId = randomUUID(),
		sceneIds = [randomUUID(), randomUUID()] as const;
	const map = {
		id: mediaId,
		mediaVersionId: mediaId,
		kind: "CFR",
		sourceStartUs: originUs,
		sourceEndUs: originUs + 10_000_000,
		editingStartFrame: 0,
		editingEndFrame: 300,
		fps: { num: 30, den: 1 },
	};
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-pure-dependency-contract" },
		duration: originUs / 1_000_000 + 10,
		scenes: [0, 4].map((start, index) => ({
			id: sceneIds[index],
			type: "MAIN_CONTENT",
			title: "Fixture",
			startInSeconds: originUs / 1_000_000 + start,
			endInSeconds: originUs / 1_000_000 + start + 4,
			shots: [
				{
					startInSeconds: originUs / 1_000_000 + start,
					endInSeconds: originUs / 1_000_000 + start + 4,
					mainSubjects: [],
				},
			],
		})),
	});
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId,
		locale: "ja",
		analysisRevisionId: analysisId,
		analysisRawHash: hashEditingEvidence({
			fixture: "authored-pure-dependency-contract",
		}),
		analysisDocumentHash: hashEditingEvidence(analysis),
		mediaVersionId: mediaId,
		mediaSha256: "a".repeat(64),
		timeMapId: mediaId,
		timeMapHash: hashEditingEvidence(map),
		sourceStartUs: originUs,
		sourceEndUs: map.sourceEndUs,
		width: 640,
		height: 360,
	});
	const shared = {
		organizationId,
		mediaSha256: binding.mediaSha256,
		modelSha256: kind === "TRANSCRIBE" ? "b".repeat(64) : null,
		analysisDocumentHash: binding.analysisDocumentHash,
		analysisRawHash: binding.analysisRawHash,
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
	const current = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		identity: shared,
		input: {
			kind: "GENERATE",
			mediaVersionId: mediaId,
			analysisRevisionId: analysisId,
			requestKey: randomUUID(),
			parameters: {
				contentId: randomUUID(),
				targetDurationFrames: 120,
				captions: kind === "TRANSCRIBE" ? "AUTO" : "OFF",
				tracking: kind === "TRACK",
				language: "ja",
			},
		},
	});
	const previous = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		identity:
			kind === "TRACK"
				? shared
				: {
						...shared,
						analysisDocumentHash: null,
						analysisRawHash: null,
						bindingHash: null,
						bindingSnapshot: undefined,
					},
		input: {
			kind,
			mediaVersionId: mediaId,
			...(kind === "TRACK" ? { analysisRevisionId: analysisId } : {}),
			requestKey: randomUUID(),
			parameters:
				kind === "TRANSCRIBE"
					? { language: "ja", sourceStartUs: 0, durationUs: 10_000_000 }
					: {},
		},
	});
	const result: Record<string, unknown> =
		kind === "TRANSCRIBE"
			? {
					schemaVersion: 1,
					engine: "whisper.cpp",
					engineVersion: LOCAL_ASR_ENGINE_VERSION,
					modelSha256: "b".repeat(64),
					mediaSha256: binding.mediaSha256,
					language: "ja",
					segments: [
						{
							startUs: originUs,
							endUs: originUs + 1_000_000,
							text: "実測テスト",
						},
					],
					warnings: [],
					cacheKey: "c".repeat(64),
					sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				}
			: {
					schemaVersion: 1,
					algorithm: LOCAL_TRACKING_ALGORITHM_VERSION,
					frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
					mediaSha256: binding.mediaSha256,
					cacheKey: "c".repeat(64),
					sampleFps: 3,
					observations: [],
					fallbacks: [
						{
							sceneId: sceneIds[0],
							shotIndex: 0,
							fromUs: originUs,
							toUs: originUs + 4_000_000,
							reason: "NO_SEED",
						},
					],
					bindingKind: "FIXTURE_AUTHORED",
					sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				};
	const row = {
		id: randomUUID(),
		organizationId,
		mediaVersionId: mediaId,
		analysisRevisionId: kind === "TRACK" ? analysisId : null,
		kind,
		state: "SUCCEEDED",
		requestKey: previous.input.requestKey,
		requestHash: mediaTaskIntentHash(previous.input),
		cacheKey: mediaTaskCacheKey(previous.input, previous.identity),
		parentTaskId: null,
		parameters: previous,
		result,
	};
	const clips: [DependencySourceClip] = [
		{
			sceneId: sceneIds[0] ?? "",
			shotIndex: 0,
			sourceInUs: originUs,
			durationFrames: 120,
		},
	];
	const refresh = () => {
		row.requestHash = mediaTaskIntentHash(previous.input);
		row.cacheKey = mediaTaskCacheKey(previous.input, previous.identity);
	};
	const rehashAnalysis = () => {
		binding.analysisDocumentHash = hashEditingEvidence(analysis);
		for (const identity of [previous.identity, current.identity]) {
			identity.analysisDocumentHash = binding.analysisDocumentHash;
			identity.bindingSnapshot = binding;
			identity.bindingHash = hashEditingEvidence(binding);
		}
		refresh();
	};
	return {
		row,
		previous,
		current,
		result,
		map,
		analysis,
		clips,
		sceneIds,
		refresh,
		rehashAnalysis,
		run: () =>
			verifyMediaTaskDependency({
				row,
				kind,
				current,
				timeMap: map,
				analysisDocument: analysis,
				requiredClips: clips,
			}),
	};
}

describe("explicit production dependency contracts", () => {
	it.each([
		"raw",
		"vad",
	])("rejects %s evidence left on the media clock instead of the pinned original clock", (kind) => {
		const f = fixture("TRANSCRIBE", 42_000_000);
		for (const identity of [f.current.identity, f.previous.identity])
			identity.transcriptionPolicyFingerprint =
				TRANSCRIPTION_POLICY_FINGERPRINT;
		Object.assign(f.result, {
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			rawSegments: [
				{
					startUs: kind === "raw" ? 0 : 42_000_000,
					endUs: 43_000_000,
					text: "実測テスト",
					quality: {
						noSpeechProbability: 0.01,
						meanTokenLogProbability: -0.1,
						speechOverlapUs: 1_000_000,
						decision: "ADMITTED",
					},
				},
			],
			speechIntervals: [
				{ startUs: kind === "vad" ? 0 : 42_000_000, endUs: 43_000_000 },
			],
		});
		f.refresh();
		expect(f.run).toThrow("TASK_RESULT_UNVERIFIED");
	});
	it("does not reuse a fingerprintless legacy transcript for a new VAD quality intent", () => {
		const f = fixture();
		f.current.identity.transcriptionPolicyFingerprint =
			TRANSCRIPTION_POLICY_FINGERPRINT;
		expect(f.run).toThrow("TASK_DEPENDENCY_INVALID");
	});
	it("checks both producer and result quality policy while retaining measured raw recognition", () => {
		const f = fixture();
		for (const identity of [f.current.identity, f.previous.identity])
			identity.transcriptionPolicyFingerprint =
				TRANSCRIPTION_POLICY_FINGERPRINT;
		Object.assign(f.result, {
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			speechIntervals: [{ startUs: 0, endUs: 1_000_000 }],
			rawSegments: [
				{
					startUs: 0,
					endUs: 1_000_000,
					text: "実測テスト",
					quality: {
						noSpeechProbability: 0.01,
						meanTokenLogProbability: -0.1,
						speechOverlapUs: 1_000_000,
						decision: "ADMITTED",
					},
				},
			],
		});
		f.refresh();
		expect(f.run().kind).toBe("TRANSCRIBE");
		f.result.qualityPolicyFingerprint = "f".repeat(64);
		expect(f.run).toThrow("TASK_RESULT_UNVERIFIED");
	});
	it("retains a verified silent window without inventing caption coverage from text", () => {
		const f = fixture();
		f.result.segments = [];
		f.result.warnings = ["NO_SPEECH"];
		expect(f.run()).toMatchObject({
			kind: "TRANSCRIBE",
			result: { segments: [], warnings: ["NO_SPEECH"] },
		});
	});
	it.each([
		[
			"foreign row tenant",
			(f: ReturnType<typeof fixture>) => {
				f.row.organizationId = randomUUID();
			},
		],
		[
			"foreign envelope tenant",
			(f: ReturnType<typeof fixture>) => {
				f.previous.identity.organizationId = randomUUID();
				f.refresh();
			},
		],
		[
			"different media version",
			(f: ReturnType<typeof fixture>) => {
				f.row.mediaVersionId = randomUUID();
			},
		],
		[
			"different media hash",
			(f: ReturnType<typeof fixture>) => {
				f.previous.identity.mediaSha256 = "d".repeat(64);
				f.refresh();
			},
		],
		[
			"different map hash",
			(f: ReturnType<typeof fixture>) => {
				f.previous.identity.timeMapHash = "d".repeat(64);
				f.refresh();
			},
		],
		[
			"unresolved preparation identity",
			(f: ReturnType<typeof fixture>) => {
				f.previous.identity.timeMapHash = null;
				f.previous.identity.mediaSha256 = null;
				f.refresh();
			},
		],
		[
			"altered request hash",
			(f: ReturnType<typeof fixture>) => {
				f.row.requestHash = "d".repeat(64);
			},
		],
		[
			"altered cache hash",
			(f: ReturnType<typeof fixture>) => {
				f.row.cacheKey = "d".repeat(64);
			},
		],
	] as const)("rejects %s", (_, change) => {
		const f = fixture();
		change(f);
		expect(f.run).toThrow("TASK_DEPENDENCY_INVALID");
	});
	it.each([
		["media digest", { mediaSha256: "e".repeat(64) }],
		["model digest", { modelSha256: "e".repeat(64) }],
		["engine version", { engineVersion: "0.0.0" }],
		["time domain", { sourceTimeDomain: "PREPARED_US" }],
		[
			"word offsets",
			{
				segments: [
					{
						startUs: 0,
						endUs: 1_000_000,
						text: "hello",
						words: [
							{
								text: "wrong",
								startUs: 0,
								endUs: 100_000,
								startChar: 0,
								endChar: 5,
								confidence: 1,
							},
						],
					},
				],
			},
		],
		[
			"inference range",
			{ segments: [{ startUs: 0, endUs: 10_000_001, text: "outside" }] },
		],
	] as const)("rejects a transcript result with invalid %s", (_, change) => {
		const f = fixture();
		Object.assign(f.result, change);
		expect(f.run).toThrow("TASK_RESULT_UNVERIFIED");
	});
	it("requires the actual inference window to cover both selected endpoints", () => {
		const f = fixture();
		if (f.previous.input.kind !== "TRANSCRIBE") throw new Error("Expected ASR");
		f.previous.input.parameters.sourceStartUs = 1_000_000;
		f.previous.input.parameters.durationUs = 2_000_000;
		f.result.segments = [
			{ startUs: 1_000_000, endUs: 2_000_000, text: "inside" },
		];
		f.refresh();
		expect(f.run).toThrow("TASK_DEPENDENCY_WINDOW_INCOMPLETE");
		f.clips[0] = { ...f.clips[0], sourceInUs: 1_000_000, durationFrames: 60 };
		expect(f.run().kind).toBe("TRANSCRIBE");
		f.clips[0].durationFrames = 61;
		expect(f.run).toThrow("TASK_DEPENDENCY_WINDOW_INCOMPLETE");
	});
	it("rejects tracking from a different analysis, raw snapshot or binding", () => {
		for (const field of [
			"analysisDocumentHash",
			"analysisRawHash",
			"bindingHash",
		] as const) {
			const f = fixture("TRACK");
			f.previous.identity[field] = "e".repeat(64);
			f.refresh();
			expect(f.run).toThrow("TASK_DEPENDENCY_INVALID");
		}
		const f = fixture("TRACK");
		f.row.analysisRevisionId = randomUUID();
		expect(f.run).toThrow("TASK_DEPENDENCY_INVALID");
	});
	it("refuses a valid but different selected scene as tracking coverage", () => {
		const f = fixture("TRACK");
		if (f.previous.input.kind !== "TRACK") throw new Error("Expected tracking");
		f.previous.input.parameters.sceneIds = [f.sceneIds[1]];
		f.result.fallbacks = [
			{
				sceneId: f.sceneIds[1],
				shotIndex: 0,
				fromUs: 4_000_000,
				toUs: 8_000_000,
				reason: "NO_SEED",
			},
		];
		f.refresh();
		expect(f.run).toThrow("TASK_DEPENDENCY_WINDOW_INCOMPLETE");
	});
	it.each([
		0, 42_000_000,
	])("retains exact frame164 raw precision at original origin %i", (originUs) => {
		const f = fixture("TRACK", originUs),
			scene = f.analysis.scenes[0];
		if (!scene) throw new Error("Missing authored scene");
		const shot = scene.shots[0];
		if (!shot) throw new Error("Missing authored shot");
		scene.startInSeconds = shot.startInSeconds =
			originUs / 1_000_000 + 164 / 30;
		scene.endInSeconds = shot.endInSeconds = originUs / 1_000_000 + 194 / 30;
		const startUs = originUs + Number((164n * 1_000_000n + 29n) / 30n),
			endUs = originUs + Number((194n * 1_000_000n + 29n) / 30n);
		f.clips[0] = {
			sceneId: scene.id,
			shotIndex: 0,
			sourceInUs: startUs,
			durationFrames: 30,
		};
		f.result.fallbacks = [
			{
				sceneId: scene.id,
				shotIndex: 0,
				fromUs: startUs,
				toUs: endUs,
				reason: "NO_SEED",
			},
		];
		f.rehashAnalysis();
		expect(f.run().kind).toBe("TRACK");
		shot.startInSeconds += 1e-8;
		f.result.fallbacks = [];
		f.rehashAnalysis();
		expect(f.run).toThrow("TASK_DEPENDENCY_WINDOW_INCOMPLETE");
	});
});
