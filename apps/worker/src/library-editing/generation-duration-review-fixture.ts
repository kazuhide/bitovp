import { randomUUID } from "node:crypto";
import {
	hashEditingEvidence,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { generationDependencyFixture } from "./generation-dependency-fixture";

export function durationReviewFixture(
	safeFrames = 89,
	versioned = true,
	mode: "DRAFT" | "EXPORT" = "DRAFT",
	trackingEnabled = false,
) {
	const f = generationDependencyFixture("TRANSCRIBE");
	// Stable persisted double at frame 110; both sides use the same authored cut.
	const sharedEndSeconds = 3.666666666666667;
	const raw = {
		metadata: { version: "authored-duration-review-boundary" },
		duration: 6,
		scenes: [
			{
				id: randomUUID(),
				type: "ADS",
				startInSeconds: 0,
				endInSeconds: 10 / 30,
				shots: [{ startInSeconds: 0, endInSeconds: 10 / 30 }],
			},
			{
				id: f.sceneIds[0],
				type: "MAIN_CONTENT",
				title: "Interview",
				startInSeconds: 10 / 30,
				endInSeconds: sharedEndSeconds,
				shots: [
					[10, 10 + safeFrames],
					[10 + safeFrames, 110],
				].map(([from = 0, to = 0]) => ({
					startInSeconds: from / 30,
					endInSeconds: to === 110 ? sharedEndSeconds : to / 30,
					mainSubjects: [
						{
							classification: "person",
							description: "Authored fixture",
							appearanceTimeInSeconds: 0,
							centerX: 50,
							centerY: 50,
							box2d: [100, 400, 800, 600],
						},
					],
				})),
			},
			{
				id: f.sceneIds[1],
				type: "MAIN_CONTENT",
				title: "Tail",
				startInSeconds: sharedEndSeconds,
				endInSeconds: 6,
				shots: [{ startInSeconds: sharedEndSeconds, endInSeconds: 6 }],
			},
		],
	};
	f.analysis.document = normalizeSceneAnalysis(raw);
	f.analysis.rawHash = hashEditingEvidence(raw);
	Object.assign(f.binding, {
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(f.analysis.document),
	});
	Object.assign(f.task.parameters.identity, {
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: f.binding.analysisDocumentHash,
		bindingHash: hashEditingEvidence(f.binding),
		...(trackingEnabled
			? {
					trackingAlgorithmVersion: LOCAL_TRACKING_ALGORITHM_VERSION,
					trackingFrameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
				}
			: {}),
	});
	Object.assign(f.task.parameters.input.parameters, {
		renderMode: mode,
		targetDurationFrames: 100,
		tracking: trackingEnabled,
		...(versioned ? { draftPolicyVersion: "duration-review-v2" } : {}),
	});
	f.dependency.result.segments = [
		{ startUs: 400000, endUs: 600000, text: "early measured speech" },
		{
			startUs: 3500000,
			endUs: 4500000,
			text: "measured speech across anchor end",
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
	return { ...f, raw, refreshCurrent };
}
