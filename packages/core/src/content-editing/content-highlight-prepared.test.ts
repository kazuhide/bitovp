import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { createPortraitSelectionSearchBudget } from "./auto-portrait";
import {
	buildPreparedShotPartition,
	selectPreparedPortraitClips,
} from "./prepared-shot-partition";
import {
	fixtureItem,
	preparedClockFixture,
	preparedSceneId,
} from "./prepared-shot-partition.test-fixtures";
import {
	buildSpeechContextWindow,
	refinePortraitSelectionBySpeech,
} from "./speech-boundaries";
import { hashEditingEvidence } from "./verify-automatic-binding";

describe("AUTO metadata selection through the verified prepared clock", () => {
	it("skips an AISA anchor beyond the prepared source while retaining a shorter valid baseline", () => {
		const f = preparedClockFixture(),
			outside = "55555555-5555-4555-8555-555555555555";
		const analysis = normalizeSceneAnalysis({
			metadata: { version: "source-shorter-than-analysis" },
			duration: 3,
			scenes: [
				{
					id: preparedSceneId,
					type: "MAIN_CONTENT",
					startInSeconds: 0,
					endInSeconds: 1,
					title: "A landscape",
					shots: [{ startInSeconds: 0, endInSeconds: 1 }],
				},
				{
					id: outside,
					type: "MAIN_CONTENT",
					startInSeconds: 2,
					endInSeconds: 3,
					title: "The robot discovers the key and rescues the bird",
					shots: [
						{
							startInSeconds: 2,
							endInSeconds: 3,
							detailedDescription:
								"The robot discovers the key and rescues the bird",
						},
					],
				},
			],
		});
		const partition = buildPreparedShotPartition({
				analysis,
				timeMap: f.timeMap,
				normalization: f.proof,
			}),
			before = JSON.stringify({ analysis, partition });
		expect(
			selectPreparedPortraitClips({
				partition,
				targetDurationFrames: 60,
				policy: "DURATION",
			}).actualDurationFrames,
		).toBe(30);
		const selected = selectPreparedPortraitClips({
			partition,
			targetDurationFrames: 60,
			policy: "AUTO",
		});
		expect(selected.actualDurationFrames).toBe(30);
		expect(selected.clips).toEqual([
			{
				sceneId: preparedSceneId,
				shotIndex: 0,
				sourceInUs: 0,
				durationFrames: 30,
			},
		]);
		expect(
			selected.semanticEvidence?.selectedMoments.map(
				(moment) => moment.sceneId,
			),
		).toEqual([preparedSceneId]);
		expect(selected.normalizationReceiptHash).toBe(
			hashEditingEvidence(f.proof),
		);
		expect(JSON.stringify({ analysis, partition })).toBe(before);
	});
	it("retains raw cut adjacency, FIT boundary guards, original indices and receipt identity", () => {
		const f = preparedClockFixture();
		fixtureItem(f.analysis.scenes[0]).title = "The robot discovers the key";
		const before = JSON.stringify(f),
			partition = buildPreparedShotPartition({
				analysis: f.analysis,
				timeMap: f.timeMap,
				normalization: f.proof,
			});
		const selected = selectPreparedPortraitClips({
			partition,
			targetDurationFrames: 60,
			policy: "AUTO",
		});
		expect(selected.policyVersion).toBe("aisa-prepared-content-highlight-v4");
		expect(selected.normalizationReceiptHash).toBe(
			hashEditingEvidence(f.proof),
		);
		expect(selected.actualDurationFrames).toBe(60);
		expect(selected.clips.map((clip) => clip.shotIndex)).toEqual([
			0, 1, 2, 3, 4,
		]);
		expect(selected.clips.map((clip) => clip.durationFrames)).toEqual([
			2, 1, 1, 1, 55,
		]);
		expect(selected.reasonCodes).toContain("BOUNDARY_FIT_GUARD");
		expect(
			selected.semanticEvidence?.selectedMoments.map(
				(moment) => moment.sceneId,
			),
		).toEqual(Array(5).fill(preparedSceneId));
		expect(JSON.stringify(f)).toBe(before);
		expect(() =>
			selectPreparedPortraitClips({
				partition,
				targetDurationFrames: 60,
				policy: "AUTO",
				query: "robot",
			}),
		).toThrow("PREPARED_AUTO_QUERY_FORBIDDEN");
	});
	it("keeps AUTO provenance and normalization proof through ASR no-speech refinement", () => {
		const f = preparedClockFixture();
		fixtureItem(f.analysis.scenes[0]).title = "The robot discovers the key";
		const partition = buildPreparedShotPartition({
				analysis: f.analysis,
				timeMap: f.timeMap,
				normalization: f.proof,
			}),
			searchBudget = createPortraitSelectionSearchBudget();
		const anchor = selectPreparedPortraitClips({
			partition,
			targetDurationFrames: 60,
			policy: "AUTO",
			searchBudget,
		});
		const result = refinePortraitSelectionBySpeech({
			analysis: f.analysis,
			timeMap: f.timeMap,
			targetDurationFrames: 60,
			policy: "AUTO",
			anchor,
			searchBudget,
			preparedPartition: partition,
			context: buildSpeechContextWindow({
				selection: anchor,
				timeMap: f.timeMap,
			}),
			segments: [],
		});
		expect(result.selection).toEqual(anchor);
		expect(result.reason).toBe("NO_SPEECH");
		expect(() =>
			refinePortraitSelectionBySpeech({
				analysis: f.analysis,
				timeMap: f.timeMap,
				targetDurationFrames: 60,
				policy: "AUTO",
				anchor: { ...anchor, normalizationReceiptHash: "f".repeat(64) },
				searchBudget,
				preparedPartition: partition,
				context: buildSpeechContextWindow({
					selection: anchor,
					timeMap: f.timeMap,
				}),
				segments: [],
			}),
		).toThrow("Prepared speech anchor clock mismatch");
	});
});
