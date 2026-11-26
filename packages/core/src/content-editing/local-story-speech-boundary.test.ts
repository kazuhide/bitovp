import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { authoredNormalizationReceipt } from "../testing/normalization-clock";
import { localStorySelectedPlanIssues } from "./local-story-coherence";
import type {
	LocalStoryBlueprint,
	LocalStoryCorpus,
	LocalStoryEvent,
	LocalStoryInput,
} from "./local-story-contracts";
import {
	buildLocalStoryInput,
	localStoryClipsWithinSceneScope,
} from "./local-story-input";
import {
	localStoryEventMinimumDurationFrames,
	selectLocalStoryClips,
} from "./local-story-planner";
import { buildPreparedShotPartition } from "./prepared-shot-partition";
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

const scopedSceneId = "44444444-4444-4444-8444-444444444444";
const earlierSceneId = "55555555-5555-4555-8555-555555555555";
function preparedSceneStoryInput(options: {
	sceneStart?: number;
	unscoped?: boolean;
	shots?: {
		startInSeconds: number;
		endInSeconds: number;
		detailedDescription?: string;
	}[];
	segments: LocalStoryInput["segments"];
}) {
	const sceneStart = options.sceneStart ?? 20;
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-boundary-review" },
		duration: 44,
		scenes: [
			{
				id: earlierSceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: sceneStart,
				shots: [{ startInSeconds: 0, endInSeconds: sceneStart }],
			},
			{
				id: scopedSceneId,
				type: "MAIN_CONTENT",
				startInSeconds: sceneStart,
				endInSeconds: 40,
				shots: options.shots ?? [
					{ startInSeconds: sceneStart, endInSeconds: 40 },
				],
			},
		],
	});
	const normalization = authoredNormalizationReceipt({
		organizationId: "00000000-0000-4000-8000-000000000001",
		sourceId: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		sourceFrameCount: 44 * 24,
		hasAudio: true,
	});
	const timeMap = cfrTimeMapSchema.parse({
		id: normalization.timeMapId,
		mediaVersionId: normalization.mediaVersionId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 44_000_000,
		editingStartFrame: 0,
		editingEndFrame: 1_320,
		fps: { num: 30, den: 1 },
	});
	return buildLocalStoryInput({
		analysis,
		timeMap,
		preparedPartition: buildPreparedShotPartition({
			analysis,
			timeMap,
			normalization,
		}),
		segments: options.segments,
		...(options.unscoped ? {} : { storySceneId: scopedSceneId }),
	});
}

function speechEvent(
	id: string,
	role: LocalStoryEvent["role"],
	ref: string,
	texts: string[],
): LocalStoryEvent {
	return {
		id,
		role,
		label: item(texts[0]),
		refs: [ref],
		quotes: texts.map((quote) => ({ ref, quote })),
		subjects: ["speaker"],
		uncertainty: "",
	};
}

function sceneQuoteFixture(options: {
	startUs: number;
	endUs: number;
	sceneStart?: number;
	priorSpeechEndUs?: number;
	unscoped?: boolean;
}) {
	const text = "I turned the switch on.";
	const input = preparedSceneStoryInput({
		...options,
		segments: [
			...(options.priorSpeechEndUs === undefined
				? []
				: [
						{
							startUs: 20_020_000,
							endUs: options.priorSpeechEndUs,
							text: "An earlier utterance.",
						},
					]),
			{ startUs: options.startUs, endUs: options.endUs, text },
		],
	});
	const { ref } = item(
		input.shots.find((shot) => shot.sceneId === scopedSceneId),
	);
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: [text],
		coveredRefs: input.shots.map((shot) => shot.ref),
		events: [speechEvent("e0", "ACTION", ref, [text])],
	};
	const blueprint: LocalStoryBlueprint = {
		mode: "THEME",
		message: "A switch is turned on.",
		uncertainty: "",
		beats: [{ id: "only", role: "ACTION", eventIds: ["e0"], requires: [] }],
	};
	return { input, ledger, blueprint, targetDurationFrames: 36 };
}

