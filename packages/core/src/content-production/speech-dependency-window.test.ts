import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import { verifyMediaTaskDependency } from "./dependencies";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import { mediaTaskEnvelopeSchema } from "./schema";

function fixture() {
	const id = randomUUID(),
		organizationId = randomUUID(),
		origin = 12_000_000;
	const map = {
		id,
		mediaVersionId: id,
		kind: "CFR",
		sourceStartUs: origin,
		sourceEndUs: origin + 10_000_000,
		editingStartFrame: 0,
		editingEndFrame: 300,
		fps: { num: 30, den: 1 },
	};
	const identity = {
		organizationId,
		mediaSha256: "a".repeat(64),
		modelSha256: "b".repeat(64),
		analysisDocumentHash: null,
		analysisRawHash: null,
		timeMapHash: hashEditingEvidence(map),
		bindingHash: null,
	};
	const current = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		identity,
		input: {
			kind: "GENERATE",
			mediaVersionId: id,
			analysisRevisionId: randomUUID(),
			requestKey: randomUUID(),
			parameters: {
				contentId: randomUUID(),
				targetDurationFrames: 60,
				captions: "AUTO",
				language: "ja",
			},
		},
	});
	const previous = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		identity,
		input: {
			kind: "TRANSCRIBE",
			mediaVersionId: id,
			requestKey: randomUUID(),
			parameters: {
				language: "ja",
				sourceStartUs: 2_000_000,
				durationUs: 2_000_000,
			},
		},
	});
	const row = {
		id: randomUUID(),
		organizationId,
		mediaVersionId: id,
		analysisRevisionId: null,
		kind: "TRANSCRIBE",
		state: "SUCCEEDED",
		requestKey: previous.input.requestKey,
		parentTaskId: null,
		requestHash: mediaTaskIntentHash(previous.input),
		cacheKey: mediaTaskCacheKey(previous.input, identity),
		parameters: previous,
		result: {
			schemaVersion: 1,
			engine: "whisper.cpp",
			engineVersion: "1.9.5",
			modelSha256: identity.modelSha256,
			mediaSha256: identity.mediaSha256,
			language: "ja",
			segments: [
				{
					startUs: origin + 2_100_000,
					endUs: origin + 2_900_000,
					text: "実測fixture",
				},
			],
			warnings: [],
			cacheKey: "c".repeat(64),
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		},
	};
	return {
		row,
		current,
		kind: "TRANSCRIBE" as const,
		timeMap: map,
		requiredClips: [
			{
				sceneId: randomUUID(),
				sourceInUs: origin + 2_000_000,
				durationFrames: 60,
			},
		],
	};
}

it("requires the full observed context even when the selected clip is already covered", () => {
	const f = fixture();
	expect(verifyMediaTaskDependency(f).kind).toBe("TRANSCRIBE");
	expect(() =>
		verifyMediaTaskDependency({
			...f,
			requiredTranscriptWindow: { fromFrame: 30, toFrame: 150 },
		}),
	).toThrowError(
		expect.objectContaining({ code: "TASK_DEPENDENCY_WINDOW_INCOMPLETE" }),
	);
});
it("accepts exact frame context coverage with a nonzero original origin", () => {
	expect(
		verifyMediaTaskDependency({
			...fixture(),
			requiredTranscriptWindow: { fromFrame: 60, toFrame: 120 },
		}).kind,
	).toBe("TRANSCRIBE");
});
it.each([
	{ fromFrame: -1, toFrame: 120 },
	{ fromFrame: 60.5, toFrame: 120 },
	{ fromFrame: 60, toFrame: 60 },
	{ fromFrame: 60, toFrame: 301 },
	{ fromFrame: 0, toFrame: 5401 },
])("does not treat invalid context as an optional ignored hint %j", (requiredTranscriptWindow) => {
	expect(() =>
		verifyMediaTaskDependency({ ...fixture(), requiredTranscriptWindow }),
	).toThrowError(expect.objectContaining({ code: "TASK_DEPENDENCY_INVALID" }));
});
