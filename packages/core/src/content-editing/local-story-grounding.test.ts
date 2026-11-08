import { describe, expect, it } from "vitest";
import {
	type LocalStoryEvent,
	localStoryRoleSchema,
} from "./local-story-contracts";
import { validateLocalStoryBlueprint } from "./local-story-input";
import { describeLocalStorySelection } from "./local-story-planner";

const observed = (
	id: string,
	role: LocalStoryEvent["role"],
	label: string,
): LocalStoryEvent => ({
	id,
	role,
	label,
	refs: ["s0"],
	quotes: [{ ref: "s0", quote: label }],
	subjects: [],
	uncertainty: "",
});

function historicalEvidence() {
	return {
		version: "local-story-evidence-v1",
		method: "LOCAL_LLM_BEAT_PLAN",
		model: {
			version: "local-story-model-v1",
			provider: "LOCAL_OLLAMA",
			profile: "nvidia",
			model: "qwen3.8:27b-q8_0",
			modelDigest: "a".repeat(64),
			runtimeVersion: "0.40.14",
			promptVersion: "local-story-v1",
			schemaHash: "b".repeat(64),
			configId: "11111111-1111-4111-8111-111111111111",
			context: 8192,
			thinking: false,
		},
		inputHash: "a".repeat(64),
		artifactHash: "a".repeat(64),
		ledgerHash: "a".repeat(64),
		blueprintHash: "a".repeat(64),
		ledger: {
			version: "local-story-corpus-v1",
			summaries: ["Observed operation"],
			coveredRefs: ["s0"],
			events: [
				observed("complete", "OUTCOME", "100% complete"),
				observed("action", "ACTION", "Robotic arm approaches the man"),
			],
		},
		blueprint: {
			mode: "FLOW",
			message: "Memory overwrite is 100% complete.",
			beats: [
				{
					id: "result",
					role: "OUTCOME",
					eventIds: ["complete", "action"],
					requires: [],
				},
			],
			uncertainty: "",
		},
		selection: {
			selectedBeatIds: ["result"],
			selectedEventIds: ["action"],
			reason: "COMPLETE_BEATS",
		},
		inputCoverage: {
			totalShots: 1,
			eligibleShots: 1,
			processedShots: 1,
			excludedShots: 0,
			truncated: false,
		},
	};
}

describe("selected story grounding", () => {
	it("describes only the selected event while preserving the historical native proposal", () => {
		const evidence = historicalEvidence();
		const before = structuredClone(evidence);
		const description = describeLocalStorySelection(evidence);
		expect(description).toMatchObject({
			mode: "FLOW",
			events: [
				{
					beatId: "result",
					eventId: "action",
					role: "ACTION",
					declaredRole: "OUTCOME",
					roleMatchesBeat: false,
					label: "Robotic arm approaches the man",
					refs: ["s0"],
					quotes: [{ ref: "s0", quote: "Robotic arm approaches the man" }],
				},
			],
		});
		expect(description.events).toHaveLength(1);
		expect(description).not.toHaveProperty("message");
		expect(JSON.stringify(description)).not.toContain("100%");
		expect(evidence).toEqual(before);
		const quote = description.events[0]?.quotes[0];
		if (!quote) throw new Error("Missing selected quote");
		quote.quote = "changed view";
		expect(evidence).toEqual(before);
	});

	it("rejects a forged selection instead of displaying an unselected claim", () => {
		const evidence = historicalEvidence();
		evidence.selection.selectedEventIds = ["unknown"];
		expect(() => describeLocalStorySelection(evidence)).toThrow();
	});

	it.each([
		"ACTION",
		"CHANGE",
	] as const)("rejects a %s alternative for a completed OUTCOME", (role) => {
		const complete = observed("complete", "OUTCOME", "100% complete");
		const differentState = observed("other", role, "Memory process");
		expect(() =>
			validateLocalStoryBlueprint({
				ledger: { events: [complete, differentState] },
				blueprint: {
					mode: "FLOW",
					message: "Memory overwrite is 100% complete.",
					beats: [
						{
							id: "result",
							role: "OUTCOME",
							eventIds: ["complete", "other"],
							requires: [],
						},
					],
					uncertainty: "",
				},
			}),
		).toThrow("LOCAL_STORY_BLUEPRINT_ROLE_MISMATCH");
	});

	it.each(
		localStoryRoleSchema.options,
	)("retains alternatives whose role matches the %s beat", (role) => {
		const events = [
			observed("first", role, "Observed first"),
			observed("second", role, "Observed second"),
		];
		expect(
			validateLocalStoryBlueprint({
				ledger: { events },
				blueprint: {
					mode: "THEME",
					message: "Observed scene",
					beats: [
						{ id: "beat", role, eventIds: ["first", "second"], requires: [] },
					],
					uncertainty: "",
				},
			}).beats[0]?.eventIds,
		).toEqual(["first", "second"]);
	});
});
