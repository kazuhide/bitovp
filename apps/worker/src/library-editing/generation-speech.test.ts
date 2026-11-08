import {
	compositionDocumentSchema,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLibraryGenerationHandler } from "./generation";
import { generationDependencyFixture } from "./generation-dependency-fixture";
import { MediaOperationError } from "./process";

const inference = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock("./transcription", async (original) => ({
	...(await original<object>()),
	transcribeLocalAudio: inference.transcribe,
}));
afterEach(() => inference.transcribe.mockReset());

function fixture(originUs = 0) {
	const f = generationDependencyFixture("TRANSCRIBE"),
		map = f.media.timeMap;
	map.sourceStartUs = originUs;
	map.sourceEndUs = originUs + 6_000_000;
	f.analysis.document = normalizeSceneAnalysis({
		metadata: { version: "authored-speech-regression" },
		duration: originUs / 1_000_000 + 6,
		scenes: [
			{
				id: f.sceneIds[0],
				type: "MAIN_CONTENT",
				title: "Speech fixture",
				startInSeconds: originUs / 1_000_000,
				endInSeconds: originUs / 1_000_000 + 6,
				shots: [
					[0, 1],
					[1, 3],
					[3, 4],
					[4, 6],
				].map(([from = 0, to = 0]) => ({
					startInSeconds: originUs / 1_000_000 + from,
					endInSeconds: originUs / 1_000_000 + to,
					mainSubjects: [],
				})),
			},
		],
	});
	Object.assign(f.binding, {
		sourceStartUs: originUs,
		sourceEndUs: map.sourceEndUs,
		timeMapHash: hashEditingEvidence(map),
		analysisDocumentHash: hashEditingEvidence(f.analysis.document),
	});
	Object.assign(f.task.parameters.identity, {
		timeMapHash: f.binding.timeMapHash,
		bindingHash: hashEditingEvidence(f.binding),
		analysisDocumentHash: f.binding.analysisDocumentHash,
		speechSelectionPolicyVersion: "asr-boundary-v1",
	});
	f.dependency.parameters.identity.timeMapHash = f.binding.timeMapHash;
	f.dependency.result.segments = [
		{ startUs: originUs, endUs: originUs + 500_000, text: "outside" },
		{
			startUs: originUs + 1_500_000,
			endUs: originUs + 2_000_000,
			text: "inside",
			words: [
				{
					text: "inside",
					startUs: originUs + 1_500_000,
					endUs: originUs + 2_000_000,
					startChar: 0,
					endChar: 6,
					confidence: 0.9,
				},
			],
		},
		{
			startUs: originUs + 3_500_000,
			endUs: originUs + 4_500_000,
			text: "crosses initial end",
		},
	];
	f.refresh();
	const refreshCurrent = () => {
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
	};
	refreshCurrent();
	const fresh = () => {
		delete f.task.parameters.input.parameters.transcriptionTaskId;
		refreshCurrent();
	};
	return { ...f, fresh, refreshCurrent };
}
function transcript() {
	return {
		schemaVersion: 1,
		engine: "whisper.cpp",
		engineVersion: "1.9.5",
		modelSha256: "b".repeat(64),
		mediaSha256: "a".repeat(64),
		language: "ja",
		segments: [
			{ startUs: 0, endUs: 500_000, text: "outside" },
			{
				startUs: 1_500_000,
				endUs: 2_000_000,
				text: "inside",
				words: [
					{
						text: "inside",
						startUs: 1_500_000,
						endUs: 2_000_000,
						startChar: 0,
						endChar: 6,
						confidence: 0.9,
					},
				],
			},
			{ startUs: 3_500_000, endUs: 4_500_000, text: "crosses initial end" },
		],
		warnings: [],
		cacheKey: "c".repeat(64),
	};
}

