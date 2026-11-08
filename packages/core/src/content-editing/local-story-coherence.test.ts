import { expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	localStoryBlueprintCoherenceIssues,
	localStorySelectedPlanIssues,
} from "./local-story-coherence";
import type {
	LocalStoryBlueprint,
	LocalStoryCorpus,
} from "./local-story-contracts";
import { buildLocalStoryInput } from "./local-story-input";
import { cfrTimeMapSchema } from "./schema";

function fixtureItem<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture");
	return value;
}

function fixture() {
	const sceneId = "11111111-1111-4111-8111-111111111111";
	const texts = [
		"The robot starts repair.",
		"The repair is progressing.",
		"The repair is complete.",
		"The repair is 100% complete.",
	];
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 20,
		scenes: [
			{
				id: sceneId,
				startInSeconds: 0,
				endInSeconds: 20,
				shots: texts.map((text, index) => ({
					startInSeconds: index * 5,
					endInSeconds: index * 5 + 5,
					detailedDescription: text,
					mainSubjects: [],
				})),
			},
		],
	});
	const map = cfrTimeMapSchema.parse({
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 20_000_000,
		editingStartFrame: 0,
		editingEndFrame: 600,
		fps: { num: 30, den: 1 },
	});
	const input = buildLocalStoryInput({ analysis, timeMap: map });
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		coveredRefs: ["s0", "s1", "s2", "s3"],
		summaries: ["Repair"],
		events: texts.map((text, index) => ({
			id: `e${index}`,
			role: index === 0 ? "CONTEXT" : index === 1 ? "CHANGE" : "OUTCOME",
			label: text,
			refs: [`s${index}`],
			quotes: [{ ref: `s${index}`, quote: text }],
			subjects: ["robot"],
			uncertainty: "",
		})),
	};
	const blueprint: LocalStoryBlueprint = {
		mode: "FLOW",
		message: "修理を開始し、修理が完了する。",
		beats: [
			{ id: "start", role: "CONTEXT", eventIds: ["e0"], requires: [] },
			{
				id: "end",
				role: "OUTCOME",
				eventIds: ["e2", "e3"],
				requires: ["start"],
			},
		],
		uncertainty: "",
	};
	const selection = {
		localStorySelection: {
			selectedBeatIds: ["start", "end"],
			selectedEventIds: ["e0", "e2"],
			reason: "COMPLETE_BEATS" as const,
		},
		clips: [
			{ sceneId, shotIndex: 0, sourceInUs: 0, durationFrames: 150 },
			{ sceneId, shotIndex: 2, sourceInUs: 10_000_000, durationFrames: 150 },
		],
		actualDurationFrames: 300,
		requestedDurationFrames: 450,
	};
	return { input, ledger, blueprint, selection };
}
it("requires an explicit context path for every later FLOW beat without imposing causal links on THEME", () => {
	const f = fixture();
	fixtureItem(f.blueprint.beats[1]).requires = [];
	expect(localStoryBlueprintCoherenceIssues(f.blueprint)).toContainEqual(
		expect.objectContaining({ code: "CONTEXT_DEPENDENCY_MISSING" }),
	);
	f.blueprint.mode = "THEME";
	expect(localStoryBlueprintCoherenceIssues(f.blueprint)).toEqual([]);
});
it("rejects an ending number supported only by an unselected alternative while retaining the raw message", () => {
	const f = fixture();
	f.blueprint.message = "修理が100%完了する。";
	const before = structuredClone(f.blueprint);
	expect(localStorySelectedPlanIssues(f)).toContainEqual(
		expect.objectContaining({ code: "SELECTED_MESSAGE_NUMBER_UNSUPPORTED" }),
	);
	expect(f.blueprint).toEqual(before);
	f.selection.localStorySelection.selectedEventIds[1] = "e3";
	fixtureItem(f.selection.clips[1]).sourceInUs = 15_000_000;
	fixtureItem(f.selection.clips[1]).shotIndex = 3;
	expect(localStorySelectedPlanIssues(f)).toEqual([]);
});
it("detects a missing premise or truncated quote even when the event IDs are still declared selected", () => {
	const f = fixture();
	expect(localStorySelectedPlanIssues(f)).toEqual([]);
	fixtureItem(f.selection.clips[0]).sourceInUs = 1_000_000;
	fixtureItem(f.selection.clips[0]).durationFrames = 120;
	f.selection.actualDurationFrames = 270;
	expect(localStorySelectedPlanIssues(f)).toContainEqual(
		expect.objectContaining({
			code: "SELECTED_QUOTE_NOT_COVERED",
			eventId: "e0",
			ref: "s0",
		}),
	);
});
