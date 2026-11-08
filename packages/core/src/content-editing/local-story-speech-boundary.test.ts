import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import type {
	LocalStoryBlueprint,
	LocalStoryCorpus,
} from "./local-story-contracts";
import { buildLocalStoryInput } from "./local-story-input";
import {
	localStoryEventMinimumDurationFrames,
	selectLocalStoryClips,
} from "./local-story-planner";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

const observation = "Robot presses a switch.";
function item<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing authored fixture item");
	return value;
}
function fixture(sourceStartUs = 0) {
	const sceneId = "11111111-1111-4111-8111-111111111111";
	const cuts = [0, 6, 8, 9, 10, 12];
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-boundary-review" },
		title: "Source clock boundaries",
		description: "An authored boundary fixture.",
		duration: 12,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 12,
				shots: cuts.slice(0, -1).map((from, index) => ({
					startInSeconds: from,
					endInSeconds: cuts[index + 1],
					detailedDescription: observation,
					mainSubjects: [],
				})),
			},
		],
	});
	const input = buildLocalStoryInput({
		analysis,
		timeMap: cfrTimeMapSchema.parse({
			id: "22222222-2222-4222-8222-222222222222",
			mediaVersionId: "33333333-3333-4333-8333-333333333333",
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 12_000_000,
			editingStartFrame: 0,
			editingEndFrame: 360,
			fps: { num: 30, den: 1 },
		}),
		segments: [
			{ startUs: 0, endUs: 6_620_000, text: "First utterance." },
			{ startUs: 6_620_000, endUs: 9_920_000, text: "Second utterance." },
			{ startUs: 9_920_000, endUs: 12_000_000, text: "Third utterance." },
		],
	});
	// Keep exact original-source timestamps while output shot frames remain relative.
	input.timeMap.sourceStartUs += sourceStartUs;
	input.timeMap.sourceEndUs += sourceStartUs;
	input.timeMapHash = hashEditingEvidence(input.timeMap);
	for (const segment of input.segments) {
		segment.startUs += sourceStartUs;
		segment.endUs += sourceStartUs;
	}
	for (const shot of input.shots)
		for (const field of shot.fields) {
			if (field.startUs !== undefined) field.startUs += sourceStartUs;
			if (field.endUs !== undefined) field.endUs += sourceStartUs;
		}
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: [observation],
		coveredRefs: input.shots.map((shot) => shot.ref),
		events: [
			{
				id: "e0",
				role: "ACTION",
				label: observation,
				refs: ["s2"],
				quotes: [{ ref: "s2", quote: observation }],
				subjects: ["robot"],
				uncertainty: "",
			},
		],
	};
	const blueprint: LocalStoryBlueprint = {
		mode: "THEME",
		message: "A switch is pressed.",
		uncertainty: "",
		beats: [{ id: "only", role: "ACTION", eventIds: ["e0"], requires: [] }],
	};
	return { input, ledger, blueprint, targetDurationFrames: 120 };
}

describe("speech closure in the original half-open clock", () => {
	it.each([
		0, 10_000_001,
	])("does not join adjacent utterances through frame rounding, origin=%i", (sourceStartUs) => {
		const value = fixture(sourceStartUs);
		const selected = selectLocalStoryClips(value);
		expect(selected.actualDurationFrames).toBe(100);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBe(100);
		expect(selected.clips[0]?.sourceInUs).toBe(sourceStartUs + 6_600_000);
		expect(selected.clips.map((clip) => clip.shotIndex)).toEqual([1, 2, 3]);
		expect(selected.localStorySelection.selectedEventIds).toEqual(["e0"]);
	});
	it("still expands through genuinely overlapping original utterances", () => {
		const value = fixture();
		item(value.input.segments[0]).endUs = 7_000_000;
		item(value.input.segments[1]).endUs = 10_000_000;
		expect(() => selectLocalStoryClips(value)).toThrow(
			"LOCAL_STORY_NO_FITTING_PLAN",
		);
	});
	it("does not trim a genuinely long utterance to meet the requested duration", () => {
		const value = fixture();
		value.input.segments = [
			{ startUs: 0, endUs: 12_000_000, text: "One long utterance." },
		];
		expect(() => selectLocalStoryClips(value)).toThrow(
			"LOCAL_STORY_NO_FITTING_PLAN",
		);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBe(360);
	});
	it("retains the eligible-shot coverage guard around the complete utterance", () => {
		const value = fixture();
		value.input.shots = value.input.shots.filter((shot) => shot.ref !== "s3");
		value.ledger.coveredRefs = value.input.shots.map((shot) => shot.ref);
		expect(() => selectLocalStoryClips(value)).toThrow(
			"LOCAL_STORY_NO_FITTING_PLAN",
		);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBeUndefined();
	});
	it("retains the maximum-clip guard even when the utterance fits the frame budget", () => {
		const value = fixture();
		const template = item(value.input.shots[0]);
		const spans = [
			{ from: 0, to: 198 },
			...Array.from({ length: 100 }, (_, i) => ({
				from: 198 + i,
				to: 199 + i,
			})),
			{ from: 298, to: 360 },
		];
		value.input.shots = spans.map((span, index) => ({
			...template,
			ref: `s${index}`,
			shotIndex: index,
			fromFrame: span.from,
			toFrame: span.to,
			fields: [{ pointer: `/shots/${index}`, kind: "AISA", text: observation }],
		}));
		value.ledger.coveredRefs = value.input.shots.map((shot) => shot.ref);
		item(value.ledger.events[0]).refs = ["s43"];
		item(value.ledger.events[0]).quotes = [{ ref: "s43", quote: observation }];
		expect(() => selectLocalStoryClips(value)).toThrow(
			"LOCAL_STORY_NO_FITTING_PLAN",
		);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBeUndefined();
	});
	it("reports the minimum candidate rather than the maximum-duration single-beat selection", () => {
		const value = fixture();
		item(value.ledger.events[0]).label = "Second utterance.";
		item(value.ledger.events[0]).quotes = [
			{ ref: "s2", quote: "Second utterance." },
		];
		value.targetDurationFrames = 360;
		expect(selectLocalStoryClips(value).actualDurationFrames).toBe(360);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBe(100);
	});
});