describe("quoted speech in a prepared scene scope", () => {
	it.each([
		{
			edge: "start",
			startUs: 20_050_000,
			endUs: 21_050_000,
			sourceInUs: 20_000_000,
		},
		{
			edge: "end",
			startUs: 38_950_000,
			endUs: 39_950_000,
			sourceInUs: 38_833_334,
		},
	])("clamps only optional quote padding at the scene $edge", ({
		startUs,
		endUs,
		sourceInUs,
	}) => {
		const value = sceneQuoteFixture({ startUs, endUs });
		const selection = selectLocalStoryClips(value);
		expect(value.input.sceneFrameBounds).toEqual({
			fromFrame: 600,
			toFrame: 1200,
		});
		expect(selection.actualDurationFrames).toBe(35);
		expect(selection.clips).toEqual([
			{ sceneId: scopedSceneId, shotIndex: 0, sourceInUs, durationFrames: 35 },
		]);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBe(31);
		expect(localStorySelectedPlanIssues({ ...value, selection })).toEqual([]);
		expect(
			localStoryClipsWithinSceneScope({
				scope: item(value.input.sceneScope),
				frameBounds: item(value.input.sceneFrameBounds),
				timeMap: value.input.timeMap,
				clips: selection.clips,
			}),
		).toBe(true);
	});
	it("uses the complete quote when padding pulls prior speech outside the scene", () => {
		const value = sceneQuoteFixture({
			sceneStart: 20.01,
			priorSpeechEndUs: 20_350_000,
			startUs: 20_390_000,
			endUs: 21_360_000,
		});
		expect(value.input.sceneFrameBounds).toEqual({
			fromFrame: 602,
			toFrame: 1200,
		});
		const selection = selectLocalStoryClips(value);
		expect(selection.clips).toEqual([
			{
				sceneId: scopedSceneId,
				shotIndex: 0,
				sourceInUs: 20_366_667,
				durationFrames: 30,
			},
		]);
		expect(localStorySelectedPlanIssues({ ...value, selection })).toEqual([]);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBe(30);
	});
	it("uses the complete quote for a shorter budget and keeps padding when it fits", () => {
		const value = sceneQuoteFixture({ startUs: 25_000_000, endUs: 26_000_000 });
		const padded = selectLocalStoryClips(value);
		expect(padded.actualDurationFrames).toBe(36);
		expect(padded.clips[0]?.sourceInUs).toBe(24_900_000);
		const exact = selectLocalStoryClips({ ...value, targetDurationFrames: 30 });
		expect(exact.actualDurationFrames).toBe(30);
		expect(exact.clips[0]?.sourceInUs).toBe(25_000_000);
		expect(
			localStorySelectedPlanIssues({ ...value, selection: exact }),
		).toEqual([]);
		expect(
			localStoryEventMinimumDurationFrames(
				value.input,
				item(value.ledger.events[0]),
			),
		).toBe(30);
		expect(() =>
			selectLocalStoryClips({ ...value, targetDurationFrames: 29 }),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
	});
	it("combines padded and unpadded events to preserve a feasible source order", () => {
		const first = [
			{ startUs: 21_000_000, endUs: 22_000_000, text: "The switch is on." },
			{
				startUs: 25_000_000,
				endUs: 26_000_000,
				text: "The battery is charged.",
			},
		];
		const second = [
			{
				startUs: 22_040_000,
				endUs: 23_000_000,
				text: "Power reaches the motor.",
			},
			{ startUs: 27_000_000, endUs: 28_000_000, text: "The wheels turn." },
		];
		const input = preparedSceneStoryInput({ segments: [...first, ...second] });
		const { ref } = item(input.shots[0]);
		const ledger: LocalStoryCorpus = {
			version: "local-story-corpus-v1",
			summaries: ["The speaker explains how the motor starts."],
			coveredRefs: [ref],
			events: [
				speechEvent(
					"context",
					"CONTEXT",
					ref,
					first.map(({ text }) => text),
				),
				speechEvent(
					"result",
					"OUTCOME",
					ref,
					second.map(({ text }) => text),
				),
			],
		};
		const blueprint: LocalStoryBlueprint = {
			mode: "THEME",
			message: "The motor starts.",
			uncertainty: "",
			beats: [
				{ id: "setup", role: "CONTEXT", eventIds: ["context"], requires: [] },
				{
					id: "finish",
					role: "OUTCOME",
					eventIds: ["result"],
					requires: ["setup"],
				},
			],
		};
		const value = { input, ledger, blueprint, targetDurationFrames: 130 };
		const selection = selectLocalStoryClips(value);
		expect(selection.actualDurationFrames).toBe(129);
		expect(selection.clips).toEqual([
			{
				sceneId: scopedSceneId,
				shotIndex: 0,
				sourceInUs: 20_900_000,
				durationFrames: 63,
			},
			{
				sceneId: scopedSceneId,
				shotIndex: 0,
				sourceInUs: 24_900_000,
				durationFrames: 36,
			},
			{
				sceneId: scopedSceneId,
				shotIndex: 0,
				sourceInUs: 27_000_000,
				durationFrames: 30,
			},
		]);
		expect(localStorySelectedPlanIssues({ ...value, selection })).toEqual([]);
		expect(() =>
			selectLocalStoryClips({ ...value, targetDurationFrames: 128 }),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
	});
	it("skips a whole prepared shot that misses its quote and selects the complete alternative", () => {
		const missed = {
			startUs: 23_550_000,
			endUs: 25_050_000,
			text: "The motor starts.",
		};
		const covered = {
			startUs: 30_000_000,
			endUs: 31_300_000,
			text: "The motor is running.",
		};
		const input = preparedSceneStoryInput({
			shots: [
				{ startInSeconds: 25.041667, endInSeconds: 26.4 },
				{ startInSeconds: 29, endInSeconds: 39 },
			],
			segments: [missed, covered],
		});
		const firstShot = item(input.shots[0]);
		const secondShot = item(input.shots[1]);
		expect(firstShot).toMatchObject({ fromFrame: 752, toFrame: 792 });
		const events = [
			speechEvent("missed", "ACTION", firstShot.ref, [missed.text]),
			speechEvent("covered", "ACTION", secondShot.ref, [covered.text]),
		];
		const ledger: LocalStoryCorpus = {
			version: "local-story-corpus-v1",
			summaries: ["The speaker describes the motor."],
			coveredRefs: [firstShot.ref, secondShot.ref],
			events,
		};
		const blueprint: LocalStoryBlueprint = {
			mode: "THEME",
			message: "The motor runs.",
			uncertainty: "",
			beats: [
				{
					id: "only",
					role: "ACTION",
					eventIds: ["missed", "covered"],
					requires: [],
				},
			],
		};
		const selection = selectLocalStoryClips({
			input,
			ledger,
			blueprint,
			targetDurationFrames: 42,
		});
		expect(selection.localStorySelection.selectedEventIds).toEqual(["covered"]);
		expect(selection.clips).toEqual([
			{
				sceneId: scopedSceneId,
				shotIndex: 1,
				sourceInUs: 30_000_000,
				durationFrames: 39,
			},
		]);
		expect(
			localStorySelectedPlanIssues({ input, ledger, blueprint, selection }),
		).toEqual([]);
		expect(
			events.map((event) => localStoryEventMinimumDurationFrames(input, event)),
		).toEqual([40, 39]);
	});
	it("keeps a beat whose quoted speech is covered by the previous prepared shot", () => {
		const setup = "The motor is idle.";
		const action = "The speaker presses a switch.";
		const speech = "Listen to the motor.";
		const input = preparedSceneStoryInput({
			shots: [
				{
					startInSeconds: 20,
					endInSeconds: 25.041667,
					detailedDescription: setup,
				},
				{
					startInSeconds: 25.041667,
					endInSeconds: 26.4,
					detailedDescription: action,
				},
			],
			segments: [{ startUs: 23_550_000, endUs: 25_050_000, text: speech }],
		});
		const [first, second] = [item(input.shots[0]), item(input.shots[1])];
		expect(first).toMatchObject({ fromFrame: 600, toFrame: 752 });
		expect(second).toMatchObject({ fromFrame: 752, toFrame: 792 });
		const events = [
			speechEvent("setup", "CONTEXT", first.ref, [setup]),
			speechEvent("action", "ACTION", second.ref, [action, speech]),
		];
		const ledger: LocalStoryCorpus = {
			version: "local-story-corpus-v1",
			summaries: ["The speaker starts the motor."],
			coveredRefs: [first.ref, second.ref],
			events,
		};
		const blueprint: LocalStoryBlueprint = {
			mode: "FLOW",
			message: "The motor starts.",
			uncertainty: "",
			beats: [
				{ id: "b1", role: "CONTEXT", eventIds: ["setup"], requires: [] },
				{ id: "b2", role: "ACTION", eventIds: ["action"], requires: ["b1"] },
			],
		};
		const options = { input, ledger, blueprint, targetDurationFrames: 200 };
		const selection = selectLocalStoryClips(options);
		expect(selection.actualDurationFrames).toBe(192);
		expect(selection.clips.map(({ durationFrames }) => durationFrames)).toEqual(
			[152, 40],
		);
		expect(localStorySelectedPlanIssues({ ...options, selection })).toEqual([]);
		expect(
			events.map((event) => localStoryEventMinimumDurationFrames(input, event)),
		).toEqual([152, 40]);
		expect(() =>
			selectLocalStoryClips({
				...options,
				blueprint: {
					...blueprint,
					beats: [{ ...item(blueprint.beats[1]), requires: [] }],
				},
			}),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
	});
	it("does not cut preceding speech that intersects the first required quote frame", () => {
		const value = sceneQuoteFixture({
			sceneStart: 20.01,
			priorSpeechEndUs: 20_380_000,
			startUs: 20_390_000,
			endUs: 21_360_000,
		});
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
	it("rejects speech before the available prepared frame even if its padding fits", () => {
		const value = sceneQuoteFixture({
			sceneStart: 20.01,
			startUs: 20_015_000,
			endUs: 20_020_000,
		});
		expect(item(value.input.sceneFrameBounds).fromFrame).toBeGreaterThan(600);
		expect(() => selectLocalStoryClips(value)).toThrow(
			"LOCAL_STORY_NO_FITTING_PLAN",
		);
	});
	it("keeps the existing padding across scene boundaries in an unscoped plan", () => {
		const value = sceneQuoteFixture({
			startUs: 20_050_000,
			endUs: 21_050_000,
			unscoped: true,
		});
		const selection = selectLocalStoryClips({
			...value,
			targetDurationFrames: 37,
		});
		expect(selection.actualDurationFrames).toBe(37);
		expect(selection.clips).toEqual([
			{
				sceneId: earlierSceneId,
				shotIndex: 0,
				sourceInUs: 19_933_334,
				durationFrames: 2,
			},
			{
				sceneId: scopedSceneId,
				shotIndex: 0,
				sourceInUs: 20_000_000,
				durationFrames: 35,
			},
		]);
	});
});

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
