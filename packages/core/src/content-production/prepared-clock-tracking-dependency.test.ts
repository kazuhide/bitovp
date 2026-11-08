import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editingAnalysisBindingSchema } from "../content-editing/automatic-binding";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { verifyMediaTaskDependency } from "./dependencies";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import {
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	mediaTaskEnvelopeSchema,
} from "./schema";

function legacyTracking() {
	const organizationId = randomUUID(),
		mediaVersionId = randomUUID(),
		sourceId = randomUUID(),
		analysisRevisionId = randomUUID(),
		sceneId = randomUUID();
	const timeMap = {
		id: mediaVersionId,
		mediaVersionId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-legacy-track-range-regression" },
		duration: 2,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [
					{ startInSeconds: 0, endInSeconds: 5 / 24 },
					{ startInSeconds: 5 / 24, endInSeconds: 2 },
				],
			},
		],
	});
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId,
		locale: "en",
		analysisRevisionId,
		analysisRawHash: hashEditingEvidence({ fixture: "legacy TRACK range" }),
		analysisDocumentHash: hashEditingEvidence(analysis),
		mediaVersionId,
		mediaSha256: "a".repeat(64),
		timeMapId: mediaVersionId,
		timeMapHash: hashEditingEvidence(timeMap),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 640,
		height: 360,
	});
	const identity = {
		organizationId,
		mediaSha256: binding.mediaSha256,
		modelSha256: null,
		analysisDocumentHash: binding.analysisDocumentHash,
		analysisRawHash: binding.analysisRawHash,
		timeMapHash: binding.timeMapHash,
		bindingHash: hashEditingEvidence(binding),
		bindingSnapshot: binding,
		trackingAlgorithmVersion: LOCAL_TRACKING_ALGORITHM_VERSION,
		trackingFrameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	};
	const previous = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		identity,
		input: {
			kind: "TRACK",
			mediaVersionId,
			analysisRevisionId,
			requestKey: randomUUID(),
			parameters: {},
		},
	});
	const current = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		identity,
		input: {
			kind: "GENERATE",
			mediaVersionId,
			analysisRevisionId,
			requestKey: randomUUID(),
			parameters: {
				contentId: randomUUID(),
				targetDurationFrames: 30,
				captions: "OFF",
				tracking: true,
			},
		},
	});
	const row = {
		id: randomUUID(),
		organizationId,
		mediaVersionId,
		analysisRevisionId,
		kind: "TRACK",
		state: "SUCCEEDED",
		requestKey: previous.input.requestKey,
		requestHash: mediaTaskIntentHash(previous.input),
		cacheKey: mediaTaskCacheKey(previous.input, previous.identity),
		parentTaskId: null,
		parameters: previous,
		result: {
			schemaVersion: 1,
			algorithm: LOCAL_TRACKING_ALGORITHM_VERSION,
			frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
			mediaSha256: binding.mediaSha256,
			cacheKey: "c".repeat(64),
			sampleFps: 3,
			observations: [],
			fallbacks: [
				{
					sceneId,
					shotIndex: 0,
					fromUs: 0,
					toUs: 200_000,
					reason: "NO_SEED",
				},
			],
			bindingKind: "FIXTURE_AUTHORED",
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		},
	};
	const run = (durationFrames: number) =>
		verifyMediaTaskDependency({
			row,
			kind: "TRACK",
			current,
			timeMap,
			analysisDocument: analysis,
			requiredClips: [{ sceneId, shotIndex: 0, sourceInUs: 0, durationFrames }],
		});
	return { run, row };
}

describe("prepared clock never widens a legacy standalone TRACK receipt", () => {
	it("retains the old whole-shot interior ending at floor(5/24*30)=6", () => {
		const fixture = legacyTracking();
		expect(fixture.run(6).kind).toBe("TRACK");
	});
	it("rejects the seventh frame even if a new partition can own that source pixel", () => {
		const fixture = legacyTracking();
		expect(() => fixture.run(7)).toThrow("TASK_DEPENDENCY_WINDOW_INCOMPLETE");
	});
	it("does not turn an extended old fallback into new-clock coverage", () => {
		const fixture = legacyTracking();
		const fallback = fixture.row.result.fallbacks[0];
		if (!fallback) throw new Error("Missing legacy fallback fixture");
		fallback.toUs = 233_334;
		expect(() => fixture.run(7)).toThrow("TASK_RESULT_UNVERIFIED");
	});
});
