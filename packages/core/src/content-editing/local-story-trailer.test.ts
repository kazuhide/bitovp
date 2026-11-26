import { describe, expect, it } from "vitest";
import { generationTaskParametersSchema } from "../content-production/schema";
import type {
	LocalStoryCorpus,
	LocalStoryInput,
} from "./local-story-contracts";
import { selectLocalStoryTrailer } from "./local-story-trailer";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

const exact = {
	durationMode: "EXACT",
	disclosure: "SETUP_AND_QUESTION",
} as const;
const target = { ...exact, durationMode: "TARGET" } as const;
type Role = LocalStoryCorpus["events"][number]["role"];

function fixtureItem<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing authored fixture");
	return value;
}

function fixture(roles: Role[], shotFrames = 300) {
	const origin = 5_000_001;
	const shotDurationUs = (shotFrames * 1_000_000) / 30;
	const timeMap = cfrTimeMapSchema.parse({
		id: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "22222222-2222-4222-8222-222222222222",
		kind: "CFR",
		sourceStartUs: origin,
		sourceEndUs: origin + roles.length * shotDurationUs,
		editingStartFrame: 0,
		editingEndFrame: roles.length * shotFrames,
		fps: { num: 30, den: 1 },
	});
	const shots: LocalStoryInput["shots"] = roles.map((role, i) => {
		const description = `Grounded scene ${i} describes ${role}.`;
		return {
			ref: `s${i}`,
			sceneId: `scene${i}`,
			fromFrame: i * shotFrames,
			toFrame: (i + 1) * shotFrames,
			text: description,
			fields: [{ pointer: `/shots/${i}`, kind: "AISA", text: description }],
		};
	});
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "Fixture",
		description: "Editorial evidence",
		timeMap,
		timeMapHash: hashEditingEvidence(timeMap),
		scenes: [],
		segments: [],
		shots,
		coverage: shots.map(({ ref }) => ({ ref, status: "ELIGIBLE" })),
	};
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: ["Grounded story evidence"],
		coveredRefs: shots.map((shot) => shot.ref),
		events: shots.map((shot, i) => ({
			id: `e${i}`,
			label: shot.text,
			role: roles[i] as Role,
			refs: [shot.ref],
			quotes: [{ ref: shot.ref, quote: shot.text }],
			subjects: ["Lead"],
			uncertainty: "",
		})),
	};
	return { input, ledger, origin, targetDurationFrames: 900 };
}

describe("local trailer request", () => {
	const parameters = {
		contentId: "22222222-2222-4222-8222-222222222222",
		policy: "LOCAL_STORY",
		renderMode: "DRAFT",
		targetDurationFrames: 900,
		trailer: exact,
	};
	it("accepts a structured trailer only on an explicit local-story draft", () => {
		expect(generationTaskParametersSchema.parse(parameters).trailer).toEqual(
			exact,
		);
		for (const override of [
			{ renderMode: "EXPORT" },
			{ policy: "AUTO" },
			{ storyMode: "FLOW" },
			{ storyPlanner: "FEASIBLE_CHOICE_V1" },
			{
				trailer: {
					...exact,
					prompt: "A whole request must stay in the client",
				},
			},
		])
			expect(
				generationTaskParametersSchema.safeParse({ ...parameters, ...override })
					.success,
			).toBe(false);
	});
});

