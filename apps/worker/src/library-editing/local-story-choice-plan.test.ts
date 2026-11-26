import {
	buildFeasibleStoryChoices,
	cfrTimeMapSchema,
	compileFeasibleStoryChoice,
	hashEditingEvidence,
	type LocalStoryCorpus,
	type LocalStoryInput,
	selectLocalStoryClips,
	sliceFeasibleStoryChoices,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { prepareLocalStoryChoicePrompts } from "./local-story-choice-plan";
import { localBlueprintPrompt } from "./local-story-prompts";

function fixture(count = 12) {
	const frames = 120;
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
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "Source",
		description: "Observed events.",
		timeMap,
		timeMapHash: hashEditingEvidence(timeMap),
		scenes: [],
		segments: [],
		coverage: Array.from({ length: count }, (_, index) => ({
			ref: `s${index}`,
			status: "ELIGIBLE",
		})),
		shots: Array.from({ length: count }, (_, index) => ({
			ref: `s${index}`,
			sceneId: "sceneA",
			fromFrame: index * frames,
			toFrame: (index + 1) * frames,
			text: `Observed action ${index}.`,
			fields: [
				{
					kind: "AISA",
					pointer: `/shots/${index}`,
					text: `Observed action ${index}.`,
				},
			],
		})),
	};
	const roles = ["CONTEXT", "ACTION", "CHANGE", "OUTCOME", "POINT"] as const;
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: ["Observed events."],
		coveredRefs: input.shots.map((shot) => shot.ref),
		events: input.shots.map((shot, index) => ({
			id: `l${index}_e0`,
			role: roles[index % roles.length] ?? "ACTION",
			label: shot.text,
			refs: [shot.ref],
			quotes: [{ ref: shot.ref, quote: shot.text }],
			subjects: ["e\u0301", "é", "bag"],
			uncertainty: "",
		})),
	};
	return {
		full: { input, ledger },
		mode: "FLOW" as const,
		targetDurationFrames: 900,
	};
}
function data(prompt: string) {
	return JSON.parse(prompt.slice(prompt.indexOf("\nDATA\n") + 6));
}

