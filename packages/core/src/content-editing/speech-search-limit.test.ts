import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { createPortraitSelectionSearchBudget } from "./auto-portrait";
import { selectContentHighlightClips } from "./content-highlight";
import {
	buildSpeechContextWindow,
	refinePortraitSelectionBySpeech,
	SpeechBoundarySelectionError,
} from "./speech-boundaries";

const a = "11111111-1111-4111-8111-111111111111",
	b = "22222222-2222-4222-8222-222222222222";
function exhaustedAnchor() {
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "bounded-speech-search" },
		duration: 10000,
		scenes: [a, b].map((id, sceneIndex) => ({
			id,
			type: "MAIN_CONTENT",
			startInSeconds: sceneIndex * 5000,
			endInSeconds: (sceneIndex + 1) * 5000,
			shots: Array.from({ length: 5000 }, (_, index) => ({
				startInSeconds: sceneIndex * 5000 + index,
				endInSeconds: sceneIndex * 5000 + index + 1,
				detailedDescription:
					index === 4999 ? "The robot discovers the key" : "",
			})),
		})),
	});
	const timeMap = {
		id: a,
		mediaVersionId: b,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 10_000_000_000,
		editingStartFrame: 0,
		editingEndFrame: 300000,
		fps: { num: 30, den: 1 },
	};
	const searchBudget = createPortraitSelectionSearchBudget(),
		anchor = selectContentHighlightClips({
			analysis,
			timeMap,
			targetDurationFrames: 600,
			searchBudget,
		});
	return {
		analysis,
		timeMap,
		searchBudget,
		anchor,
		targetDurationFrames: 600,
		context: buildSpeechContextWindow({ selection: anchor, timeMap }),
	};
}

describe("bounded AUTO speech search failure retains measured diagnostics", () => {
	it("reports an exhausted shared budget without retry, invented safe cuts or losing observed speech", () => {
		const input = exhaustedAnchor(),
			segments = [{ startUs: 19_000_000, endUs: 21_000_000 }];
		expect(input.anchor.semanticEvidence.selectionReason).toBe("SEARCH_BUDGET");
		expect(input.anchor.clips[0]?.sourceInUs).toBe(0);
		expect(input.anchor.actualDurationFrames).toBe(600);
		expect(input.searchBudget.usedExpansions).toBe(200000);
		const before = JSON.stringify({ anchor: input.anchor, segments });
		let failure: unknown;
		try {
			refinePortraitSelectionBySpeech({ ...input, policy: "AUTO", segments });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SpeechBoundarySelectionError);
		expect(failure).toMatchObject({
			code: "SPEECH_SELECTION_SEARCH_LIMIT",
			message: "SPEECH_SELECTION_SEARCH_LIMIT",
			evidence: { intervals: segments, rejectedBoundaryCount: 1 },
		});
		expect(input.searchBudget.usedExpansions).toBe(200000);
		expect(JSON.stringify({ anchor: input.anchor, segments })).toBe(before);
		if (!(failure instanceof SpeechBoundarySelectionError))
			throw new Error("Expected bounded speech failure");
		expect(Object.isFrozen(failure.evidence)).toBe(true);
		expect(Object.isFrozen(failure.evidence?.intervals[0])).toBe(true);
		const noSpeech = refinePortraitSelectionBySpeech({
			...input,
			policy: "AUTO",
			segments: [],
		});
		expect(noSpeech).toMatchObject({
			selection: input.anchor,
			reason: "NO_SPEECH",
		});
		expect(input.searchBudget.usedExpansions).toBe(200000);
		expect(() =>
			refinePortraitSelectionBySpeech({
				...input,
				policy: "DURATION",
				segments,
			}),
		).toThrow("Auto portrait search limit exceeded (200000)");
	});
	it("validates diagnostic bounds for the new failure code", () => {
		const error = new SpeechBoundarySelectionError(
			"SPEECH_SELECTION_SEARCH_LIMIT",
			{ intervals: [{ startUs: 1, endUs: 2 }], rejectedBoundaryCount: 1 },
		);
		expect(error.evidence).toEqual({
			intervals: [{ startUs: 1, endUs: 2 }],
			rejectedBoundaryCount: 1,
		});
		expect(Object.isFrozen(error.evidence)).toBe(true);
		expect(
			() =>
				new SpeechBoundarySelectionError("SPEECH_SELECTION_SEARCH_LIMIT", {
					intervals: [{ startUs: 2, endUs: 1 }],
					rejectedBoundaryCount: 1,
				}),
		).toThrow();
		expect(
			() =>
				new SpeechBoundarySelectionError("SPEECH_SELECTION_SEARCH_LIMIT", {
					intervals: [],
					rejectedBoundaryCount: 20001,
				}),
		).toThrow();
		expect(
			new SpeechBoundarySelectionError("SPEECH_SELECTION_SEARCH_LIMIT")
				.evidence,
		).toBeUndefined();
	});
});