describe("generation observes speech before final whole-shot selection", () => {
	it("chooses a shorter fully observed window and keeps real captions from its existing transcript", async () => {
		const f = fixture(),
			result = await f.run();
		expect(f.dependency.parameters.input).toHaveProperty(
			"parameters.durationUs",
			6_000_000,
		);
		expect(result).toMatchObject({
			requestedFrames: 120,
			actualFrames: 60,
			selectionEvidence: {
				status: "APPLIED",
				observedWindow: { fromFrame: 0, toFrame: 180 },
				modelSha256: "b".repeat(64),
			},
		});
		expect(f.projects[0]).toHaveProperty("draft.clips.0.sourceInUs", 1_000_000);
		expect(f.projects[0]).toHaveProperty("draft.captions.0.text", "inside");
		const document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(document.captions).toHaveLength(1);
		expect(document.captions?.[0]).toMatchObject({
			fromFrame: 15,
			toFrame: 30,
			text: "inside",
		});
		expect(inference.transcribe).not.toHaveBeenCalled();
	});
	it("runs ASR once on bounded outside context, shifts its origin once and reuses it for final captions", async () => {
		const f = fixture(12_000_000);
		f.fresh();
		inference.transcribe.mockResolvedValue(transcript());
		const result = await createLibraryGenerationHandler({
			prisma: f.prisma,
			model: { path: "/owned/model.bin", sha256: "b".repeat(64) },
		})(f.context);
		expect(inference.transcribe).toHaveBeenCalledTimes(1);
		expect(inference.transcribe).toHaveBeenCalledWith(
			expect.objectContaining({ sourceStartUs: 0, durationUs: 6_000_000 }),
		);
		expect(result.actualFrames).toBe(60);
		expect(result.selectionEvidence?.intervals).toEqual([
			{ startUs: 12_000_000, endUs: 12_500_000 },
			{ startUs: 13_500_000, endUs: 14_000_000 },
			{ startUs: 15_500_000, endUs: 16_500_000 },
		]);
		expect(f.projects[0]).toHaveProperty(
			"draft.clips.0.sourceInUs",
			13_000_000,
		);
		expect(f.projects[0]).toHaveProperty("draft.captions.0.fromFrame", 15);
		expect(f.context.onProgress).toHaveBeenCalledWith("REFINING_SELECTION");
	});
	it("fails a context-incomplete explicit transcript instead of ignoring it or running fresh ASR", async () => {
		const f = fixture();
		if (f.dependency.parameters.input.kind !== "TRANSCRIBE")
			throw new Error("Expected transcript");
		f.dependency.parameters.input.parameters.durationUs = 4_000_000;
		f.dependency.result.segments = [
			{ startUs: 0, endUs: 500_000, text: "inside partial context" },
		];
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_DEPENDENCY_WINDOW_INCOMPLETE",
		});
		expect(inference.transcribe).not.toHaveBeenCalled();
		expect(f.projects).toHaveLength(0);
	});
	it("does not call a context-edge fallback applied or knowingly retain an unsafe boundary", async () => {
		const f = fixture();
		f.task.parameters.input.parameters.targetDurationFrames = 180;
		f.refreshCurrent();
		f.dependency.result.segments = [
			{ startUs: 1_000_000, endUs: 1_500_000, text: "inside" },
		];
		const result = await f.run();
		expect(result).toMatchObject({
			actualFrames: 180,
			selectionEvidence: {
				status: "FALLBACK",
				reason: "BOUNDARY_COVERAGE_UNKNOWN",
			},
		});
		expect(result.warnings).toContain("SPEECH_SELECTION_FALLBACK");
	});
	it("returns a typed failure when every whole-shot window crosses measured speech", async () => {
		const f = fixture();
		f.dependency.result.segments = [
			{ startUs: 500_000, endUs: 5_500_000, text: "continuous fixture" },
		];
		await expect(f.run()).rejects.toMatchObject({
			code: "NO_SPEECH_SAFE_WINDOW",
		});
		expect(f.projects).toHaveLength(0);
		expect(f.runs).toHaveLength(0);
	});
	it("warns honestly when no model is configured without inventing observed evidence", async () => {
		const f = fixture();
		f.fresh();
		const result = await f.run();
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				"ASR_MODEL_NOT_CONFIGURED",
				"SPEECH_SELECTION_FALLBACK",
			]),
		);
		expect(result).toMatchObject({
			actualFrames: 120,
			cacheable: false,
			selectionEvidence: {
				status: "FALLBACK",
				reason: "ASR_UNAVAILABLE",
				modelSha256: null,
			},
		});
		expect(result.selectionEvidence).not.toHaveProperty("observedWindow");
		expect(inference.transcribe).not.toHaveBeenCalled();
	});
	it("does not turn changed model evidence into a successful generic ASR fallback", async () => {
		const f = fixture();
		f.fresh();
		inference.transcribe.mockRejectedValue(
			new MediaOperationError("MODEL_HASH_MISMATCH"),
		);
		await expect(
			createLibraryGenerationHandler({
				prisma: f.prisma,
				model: { path: "/owned/model.bin", sha256: "b".repeat(64) },
			})(f.context),
		).rejects.toMatchObject({ code: "MODEL_HASH_MISMATCH" });
		expect(f.projects).toHaveLength(0);
	});
	it("keeps a measured NO_SPEECH result as fallback without inventing continuous speech", async () => {
		const f = fixture();
		f.fresh();
		inference.transcribe.mockResolvedValue({
			...transcript(),
			segments: [],
			warnings: ["NO_SPEECH"],
		});
		const result = await createLibraryGenerationHandler({
			prisma: f.prisma,
			model: { path: "/owned/model.bin", sha256: "b".repeat(64) },
		})(f.context);
		expect(result.selectionEvidence).toMatchObject({
			status: "FALLBACK",
			reason: "NO_SPEECH",
			intervals: [],
			observedWindow: { fromFrame: 0, toFrame: 180 },
		});
		expect(result.warnings).toEqual(
			expect.arrayContaining(["NO_SPEECH", "SPEECH_SELECTION_FALLBACK"]),
		);
	});
	it("does not swallow the typed measured-evidence limit as generic ASR fallback", async () => {
		const f = fixture();
		f.fresh();
		inference.transcribe.mockResolvedValue({
			...transcript(),
			segments: Array.from({ length: 5001 }, (_, i) => ({
				startUs: i * 1000,
				endUs: i * 1000 + 1000,
				text: "fixture",
			})),
		});
		await expect(
			createLibraryGenerationHandler({
				prisma: f.prisma,
				model: { path: "/owned/model.bin", sha256: "b".repeat(64) },
			})(f.context),
		).rejects.toMatchObject({ code: "SPEECH_EVIDENCE_LIMIT" });
		expect(f.projects).toHaveLength(0);
	});
	it("honors cancellation after pre-selection ASR before constructing or publishing output", async () => {
		const f = fixture();
		f.fresh();
		const controller = new AbortController();
		inference.transcribe.mockImplementation(async () => {
			controller.abort(new MediaOperationError("CANCELED"));
			return transcript();
		});
		await expect(
			createLibraryGenerationHandler({
				prisma: f.prisma,
				model: { path: "/owned/model.bin", sha256: "b".repeat(64) },
			})({ ...f.context, signal: controller.signal }),
		).rejects.toMatchObject({ code: "CANCELED" });
		expect(f.projects).toHaveLength(0);
		expect(f.runs).toHaveLength(0);
	});
});
