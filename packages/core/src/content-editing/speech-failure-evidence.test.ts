import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	createPortraitSelectionSearchBudget,
	selectAutoPortraitClips,
} from "./auto-portrait";
import {
	buildSpeechContextWindow,
	refinePortraitSelectionBySpeech,
	SpeechBoundarySelectionError,
} from "./speech-boundaries";

function measuredFailure() {
	const mediaVersionId = "00000000-0000-4000-8000-000000000001";
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
		metadata: { version: "authored-measured-failure" },
		duration: 2,
		scenes: [
			{
				id: "00000000-0000-4000-8000-000000000002",
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [
					{ startInSeconds: 0, endInSeconds: 1 },
					{ startInSeconds: 1, endInSeconds: 2 },
				],
			},
		],
	});
	const searchBudget = createPortraitSelectionSearchBudget(),
		anchor = selectAutoPortraitClips({
			analysis,
			timeMap,
			targetDurationFrames: 30,
			searchBudget,
		});
	const segments = [
		{ startUs: 0, endUs: 1_200_000 },
		{ startUs: 800_000, endUs: 2_000_000 },
	];
	try {
		refinePortraitSelectionBySpeech({
			analysis,
			timeMap,
			targetDurationFrames: 30,
			policy: "DURATION",
			anchor,
			context: buildSpeechContextWindow({ selection: anchor, timeMap }),
			segments,
			searchBudget,
		});
	} catch (error) {
		if (!(error instanceof SpeechBoundarySelectionError)) throw error;
		return { error, segments };
	}
	throw new Error("Expected the measured unsafe window to remain rejected");
}
describe("NO_SAFE exposes bounded immutable measured evidence to a review-only draft", () => {
	it("retains actual merged intervals and unique rejected boundary count without changing failure identity", () => {
		const { error, segments } = measuredFailure();
		expect(error.code).toBe("NO_SPEECH_SAFE_WINDOW");
		expect(error.message).toBe("NO_SPEECH_SAFE_WINDOW");
		expect(error.name).toBe("SpeechBoundarySelectionError");
		expect(error.evidence).toEqual({
			intervals: [{ startUs: 0, endUs: 2_000_000 }],
			rejectedBoundaryCount: 1,
		});
		expect(segments).toEqual([
			{ startUs: 0, endUs: 1_200_000 },
			{ startUs: 800_000, endUs: 2_000_000 },
		]);
		expect(Object.isFrozen(error.evidence)).toBe(true);
		expect(Object.isFrozen(error.evidence?.intervals)).toBe(true);
		expect(Object.isFrozen(error.evidence?.intervals[0])).toBe(true);
	});
	it("copies caller records and leaves old constructors without invented evidence", () => {
		const evidence = {
			intervals: [{ startUs: 1, endUs: 2 }],
			rejectedBoundaryCount: 1,
		};
		const error = new SpeechBoundarySelectionError(
			"NO_SPEECH_SAFE_WINDOW",
			evidence,
		);
		const first = evidence.intervals[0];
		if (!first) throw new Error("Expected an authored interval");
		first.endUs = 9;
		evidence.intervals.push({ startUs: 10, endUs: 11 });
		expect(error.evidence).toEqual({
			intervals: [{ startUs: 1, endUs: 2 }],
			rejectedBoundaryCount: 1,
		});
		expect(
			Reflect.set(error, "evidence", {
				intervals: [],
				rejectedBoundaryCount: 0,
			}),
		).toBe(false);
		expect(error.evidence).toEqual({
			intervals: [{ startUs: 1, endUs: 2 }],
			rejectedBoundaryCount: 1,
		});
		expect(
			new SpeechBoundarySelectionError("NO_SPEECH_SAFE_WINDOW").evidence,
		).toBeUndefined();
		expect(
			new SpeechBoundarySelectionError("SPEECH_EVIDENCE_LIMIT").evidence,
		).toBeUndefined();
	});
	it.each([
		{
			intervals: Array.from({ length: 5001 }, () => ({ startUs: 1, endUs: 2 })),
			rejectedBoundaryCount: 1,
		},
		{ intervals: [{ startUs: 1, endUs: 2 }], rejectedBoundaryCount: 20001 },
		{ intervals: [{ startUs: 1, endUs: 1 }], rejectedBoundaryCount: 1 },
		{ intervals: [{ startUs: 1, endUs: 2 }], rejectedBoundaryCount: 0.5 },
	])("rejects invalid or oversized diagnostic evidence without manufacturing a partial record %#", (evidence) => {
		expect(
			() => new SpeechBoundarySelectionError("NO_SPEECH_SAFE_WINDOW", evidence),
		).toThrow();
	});
	it("does not attach speech observations to an evidence-limit failure", () => {
		expect(
			() =>
				new SpeechBoundarySelectionError("SPEECH_EVIDENCE_LIMIT", {
					intervals: [],
					rejectedBoundaryCount: 0,
				}),
		).toThrow();
	});
});
