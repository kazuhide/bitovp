import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { createPortraitSelectionSearchBudget } from "./auto-portrait";
import {
	buildPreparedShotPartition,
	selectPreparedPortraitClips,
} from "./prepared-shot-partition";
import {
	preparedClockFixture,
	preparedSceneId,
} from "./prepared-shot-partition.test-fixtures";
import {
	buildSpeechContextWindow,
	refinePortraitSelectionBySpeech,
	SpeechBoundarySelectionError,
} from "./speech-boundaries";
import { hashEditingEvidence } from "./verify-automatic-binding";

function fixture(targetDurationFrames = 120) {
	const f = preparedClockFixture();
	f.proof.source.frameCount = 144;
	f.proof.source.durationUs = 6000000;
	f.proof.output.frameCount = 180;
	f.proof.output.durationUs = 6000000;
	f.proof.sourceEndUs = 6000000;
	f.proof.sourceFrameIndex = Array.from({ length: 180 }, (_, i) =>
		Math.floor((i * 24) / 30),
	);
	f.proof.indexMapHash = hashEditingEvidence(f.proof.sourceFrameIndex);
	f.proof.recipeHash = hashEditingEvidence({
		profile: f.proof.profile,
		mode: f.proof.mode,
		source: f.proof.source,
		videoFilter:
			"fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=180,setpts=N/(30*TB),setsar=1/1",
		audioFilter: null,
	});
	f.timeMap.sourceEndUs = 6000000;
	f.timeMap.editingEndFrame = 180;
	f.analysis = normalizeSceneAnalysis({
		metadata: { version: "synthetic-speech-partition" },
		duration: 6,
		scenes: [
			{
				id: preparedSceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 6,
				shots: [
					[0, 1.041667],
					[1.041667, 3.041667],
					[3.041667, 4.041667],
					[4.041667, 6],
				].map(([startInSeconds, endInSeconds]) => ({
					startInSeconds,
					endInSeconds,
				})),
			},
		],
	});
	const partition = buildPreparedShotPartition({
			analysis: f.analysis,
			timeMap: f.timeMap,
			normalization: f.proof,
		}),
		searchBudget = createPortraitSelectionSearchBudget();
	const anchor = selectPreparedPortraitClips({
		partition,
		targetDurationFrames,
		policy: "DURATION",
		searchBudget,
	});
	return {
		...f,
		preparedPartition: partition,
		targetDurationFrames,
		policy: "DURATION" as const,
		anchor,
		searchBudget,
		context: buildSpeechContextWindow({
			selection: anchor,
			timeMap: f.timeMap,
		}),
	};
}
describe("speech refinement retains the prepared partition for every search", () => {
	it("extends through an unsafe internal shared cut and reselects the safe 90-frame whole window with v3 evidence", () => {
		const f = fixture();
		expect(f.anchor.actualDurationFrames).toBe(92);
		const segments = [
				{ startUs: 0, endUs: 500000 },
				{ startUs: 1500000, endUs: 2000000 },
				{ startUs: 3000000, endUs: 3500000 },
			],
			before = JSON.stringify(segments);
		const result = refinePortraitSelectionBySpeech({ ...f, segments });
		expect(result.status).toBe("APPLIED");
		expect(result.selection.policyVersion).toBe("aisa-prepared-shot-window-v3");
		expect(result.selection.actualDurationFrames).toBe(90);
		expect(result.selection.clips.map((c) => c.shotIndex)).toEqual([1, 2]);
		expect(result.selection.clips.map((c) => c.durationFrames)).toEqual([
			60, 30,
		]);
		expect(result.selection).toHaveProperty(
			"normalizationReceiptHash",
			hashEditingEvidence(f.proof),
		);
		expect(JSON.stringify(segments)).toBe(before);
	});
	it("does not weaken known unsafe external cuts and preserves original audio-us observations", () => {
		const f = fixture();
		expect(() =>
			refinePortraitSelectionBySpeech({
				...f,
				segments: [{ startUs: 0, endUs: 6000000 }],
			}),
		).toThrow(SpeechBoundarySelectionError);
	});
	it("preserves source-edge unknown fallback for a complete v3 anchor without claiming APPLIED", () => {
		const f = fixture(180);
		const result = refinePortraitSelectionBySpeech({
			...f,
			segments: [
				{ startUs: 0, endUs: 500000 },
				{ startUs: 3000000, endUs: 3500000 },
			],
		});
		expect(result).toMatchObject({
			status: "FALLBACK",
			reason: "BOUNDARY_COVERAGE_UNKNOWN",
			selection: {
				policyVersion: "aisa-prepared-shot-window-v3",
				actualDurationFrames: 180,
			},
		});
	});
	it("rejects mismatching source/analysis or normalization anchor before even a no-speech fallback", () => {
		const f = fixture();
		expect(() =>
			refinePortraitSelectionBySpeech({
				...f,
				analysis: { ...f.analysis, summary: "different" },
				segments: [],
			}),
		).toThrow();
		expect(() =>
			refinePortraitSelectionBySpeech({
				...f,
				anchor: { ...f.anchor, normalizationReceiptHash: "f".repeat(64) },
				segments: [],
			}),
		).toThrow();
	});
});
