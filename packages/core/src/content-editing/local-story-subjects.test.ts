import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import type { LocalStoryCorpus } from "./local-story-contracts";
import { buildLocalStoryInput } from "./local-story-input";
import { resolveLocalStorySubjects } from "./local-story-subjects";
import { cfrTimeMapSchema } from "./schema";

function fixtureItem<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture");
	return value;
}

const sceneId = "11111111-1111-4111-8111-111111111111";
function fixture(
	subjects = [
		{
			classification: "robot",
			description: "Repair robot",
			appearanceTimeInSeconds: 1,
			centerX: 25,
			centerY: 50,
			box2d: [300, 180, 700, 300],
		},
		{
			classification: "person",
			description: "Engineer",
			appearanceTimeInSeconds: 1,
			centerX: 37,
			centerY: 50,
			box2d: [300, 310, 700, 430],
		},
	],
) {
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 120,
		scenes: [
			{
				id: sceneId,
				startInSeconds: 100,
				endInSeconds: 110,
				shots: [
					{
						startInSeconds: 100,
						endInSeconds: 110,
						detailedDescription: "The repair robot helps an engineer.",
						mainSubjects: subjects,
					},
				],
			},
		],
	});
	const timeMap = cfrTimeMapSchema.parse({
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 100_000_000,
		sourceEndUs: 110_000_000,
		editingStartFrame: 0,
		editingEndFrame: 300,
		fps: { num: 30, den: 1 },
	});
	const input = buildLocalStoryInput({ analysis, timeMap });
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: ["Repair"],
		coveredRefs: ["s0"],
		events: [
			{
				id: "repair",
				label: "The robot helps",
				role: "ACTION",
				refs: ["s0"],
				quotes: [{ ref: "s0", quote: "The repair robot helps an engineer." }],
				subjects: ["robot"],
				uncertainty: "",
			},
		],
	};
	return {
		analysis,
		input,
		ledger,
		selection: {
			selectedBeatIds: ["b0"],
			selectedEventIds: ["repair"],
			reason: "COMPLETE_BEATS" as const,
		},
		geometry: {
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetWidth: 1080,
			targetHeight: 1920,
		},
	};
}

describe("selected story subjects grounded in AISA coordinates", () => {
	it("selects a key object among several subjects and keeps original source clock and stable target identity", () => {
		const f = fixture();
		const [target] = resolveLocalStorySubjects(f);
		expect(target).toMatchObject({
			ref: "s0",
			sceneId,
			shotIndex: 0,
			eventIds: ["repair"],
			subjectIndexes: [0],
			sourceAppearanceUs: 101_000_000,
			decision: "CROP",
		});
		expect(target?.protectedBoxes).toEqual([
			{ x: 0.18, y: 0.3, w: 0.12, h: 0.4 },
		]);
		expect(resolveLocalStorySubjects(f)[0]?.targetId).toBe(target?.targetId);
		expect(
			resolveLocalStorySubjects({
				...f,
				ledger: {
					...f.ledger,
					events: f.ledger.events.map((e) => ({ ...e, subjects: ["person"] })),
				},
			})[0]?.targetId,
		).not.toBe(target?.targetId);
	});
	it("protects all uniquely matched important regions and fits when their union exceeds vertical crop", () => {
		const f = fixture();
		fixtureItem(f.ledger.events[0]).subjects = ["robot", "person"];
		expect(resolveLocalStorySubjects(f)[0]).toMatchObject({
			decision: "CROP",
			subjectIndexes: [0, 1],
		});
		fixtureItem(
			fixtureItem(fixtureItem(f.analysis.scenes[0]).shots[0]).mainSubjects[1],
		).box2d = [300, 700, 700, 900];
		expect(resolveLocalStorySubjects(f)[0]).toMatchObject({
			decision: "FIT",
			reason: "PROTECTED_REGION_TOO_LARGE",
		});
	});
	it("does not promote substring, ASR-only names, missing boxes or ambiguous classifications to visual identity", () => {
		for (const label of ["Repair", "Alice", "robotic"]) {
			const f = fixture();
			fixtureItem(f.ledger.events[0]).subjects = [label];
			expect(resolveLocalStorySubjects(f)[0]).toMatchObject({
				decision: "FIT",
				reason: "SUBJECT_UNRESOLVED",
			});
		}
		const ambiguous = fixture();
		fixtureItem(
			fixtureItem(fixtureItem(ambiguous.analysis.scenes[0]).shots[0])
				.mainSubjects[1],
		).classification = "robot";
		expect(resolveLocalStorySubjects(ambiguous)[0]).toMatchObject({
			decision: "FIT",
			reason: "SUBJECT_AMBIGUOUS",
		});
		const noBox = fixture();
		delete fixtureItem(
			fixtureItem(fixtureItem(noBox.analysis.scenes[0]).shots[0])
				.mainSubjects[0],
		).box2d;
		expect(resolveLocalStorySubjects(noBox)[0]).toMatchObject({
			decision: "FIT",
			reason: "SUBJECT_BOX_MISSING",
		});
	});
	it("does not assume observations of different times describe one simultaneous group", () => {
		const f = fixture();
		fixtureItem(f.ledger.events[0]).subjects = ["robot", "person"];
		fixtureItem(
			fixtureItem(fixtureItem(f.analysis.scenes[0]).shots[0]).mainSubjects[1],
		).appearanceTimeInSeconds = 2;
		expect(resolveLocalStorySubjects(f)[0]).toMatchObject({
			decision: "FIT",
			reason: "SUBJECT_CLOCK_AMBIGUOUS",
		});
	});
});
