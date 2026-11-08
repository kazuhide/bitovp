import { describe, expect, it } from "vitest";
import { localStoryLedgerSchema } from "./local-story-contracts";
import {
	buildLocalStoryChunks,
	buildLocalStoryInput,
	mergeLocalStoryLedgers,
} from "./local-story-input";
import { selectLocalStoryClips } from "./local-story-planner";

function authoredInput() {
	let cursor = 0;
	const shots = [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 10].map(
		(duration, index) => {
			const from = cursor;
			cursor += duration;
			return {
				startInSeconds: from,
				endInSeconds: cursor,
				detailedDescription: `The dog crosses the room at scene ${index}.`,
				mainSubjects: [],
			};
		},
	);
	const analysis = {
		providerVersion: "authored-review",
		duration: cursor,
		title: "Alternatives",
		description: "An authored adversarial fixture",
		scenes: [
			{
				id: "11111111-1111-4111-8111-111111111111",
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: cursor,
				title: "Scene",
				summary: "The dog crosses the room.",
				shots,
			},
		],
	};
	const input = buildLocalStoryInput({
		analysis,
		timeMap: {
			id: "22222222-2222-4222-8222-222222222222",
			mediaVersionId: "33333333-3333-4333-8333-333333333333",
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: cursor * 1_000_000,
			editingStartFrame: 0,
			editingEndFrame: cursor * 30,
			fps: { num: 30, den: 1 },
		},
	});
	const ledger = {
		version: "local-story-corpus-v1",
		summaries: ["The dog crosses a room."],
		coveredRefs: input.shots.map((s) => s.ref),
		events: input.shots.map((s, i) => ({
			id: `e${i}`,
			label: "The dog crosses the room",
			role: "ACTION",
			refs: [s.ref],
			quotes: [{ ref: s.ref, quote: s.fields[0]?.text ?? "" }],
			subjects: [],
			uncertainty: "",
		})),
	};
	const blueprint = {
		mode: "FLOW",
		message: "Complete four required observations",
		beats: Array.from({ length: 4 }, (_, i) => ({
			id: `b${i}`,
			role: "ACTION",
			eventIds:
				i === 3
					? ["e12"]
					: Array.from({ length: 4 }, (_, n) => `e${i * 4 + n}`),
			requires: i ? [`b${i - 1}`] : [],
		})),
		uncertainty: "",
	};
	return { input, ledger, blueprint };
}

describe("independent review adversarial cases", () => {
	it("retains a known feasible complete plan before maximizing used duration", () => {
		const f = authoredInput();
		const known = {
			...f.blueprint,
			beats: f.blueprint.beats.map((b, i) => ({
				...b,
				eventIds: [i === 3 ? "e12" : `e${i * 4}`],
			})),
		};
		expect(
			selectLocalStoryClips({
				...f,
				blueprint: known,
				targetDurationFrames: 420,
			}).actualDurationFrames,
		).toBe(390);
		expect(() =>
			selectLocalStoryClips({ ...f, targetDurationFrames: 420 }),
		).not.toThrow();
	});
	it("accepts the contract maximum event id while merging a valid model ledger", () => {
		const f = authoredInput();
		const chunks = buildLocalStoryChunks(f.input, { maxShots: 2 });
		const ledgers = chunks.map((c) =>
			localStoryLedgerSchema.parse({
				summary: "Observed",
				events: [
					{
						id: "e".repeat(64),
						label: "The dog crosses the room",
						role: "ACTION",
						refs: [c.refs[0]],
						quotes: [
							{
								ref: c.refs[0],
								quote: f.input.shots.find((s) => s.ref === c.refs[0])?.fields[0]
									?.text,
							},
						],
						subjects: [],
						uncertainty: "",
					},
				],
			}),
		);
		expect(() =>
			mergeLocalStoryLedgers({ input: f.input, chunks, ledgers }),
		).not.toThrow();
	});
});
