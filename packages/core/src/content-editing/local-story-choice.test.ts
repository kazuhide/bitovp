import { describe, expect, it } from "vitest";
import { generationTaskParametersSchema } from "../content-production/schema";
import {
	buildFeasibleStoryChoices,
	compileFeasibleStoryChoice,
	localStoryChoiceSchema,
	sliceFeasibleStoryChoices,
} from "./local-story-choice";
import {
	localStoryBlueprintCoherenceIssues,
	localStorySelectedPlanIssues,
} from "./local-story-coherence";
import type {
	LocalStoryCorpus,
	LocalStoryInput,
} from "./local-story-contracts";
import { validateLocalStoryBlueprint } from "./local-story-input";
import { selectLocalStoryClips } from "./local-story-planner";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

function fixture(count = 8, frames = 240) {
	const timeMap = cfrTimeMapSchema.parse({
		id: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "22222222-2222-4222-8222-222222222222",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: (count * frames * 1_000_000) / 30,
		editingStartFrame: 0,
		editingEndFrame: count * frames,
		fps: { num: 30, den: 1 },
	});
	const roles = ["CONTEXT", "ACTION", "CHANGE", "OUTCOME"] as const;
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "Source",
		description: "Observed events.",
		timeMap,
		timeMapHash: hashEditingEvidence(timeMap),
		scenes: [],
		segments: [],
		coverage: Array.from({ length: count }, (_, i) => ({
			ref: `s${i}`,
			status: "ELIGIBLE",
		})),
		shots: Array.from({ length: count }, (_, i) => ({
			ref: `s${i}`,
			sceneId: i < count / 2 ? "sceneA" : "sceneB",
			fromFrame: i * frames,
			toFrame: (i + 1) * frames,
			text: `Observed moment ${i}.`,
			fields: [
				{ kind: "AISA", pointer: `/shots/${i}`, text: `Observed moment ${i}.` },
			],
		})),
	};
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: ["Observed events."],
		coveredRefs: input.shots.map((s) => s.ref),
		events: input.shots.map((shot, i) => ({
			id: `l${i}_e0`,
			role: roles[i % 4] ?? "ACTION",
			label: shot.text,
			refs: [shot.ref],
			quotes: [{ ref: shot.ref, quote: shot.text }],
			subjects: [i < count / 2 ? "Alice" : "Bob", "bag"],
			uncertainty: "",
		})),
	};
	return { input, ledger, mode: "FLOW" as const, targetDurationFrames: 900 };
}

