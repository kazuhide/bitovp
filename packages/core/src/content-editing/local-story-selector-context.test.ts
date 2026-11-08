import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	LocalStorySelectionDescription as PublicDescription,
	LocalStorySelectionResult as PublicResult,
} from "../index";
import * as publicCore from "../index";
import * as publicEditing from "./index";
import type {
	LocalStoryBlueprint,
	LocalStoryCorpus,
	LocalStoryInput,
} from "./local-story-contracts";
import {
	createLocalStoryClipSelector,
	describeLocalStorySelection,
	type LocalStorySelectionDescription,
	type LocalStorySelectionResult,
	localStoryEventMinimumDurationFrames,
	selectLocalStoryClips,
} from "./local-story-planner";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

function fixture(origin = 1_000_000) {
	const timeMap = cfrTimeMapSchema.parse({
		id: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "22222222-2222-4222-8222-222222222222",
		kind: "CFR",
		sourceStartUs: origin,
		sourceEndUs: origin + 8_000_000,
		editingStartFrame: 17,
		editingEndFrame: 257,
		fps: { num: 30, den: 1 },
	});
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "Observed source",
		description: "",
		timeMap,
		timeMapHash: hashEditingEvidence(timeMap),
		scenes: [],
		segments: [],
		coverage: Array.from({ length: 4 }, (_, i) => ({
			ref: `s${i}`,
			status: "ELIGIBLE" as const,
		})),
		shots: Array.from({ length: 4 }, (_, i) => ({
			ref: `s${i}`,
			sceneId: "sceneA",
			fromFrame: i * 60,
			toFrame: (i + 1) * 60,
			text: `Observed moment ${i}.`,
			fields: [
				{
					kind: "AISA" as const,
					pointer: `/shots/${i}`,
					text: `Observed moment ${i}.`,
				},
			],
		})),
	};
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: ["Observed events."],
		coveredRefs: input.shots.map((s) => s.ref),
		events: input.shots.map((shot, i) => ({
			id: `l${i}_e0`,
			role: "ACTION" as const,
			label: shot.text,
			refs: [shot.ref],
			quotes: [{ ref: shot.ref, quote: shot.text }],
			subjects: ["bag"],
			uncertainty: "",
		})),
	};
	const blueprint: LocalStoryBlueprint = {
		mode: "FLOW",
		message: "出来事を紹介する。",
		uncertainty: "",
		beats: [0, 1].map((i) => ({
			id: `b${i}`,
			role: "ACTION" as const,
			eventIds: [`l${i}_e0`],
			requires: i ? ["b0"] : [],
		})),
	};
	return { input, ledger, blueprint, targetDurationFrames: 120 };
}

describe("private source context for one feasible-choice search", () => {
	it("preserves the public planner API without exposing the private search context", () => {
		for (const api of [publicCore, publicEditing]) {
			expect(api.describeLocalStorySelection).toBe(describeLocalStorySelection);
			expect(api.localStoryEventMinimumDurationFrames).toBe(
				localStoryEventMinimumDurationFrames,
			);
			expect(api.selectLocalStoryClips).toBe(selectLocalStoryClips);
			expect(api).not.toHaveProperty("createLocalStoryClipSelector");
		}
		expectTypeOf<PublicDescription>().toEqualTypeOf<LocalStorySelectionDescription>();
		expectTypeOf<PublicResult>().toEqualTypeOf<LocalStorySelectionResult>();
	});

	it("detaches source/corpus aliases and protects cached spans from returned-output mutation", () => {
		const f = fixture(),
			select = createLocalStoryClipSelector(f);
		const expected = selectLocalStoryClips(f);
		expect(expected.clips).toEqual([
			{ sceneId: "sceneA", sourceInUs: 1_000_000, durationFrames: 60 },
			{ sceneId: "sceneA", sourceInUs: 3_000_000, durationFrames: 60 },
		]);
		const first = select(f);
		expect(first).toEqual(expected);
		const shot = f.input.shots[0],
			event = f.ledger.events[0],
			clip = first.clips[0];
		const field = shot?.fields[0];
		if (!shot || !event?.quotes[0] || !clip || !field)
			throw new Error("Missing fixture item");
		shot.fromFrame = 900;
		field.text = "FORGED SOURCE";
		f.input.timeMap.sourceStartUs = 30_000_000;
		event.quotes[0].quote = "FORGED QUOTE";
		event.role = "OUTCOME";
		clip.durationFrames = 1;
		first.localStorySelection.selectedEventIds.length = 0;
		expect(
			select({ blueprint: f.blueprint, targetDurationFrames: 120 }),
		).toEqual(expected);
		expect(() => createLocalStoryClipSelector(f)).toThrow();
		expect(() => selectLocalStoryClips(f)).toThrow();
	});

	it("validates every candidate after warm-up, including roles, references, dependencies and target", () => {
		const f = fixture(),
			select = createLocalStoryClipSelector(f);
		expect(select(f).actualDurationFrames).toBe(120);
		for (const change of [
			"role",
			"reference",
			"dependency",
			"duplicate",
		] as const) {
			const blueprint = structuredClone(f.blueprint);
			const first = blueprint.beats[0],
				second = blueprint.beats[1];
			if (!first || !second) throw new Error("Missing fixture beat");
			if (change === "role") first.role = "OUTCOME";
			if (change === "reference") first.eventIds = ["l999_e0"];
			if (change === "dependency") first.requires = [second.id];
			if (change === "duplicate") second.id = first.id;
			expect(() => select({ blueprint, targetDurationFrames: 120 })).toThrow();
		}
		for (const targetDurationFrames of [0, 5401, 1.5])
			expect(() =>
				select({ blueprint: f.blueprint, targetDurationFrames }),
			).toThrow("LOCAL_STORY_DURATION_INVALID");
		expect(() =>
			select({ blueprint: f.blueprint, targetDurationFrames: 119 }),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
		expect(select(f)).toEqual(selectLocalStoryClips(f));
	});

	it("keeps snapshots isolated across independent searches with identical event IDs", () => {
		const a = fixture(),
			b = fixture(20_000_000);
		const first = createLocalStoryClipSelector(a),
			second = createLocalStoryClipSelector(b);
		const expectedA = selectLocalStoryClips(a),
			expectedB = selectLocalStoryClips(b);
		expect(first(a)).toEqual(expectedA);
		expect(second(b)).toEqual(expectedB);
		expect(expectedA.clips[0]?.sourceInUs).toBe(1_000_000);
		expect(expectedB.clips[0]?.sourceInUs).toBe(20_000_000);
		expect(first(a)).toEqual(expectedA);
	});

	it("rejects an unsupported quotation at context admission instead of trusting typed corpus input", () => {
		const f = fixture();
		const quote = f.ledger.events[0]?.quotes[0];
		if (!quote) throw new Error("Missing fixture quote");
		quote.quote = "An unobserved event.";
		expect(() => createLocalStoryClipSelector(f)).toThrow(
			"LOCAL_STORY_EVIDENCE_INVALID",
		);
	});
});