describe("bounded all-card feasible-choice prompts", () => {
	it("offers source-ordered whole plans when a later change makes an earlier outcome impossible", () => {
		const f = fixture(4);
		const { input, ledger } = f.full;
		input.timeMap.sourceEndUs = 30_000_000;
		input.timeMap.editingEndFrame = 900;
		input.timeMapHash = hashEditingEvidence(input.timeMap);
		const spans = [
			[0, 75],
			[100, 389],
			[500, 555],
			[600, 719],
		] as const;
		const roles = ["CONTEXT", "ACTION", "OUTCOME", "CHANGE"] as const;
		for (const [index, shot] of input.shots.entries()) {
			const span = spans[index],
				event = ledger.events[index];
			if (!span || !event) throw new Error("Invalid chronology fixture");
			[shot.fromFrame, shot.toFrame] = span;
			event.role = roles[index] ?? "ACTION";
		}
		const impossible = {
			mode: "FLOW" as const,
			message: "出来事を紹介する。",
			uncertainty: "",
			beats: [0, 1, 3, 2].map((index, position) => {
				const event = ledger.events[index];
				if (!event) throw new Error("Invalid chronology fixture");
				return {
					id: `b${position + 1}`,
					role: event.role,
					eventIds: [event.id],
					requires: position ? [`b${position}`] : [],
				};
			}),
		};
		// The captured failure fits in time, but its last mandatory beat goes backwards.
		expect(spans.reduce((sum, [from, to]) => sum + to - from, 0)).toBe(538);
		expect(
			selectLocalStoryClips({
				input,
				ledger,
				blueprint: { ...impossible, beats: impossible.beats.slice(0, 3) },
				targetDurationFrames: 900,
			}).actualDurationFrames,
		).toBe(483);
		expect(() =>
			selectLocalStoryClips({
				input,
				ledger,
				blueprint: impossible,
				targetDurationFrames: 900,
			}),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
		const before = structuredClone(f);
		const prepared = prepareLocalStoryChoicePrompts(f);
		expect(prepared.choices.plans.length).toBeGreaterThan(0);
		for (const prompt of prepared.prompts) {
			expect(data(prompt).cards).toHaveLength(4);
			expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(6656);
		}
		for (const plan of prepared.choices.plans) {
			const { selection } = compileFeasibleStoryChoice({
				input,
				ledger,
				choices: prepared.choices,
				requestedMode: f.mode,
				choice: {
					planId: plan.id,
					message: impossible.message,
					uncertainty: "",
				},
			});
			expect(selection.requestedDurationFrames).toBe(900);
			expect(selection.actualDurationFrames).toBeGreaterThan(0);
			expect(selection.actualDurationFrames).toBeLessThanOrEqual(900);
			const order = selection.localStorySelection.selectedEventIds.map((id) =>
				ledger.events.findIndex((event) => event.id === id),
			);
			expect(order).toEqual([...order].sort((a, b) => a - b));
		}
		expect(f).toEqual(before);
	});
	it("retains all 52 exact cards, source order and Unicode strings while presenting only complete plan IDs", () => {
		const f = fixture(52),
			before = structuredClone(f),
			prepared = prepareLocalStoryChoicePrompts(f);
		const flat = data(
			localBlueprintPrompt({
				...f.full,
				mode: f.mode,
				targetDurationFrames: f.targetDurationFrames,
			}),
		);
		for (const prompt of prepared.prompts) {
			const wire = data(prompt);
			const control = prompt.slice(0, prompt.indexOf("\nDATA\n"));
			const quantityPolicy =
				"no quantities/counts/dates/days/durations/measurements in any notation, even if evidenced";
			expect(control).toContain("selected actions/relations only");
			expect(control).toContain(quantityPolicy);
			expect(control).toContain("App handles numbers/timing");
			if (wire.repair) {
				expect(wire.repair).toContain("selected actions/relations only");
				expect(wire.repair).toContain(quantityPolicy);
				expect(wire.repair).toContain("App handles numbers/timing");
			}
			// Keep the control text no larger than the predecessor base + repair.
			expect(
				Buffer.byteLength(control) + Buffer.byteLength(wire.repair ?? ""),
			).toBeLessThanOrEqual(768 + (wire.repair ? 213 : 0));
			expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(6656);
			expect(wire.cards).toHaveLength(52);
			expect(
				wire.cards.map((row: unknown[], index: number) => [
					f.full.ledger.events[index]?.id,
					wire.r[row[1] as number],
					row[2],
					(row[3] as number[]).map((i) => wire.s[i]),
					row[4],
					row[5],
				]),
			).toEqual(flat.events);
			expect(wire.cards[0][0]).toBe("a");
			expect(wire.cards[51][0]).toBe("Z");
			expect(wire.s).toContain("e\u0301");
			expect(wire.s).toContain("é");
			expect(wire.plans.map((plan: unknown[]) => plan[0])).toEqual(
				prepared.choices.plans.map((plan) => plan.id),
			);
			expect(prompt).toContain("Return JSON only: planId,message");
		}
		expect(prepared.choices.hash).toBe(
			sliceFeasibleStoryChoices(
				buildFeasibleStoryChoices({
					...f.full,
					mode: f.mode,
					targetDurationFrames: f.targetDurationFrames,
					maxPlans: 24,
					maxEvaluations: 20_000,
				}),
				prepared.choices.plans.length,
			).hash,
		);
		expect(f).toEqual(before);
	});
	it("reduces only the verified plan prefix and rebinds its hash when all-card input approaches capacity", () => {
		const f = fixture();
		for (const [index, event] of f.full.ledger.events.entries()) {
			event.label = event.label.padEnd(100, "x");
			event.subjects = Array.from({ length: 4 }, (_, subject) =>
				`subject-${index}-${subject}-`.padEnd(78, "x"),
			);
		}
		const before = structuredClone(f),
			prepared = prepareLocalStoryChoicePrompts(f);
		expect(prepared.choices.plans.length).toBeGreaterThan(0);
		expect(prepared.choices.plans.length).toBeLessThan(prepared.totalPlans);
		expect(
			prepared.prompts.every((prompt) => Buffer.byteLength(prompt) <= 6656),
		).toBe(true);
		for (const prompt of prepared.prompts)
			expect(data(prompt).cards).toHaveLength(12);
		const full = buildFeasibleStoryChoices({
			...f.full,
			mode: f.mode,
			targetDurationFrames: f.targetDurationFrames,
			maxPlans: 24,
			maxEvaluations: 20_000,
		});
		expect(prepared.choices.plans).toEqual(
			full.plans.slice(0, prepared.choices.plans.length),
		);
		expect(prepared.choices.hash).not.toBe(full.hash);
		expect(f).toEqual(before);
	});
	it("rejects an oversized all-card source rather than dropping evidence or increasing the limit", () => {
		const f = fixture(52);
		for (const [index, event] of f.full.ledger.events.entries()) {
			event.label = "観測された場面".repeat(10);
			event.subjects = Array.from({ length: 4 }, (_, subject) =>
				`subject-${index}-${subject}-`.padEnd(80, "x"),
			);
		}
		const before = structuredClone(f);
		expect(() => prepareLocalStoryChoicePrompts(f)).toThrow(
			"LOCAL_STORY_CONTEXT_LIMIT",
		);
		expect(f).toEqual(before);
	});
	it("stops before native work when no complete plan fits", () => {
		expect(() =>
			prepareLocalStoryChoicePrompts({
				...fixture(),
				targetDurationFrames: 30,
			}),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
	});
});
