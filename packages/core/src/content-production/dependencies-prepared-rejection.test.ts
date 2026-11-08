import { describe, expect, it } from "vitest";
import { editingAnalysisBindingSchema } from "../content-editing/automatic-binding";
import {
	buildPreparedShotPartition,
	getPreparedShotPartitionEntry,
} from "../content-editing/prepared-shot-partition";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { authoredNormalizationReceipt } from "../testing/normalization-clock";
import { verifyMediaTaskDependency } from "./dependencies";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import {
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	mediaTaskEnvelopeSchema,
} from "./schema";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const us = (frame: number) => Number((BigInt(frame) * 1_000_000n + 29n) / 30n);
function fixture() {
	const organizationId = id(1),
		sourceId = id(2),
		mediaVersionId = id(3),
		sceneId = id(4),
		analysisRevisionId = id(5);
	const proof = authoredNormalizationReceipt({
		organizationId,
		sourceId,
		mediaVersionId,
		sourceFrameCount: 48,
	});
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
		metadata: { version: "authored-offgrid-track-dependency-regression" },
		duration: 2,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [
					{ startInSeconds: 0, endInSeconds: 0.1 },
					{ startInSeconds: 0.1, endInSeconds: 1 },
				],
			},
		],
	});
	const partition = buildPreparedShotPartition({
		analysis,
		timeMap,
		normalization: proof,
	});
	const entry = getPreparedShotPartitionEntry(partition, {
		sceneId,
		shotIndex: 1,
	});
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId,
		locale: "en",
		analysisRevisionId,
		analysisRawHash: hashEditingEvidence({ authored: true }),
		analysisDocumentHash: hashEditingEvidence(analysis),
		mediaVersionId,
		mediaSha256: proof.preparedSha256,
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
			requestKey: id(6),
			parameters: {},
		},
	});
	const current = mediaTaskEnvelopeSchema.parse({
		schemaVersion: 1,
		identity: {
			...identity,
			preparedShotClock: {
				version: "aisa-prepared-clock-v3",
				normalizationReceiptHash: hashEditingEvidence(proof),
			},
		},
		input: {
			kind: "GENERATE",
			mediaVersionId,
			analysisRevisionId,
			requestKey: id(7),
			parameters: {
				contentId: id(8),
				targetDurationFrames: 30,
				tracking: true,
				captions: "OFF",
				trackingTaskId: id(9),
			},
		},
	});
	const row = {
		id: id(9),
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
			observations: [3, 13, 23].map((frame) => ({
				sceneId,
				shotIndex: 1,
				sourceTimeUs: us(frame),
				box: { x: 0.4, y: 0.3, w: 0.08, h: 0.15 },
				confidence: 0.95,
			})),
			fallbacks: [],
			bindingKind: "FIXTURE_AUTHORED",
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		},
	};
	const verify = () =>
		verifyMediaTaskDependency({
			row,
			kind: "TRACK",
			current,
			timeMap,
			analysisDocument: analysis,
			requiredClips: [
				{ sceneId, shotIndex: 1, sourceInUs: us(3), durationFrames: 27 },
			],
		});
	return { row, current, previous, entry, verify };
}

describe("V3 does not reinterpret an old standalone TRACK result", () => {
	it.each([
		false,
		true,
	])("rejects the old result even though its raw range covers the off-grid V3 FIT prefix (certain-only %s)", (certainOnly) => {
		const f = fixture();
		expect(f.entry).toMatchObject({
			fromFrame: 3,
			legacyFromFrame: 3,
			certainFromFrame: 4,
			fitBands: [
				{ fromFrame: 3, toFrame: 4, reason: "RAW_TIMESTAMP_ROUNDTRIP_GUARD" },
			],
		});
		if (certainOnly)
			f.row.result.observations = f.row.result.observations.slice(1);
		const before = JSON.stringify({ row: f.row, current: f.current });
		expect(f.verify).toThrow("TASK_DEPENDENCY_INVALID");
		expect(JSON.stringify({ row: f.row, current: f.current })).toBe(before);
	});
	it("retains the existing standalone TRACK contract for a legacy current generation", () => {
		const f = fixture();
		delete f.current.identity.preparedShotClock;
		const before = JSON.stringify(f.row);
		expect(f.verify()).toMatchObject({
			kind: "TRACK",
			result: { observations: f.row.result.observations },
		});
		expect(JSON.stringify(f.row)).toBe(before);
	});
	it("does not create a V3 producer by adding a clock label to old result metadata", () => {
		const f = fixture();
		f.previous.identity.preparedShotClock =
			f.current.identity.preparedShotClock;
		f.row.cacheKey = mediaTaskCacheKey(f.previous.input, f.previous.identity);
		expect(f.verify).toThrow("TASK_DEPENDENCY_INVALID");
	});
});