describe("grounded trailer compilation", () => {
	it("opens with context, fits exactly, and excludes a cold-open outcome and final point", () => {
		const f = fixture([
			"OUTCOME",
			"ACTION",
			"CONTEXT",
			"ACTION",
			"CHANGE",
			"POINT",
		]);
		const result = selectLocalStoryTrailer({ ...f, trailer: exact });
		expect(result.blueprint.beats.map((beat) => beat.role)).toEqual([
			"CONTEXT",
			"ACTION",
			"CHANGE",
		]);
		expect(result.selection.actualDurationFrames).toBe(900);
		expect(result.windows).toEqual(
			[20, 30, 40].map((seconds) => ({
				sourceInUs: f.origin + seconds * 1_000_000,
				durationFrames: 300,
			})),
		);
	});

	it.each([
		"EXACT",
		"TARGET",
	] as const)("uses four 7.5-second beats for a 30-second %s request", (durationMode) => {
		const f = fixture(
			["CONTEXT", "ACTION", "ACTION", "CHANGE", "OUTCOME"],
			225,
		);
		const result = selectLocalStoryTrailer({
			...f,
			trailer: { ...exact, durationMode },
		});
		expect(result.selection.actualDurationFrames).toBe(900);
		expect(result.blueprint.beats).toHaveLength(4);
		expect(result.windows).toEqual(
			[0, 1, 2, 3].map((index) => ({
				sourceInUs: f.origin + index * 7_500_000,
				durationFrames: 225,
			})),
		);
	});

	it("excludes an entire disclosed reference also used by an action", () => {
		const f = fixture(["CONTEXT", "ACTION", "CONTEXT", "CHANGE"]);
		f.ledger.events.push({
			...fixtureItem(f.ledger.events[1]),
			id: "reveal",
			role: "OUTCOME",
		});
		const result = selectLocalStoryTrailer({ ...f, trailer: target });
		expect(result.windows.map((window) => window.sourceInUs)).not.toContain(
			f.origin + 10_000_000,
		);
		expect(result.selection.localStorySelection.selectedEventIds).not.toContain(
			"e1",
		);
	});

	it("does not use overlapping unclassified footage or a mixed event without AISA for each shot", () => {
		const f = fixture(["CONTEXT", "ACTION", "CHANGE", "ACTION", "CHANGE"]);
		f.ledger.events.splice(2, 1);
		// An unclassified shot overlaps the last frame of an action.
		fixtureItem(f.input.shots[2]).fromFrame--;
		const audioOnlyShot = fixtureItem(f.input.shots[4]);
		fixtureItem(audioOnlyShot.fields[0]).kind = "ASR";
		const action = fixtureItem(
			f.ledger.events.find((event) => event.id === "e3"),
		);
		action.refs.push(audioOnlyShot.ref);
		action.quotes.push({ ref: audioOnlyShot.ref, quote: audioOnlyShot.text });
		const result = selectLocalStoryTrailer({ ...f, trailer: target });
		expect(result.windows.map((window) => window.sourceInUs)).toEqual([
			f.origin,
		]);
	});

	it("disallows speech tails crossing into a forbidden or uncertain shot", () => {
		const f = fixture(["CONTEXT", "ACTION", "OUTCOME", "ACTION", "CHANGE"]);
		fixtureItem(f.ledger.events[4]).uncertainty = "Unclear onscreen cue";
		f.input.segments.push({
			startUs: f.origin + 19_000_000,
			endUs: f.origin + 21_000_000,
			text: "An utterance continuing into the reveal",
		});
		const result = selectLocalStoryTrailer({ ...f, trailer: target });
		expect(result.selection.actualDurationFrames).toBe(600);
		expect(result.windows.map((window) => window.sourceInUs)).toEqual([
			f.origin,
			f.origin + 30_000_000,
		]);
		expect(() => selectLocalStoryTrailer({ ...f, trailer: exact })).toThrow(
			"LOCAL_TRAILER_EXACT_DURATION_UNAVAILABLE",
		);
	});

	it("retains an untranscribed speech interval across contiguous allowed shots", () => {
		const f = fixture(["CONTEXT", "ACTION", "OUTCOME"]);
		const result = selectLocalStoryTrailer({
			...f,
			input: {
				...f.input,
				speechIntervals: [
					{ startUs: f.origin + 9_000_000, endUs: f.origin + 11_000_000 },
				],
			},
			trailer: exact,
			targetDurationFrames: 330,
		});
		expect(result.selection.actualDurationFrames).toBe(330);
		expect(result.windows).toEqual([
			{ sourceInUs: f.origin, durationFrames: 300 },
			{ sourceInUs: f.origin + 10_000_000, durationFrames: 30 },
		]);
		expect(result.selection.reasonCodes).toContain(
			"COMPLETE_UTTERANCE_BOUNDARIES",
		);
	});

	it("honors setup-only and requires evidenced opening context", () => {
		const f = fixture(["CONTEXT", "ACTION", "CHANGE", "OUTCOME"]);
		const result = selectLocalStoryTrailer({
			...f,
			trailer: { durationMode: "UP_TO", disclosure: "SETUP_ONLY" },
		});
		expect(result.selection.actualDurationFrames).toBe(300);
		expect(result.blueprint.beats.map((beat) => beat.role)).toEqual([
			"CONTEXT",
		]);
		expect(() =>
			selectLocalStoryTrailer({
				...fixture(["ACTION", "OUTCOME", "POINT"]),
				trailer: target,
			}),
		).toThrow("LOCAL_TRAILER_NO_FITTING_PLAN");
	});
});