describe("feasible whole-story choices", () => {
	it("retains source-spanning choices with52events under the default work ceiling", () => {
		const f = fixture(52),
			choices = buildFeasibleStoryChoices(f);
		expect(choices.plans).toHaveLength(24);
		expect(choices.diagnostics.evaluated).toBeLessThanOrEqual(20_000);
		const ordinals = choices.plans.flatMap((p) =>
			p.eventIds.map((id) => f.ledger.events.findIndex((e) => e.id === id)),
		);
		expect(Math.min(...ordinals)).toBeLessThan(8);
		expect(Math.max(...ordinals)).toBeGreaterThanOrEqual(44);
		expect(choices.plans.every((p) => p.actualDurationFrames >= 720)).toBe(
			true,
		);
	});
	it("permits five complete beats at60seconds while bounding30seconds to three", () => {
		const f = fixture(8, 330);
		const longer = buildFeasibleStoryChoices({
			...f,
			targetDurationFrames: 1800,
		});
		expect(longer.plans.some((p) => p.eventIds.length === 5)).toBe(true);
		expect(longer.plans.every((p) => p.eventIds.length <= 5)).toBe(true);
		expect(
			buildFeasibleStoryChoices(f).plans.every((p) => p.eventIds.length <= 3),
		).toBe(true);
	});
	it("returns deterministic diverse whole plans proven by every existing guard", () => {
		const f = fixture(),
			before = structuredClone(f),
			choices = buildFeasibleStoryChoices(f);
		expect(choices).toEqual(buildFeasibleStoryChoices(f));
		expect(choices.plans.length).toBeGreaterThan(1);
		expect(choices.plans.length).toBeLessThanOrEqual(24);
		expect(choices.plans[0]?.actualDurationFrames).toBeGreaterThanOrEqual(720);
		expect(
			new Set(
				choices.plans.flatMap((p) =>
					p.eventIds.map(
						(id) => f.ledger.events.find((e) => e.id === id)?.subjects[0],
					),
				),
			),
		).toEqual(new Set(["Alice", "Bob"]));
		for (const plan of choices.plans) {
			const blueprint = {
				...plan.blueprintSkeleton,
				message: "出来事を紹介する。",
				uncertainty: "",
			};
			expect(
				validateLocalStoryBlueprint({ ledger: f.ledger, blueprint }),
			).toEqual(blueprint);
			expect(localStoryBlueprintCoherenceIssues(blueprint)).toEqual([]);
			expect(selectLocalStoryClips({ ...f, blueprint })).toEqual(
				plan.selection,
			);
			expect(
				localStorySelectedPlanIssues({
					...f,
					blueprint,
					selection: plan.selection,
				}),
			).toEqual([]);
			expect(plan.blueprintSkeleton.beats).toHaveLength(plan.eventIds.length);
		}
		expect(f).toEqual(before);
	});
	it("does not reject a legal overlapping footprint by summing per-event minima", () => {
		const f = fixture(1),
			event = f.ledger.events[0];
		if (!event) throw new Error("fixture");
		f.ledger.events.push({
			...structuredClone(event),
			id: "l1_e0",
			role: "ACTION",
		});
		f.targetDurationFrames = 240;
		const choices = buildFeasibleStoryChoices(f);
		expect(
			choices.plans.some(
				(p) => p.eventIds.length === 2 && p.actualDurationFrames === 240,
			),
		).toBe(true);
	});
	it("includes both modes for AUTO and only FLOW for an explicit FLOW request", () => {
		expect(
			new Set(
				buildFeasibleStoryChoices({ ...fixture(), mode: "AUTO" }).plans.map(
					(p) => p.blueprintSkeleton.mode,
				),
			),
		).toEqual(new Set(["FLOW", "THEME"]));
		expect(
			buildFeasibleStoryChoices(fixture()).plans.every(
				(p) => p.blueprintSkeleton.mode === "FLOW",
			),
		).toBe(true);
	});
	it("bounds work, reports truncation and handles zero fitting plans deterministically", () => {
		const f = fixture();
		const choices = buildFeasibleStoryChoices({
			...f,
			maxEvaluations: 5,
			maxPlans: 2,
		});
		expect(choices.diagnostics.evaluated).toBeLessThanOrEqual(5);
		expect(choices.diagnostics.truncated).toBe(true);
		expect(choices.plans.length).toBeLessThanOrEqual(2);
		expect(
			buildFeasibleStoryChoices({ ...f, targetDurationFrames: 30 }).plans,
		).toEqual([]);
		expect(() =>
			buildFeasibleStoryChoices({ ...f, maxEvaluations: 0 }),
		).toThrow();
		expect(() => buildFeasibleStoryChoices({ ...f, maxPlans: 25 })).toThrow();
	});
	it("compiles only an intact member and repeats numeric/source/canonical checks", () => {
		const f = fixture(),
			choices = buildFeasibleStoryChoices(f),
			plan = choices.plans[0];
		if (!plan) throw new Error("fixture");
		const choice = {
			planId: plan.id,
			message: "出来事を紹介する。",
			uncertainty: "",
		};
		const compiled = compileFeasibleStoryChoice({
			...f,
			choices,
			choice,
			requestedMode: "FLOW",
		});
		expect(compiled.selection).toEqual(plan.selection);
		expect(compiled.blueprint.beats).toEqual(plan.blueprintSkeleton.beats);
		expect(() =>
			compileFeasibleStoryChoice({
				...f,
				choices,
				choice: { ...choice, planId: "p999" },
				requestedMode: "FLOW",
			}),
		).toThrow();
		expect(() =>
			compileFeasibleStoryChoice({
				...f,
				choices,
				choice: { ...choice, message: "777人が完了した。" },
				requestedMode: "FLOW",
			}),
		).toThrow();
		const tampered = structuredClone(choices);
		const first = tampered.plans[0];
		if (!first) throw new Error("fixture");
		first.actualDurationFrames++;
		expect(() =>
			compileFeasibleStoryChoice({
				...f,
				choices: tampered,
				choice,
				requestedMode: "FLOW",
			}),
		).toThrow();
		const foreign = structuredClone(f);
		const event = foreign.ledger.events[0];
		if (!event) throw new Error("fixture");
		event.subjects.push("foreign");
		expect(() =>
			compileFeasibleStoryChoice({
				...foreign,
				choices,
				choice,
				requestedMode: "FLOW",
			}),
		).toThrow();
		const sliced = sliceFeasibleStoryChoices(choices, 1);
		expect(sliced.hash).not.toBe(choices.hash);
		expect(sliced.plans).toEqual([plan]);
		expect(
			compileFeasibleStoryChoice({
				...f,
				choices: sliced,
				choice,
				requestedMode: "FLOW",
			}),
		).toEqual(compiled);
	});
	it("rejects changed owned beat structure even when a caller recomputes the public hash", () => {
		const f = fixture(),
			choices = buildFeasibleStoryChoices(f),
			first = choices.plans[0];
		if (!first?.blueprintSkeleton.beats[0]) throw new Error("fixture");
		const modified = structuredClone(choices),
			plan = modified.plans[0];
		if (!plan?.blueprintSkeleton.beats[0]) throw new Error("fixture");
		plan.blueprintSkeleton.beats[0].id = "renamed";
		const second = plan.blueprintSkeleton.beats[1];
		if (second) second.requires = ["renamed"];
		plan.selection.localStorySelection.selectedBeatIds[0] = "renamed";
		const { hash: _hash, ...data } = modified;
		modified.hash = hashEditingEvidence(data);
		expect(() =>
			compileFeasibleStoryChoice({
				...f,
				choices: modified,
				requestedMode: "FLOW",
				choice: { planId: first.id, message: "紹介する。", uncertainty: "" },
			}),
		).toThrow();
	});
	it("has a strict three-field native choice and additive old task parameters", () => {
		expect(
			localStoryChoiceSchema.parse({
				planId: "p0",
				message: "説明",
				uncertainty: "",
			}),
		).toEqual({ planId: "p0", message: "説明", uncertainty: "" });
		for (const bad of ["p01", "p-1", "p0\n", "FLOW"])
			expect(
				localStoryChoiceSchema.safeParse({
					planId: bad,
					message: "説明",
					uncertainty: "",
				}).success,
			).toBe(false);
		expect(
			localStoryChoiceSchema.safeParse({
				planId: "p0",
				message: "x".repeat(101),
				uncertainty: "",
			}).success,
		).toBe(false);
		expect(
			localStoryChoiceSchema.safeParse({
				planId: "p0",
				message: "説明",
				uncertainty: "",
				role: "ACTION",
			}).success,
		).toBe(false);
		const params = {
			contentId: "11111111-1111-4111-8111-111111111111",
			policy: "LOCAL_STORY",
			renderMode: "DRAFT",
			targetDurationFrames: 900,
		};
		expect(generationTaskParametersSchema.parse(params)).not.toHaveProperty(
			"storyPlanner",
		);
		expect(
			generationTaskParametersSchema.parse({
				...params,
				storyPlanner: "FEASIBLE_CHOICE_V1",
			}).storyPlanner,
		).toBe("FEASIBLE_CHOICE_V1");
		expect(
			generationTaskParametersSchema.safeParse({
				...params,
				policy: "AUTO",
				storyPlanner: "FEASIBLE_CHOICE_V1",
			}).success,
		).toBe(false);
	});
});
