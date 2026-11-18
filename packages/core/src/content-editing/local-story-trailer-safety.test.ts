import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { authoredNormalizationReceipt } from "../testing/normalization-clock";
import type {
	LocalStoryCorpus,
	LocalStoryEvent,
} from "./local-story-contracts";
import { buildLocalStoryInput } from "./local-story-input";
import { selectLocalStoryTrailer } from "./local-story-trailer";
import {
	buildPreparedShotPartition,
	preparedFrameForSourceAppearance,
} from "./prepared-shot-partition";
import { cfrTimeMapSchema } from "./schema";

type FixtureScene = {
	from: number;
	to: number;
	shotEnd?: number;
	type?: string;
	role?: LocalStoryEvent["role"];
};
function fixture(
	scenes: FixtureScene[],
	segments?: Parameters<typeof buildLocalStoryInput>[0]["segments"],
) {
	const duration = Math.max(...scenes.map((scene) => scene.to));
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-trailer-safety-fixture" },
		title: "Trailer source",
		description: "Timed scenes and spoken evidence",
		duration,
		scenes: scenes.map((scene, index) => ({
			id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
			type: scene.type ?? "MAIN_CONTENT",
			title: "Authored scene",
			summary: "A grounded observation",
			startInSeconds: scene.from,
			endInSeconds: scene.to,
			shots: [
				{
					startInSeconds: scene.from,
					endInSeconds: scene.shotEnd ?? scene.to,
					detailedDescription: "A grounded visual observation",
				},
			],
		})),
	});
	const timeMap = cfrTimeMapSchema.parse({
		id: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "22222222-2222-4222-8222-222222222222",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: duration * 1_000_000,
		editingStartFrame: 0,
		editingEndFrame: duration * 30,
		fps: { num: 30, den: 1 },
	});
	const input = buildLocalStoryInput({
		analysis,
		timeMap,
		segments,
		includeExcludedWindows: true,
	});
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: ["Authored story evidence"],
		coveredRefs: input.shots.map((shot) => shot.ref),
		events: input.shots.map((shot) => {
			const scene =
				scenes[analysis.scenes.findIndex((item) => item.id === shot.sceneId)];
			const quote = shot.fields.find((field) => field.kind === "AISA")?.text;
			if (!scene || !quote) throw new Error("Missing authored scene or quote");
			return {
				id: `e${shot.ref}`,
				label: "A grounded event",
				role: scene.role ?? "CONTEXT",
				refs: [shot.ref],
				quotes: [{ ref: shot.ref, quote }],
				subjects: ["Lead"],
				uncertainty: "",
			};
		}),
	};
	return { input, ledger, analysis, timeMap };
}

function preparedOptions(
	{
		analysis,
		timeMap,
	}: Pick<ReturnType<typeof fixture>, "analysis" | "timeMap">,
	hasAudio = false,
) {
	const normalization = authoredNormalizationReceipt({
		organizationId: "33333333-3333-4333-8333-333333333333",
		sourceId: "44444444-4444-4444-8444-444444444444",
		mediaVersionId: timeMap.mediaVersionId,
		sourceFrameCount: (timeMap.sourceEndUs * 24) / 1_000_000,
		hasAudio,
	});
	const preparedTimeMap = { ...timeMap, id: normalization.timeMapId };
	const preparedPartition = buildPreparedShotPartition({
		analysis,
		timeMap: preparedTimeMap,
		normalization,
	});
	return {
		normalization,
		options: { analysis, timeMap: preparedTimeMap, preparedPartition },
	};
}

describe("trailer source boundaries", () => {
	it.each([
		false,
		true,
	])("recovers a shared approved prepared frame with or without audio (hasAudio=%s)", (hasAudio) => {
		const f = fixture([
			{ from: 0, to: 10.125 },
			{ from: 10.125, to: 30 },
		]);
		const { options, normalization } = preparedOptions(f, hasAudio);
		expect(normalization.sourceFrameIndex.slice(303, 305)).toEqual([242, 243]);
		const input = buildLocalStoryInput({
			...options,
			includeExcludedWindows: true,
		});
		const request = {
			input,
			ledger: f.ledger,
			targetDurationFrames: 900,
			trailer: { durationMode: "EXACT", disclosure: "SETUP_ONLY" } as const,
		};
		expect(selectLocalStoryTrailer(request).windows).toEqual([
			{ sourceInUs: 0, durationFrames: 304 },
			{ sourceInUs: 10_133_334, durationFrames: 596 },
		]);
		const outcome = f.ledger.events.find((event) => event.id === "es1");
		if (!outcome) throw new Error("Missing closing event fixture");
		outcome.role = "OUTCOME";
		expect(() =>
			selectLocalStoryTrailer({ ...request, targetDurationFrames: 304 }),
		).toThrow("LOCAL_TRAILER_EXACT_DURATION_UNAVAILABLE");
	});

	it("blocks preview frames repeated beyond the raw boundary during prepared 24 to 30 conversion", () => {
		const f = fixture([
			{ from: 0.02, to: 1.02, type: "PREVIEW_THIS_TITLE" },
			{ from: 1.02, to: 3 },
			{ from: 3, to: 4 },
		]);
		const { options, normalization } = preparedOptions(f);
		const { preparedPartition } = options;
		const input = buildLocalStoryInput({
			...options,
			includeExcludedWindows: true,
		});
		expect(input.shots[0]?.fromFrame).toBe(32);
		expect(normalization.sourceFrameIndex.slice(30, 33)).toEqual([24, 24, 25]);
		expect(preparedFrameForSourceAppearance(preparedPartition, 0.02)).toBe(2);
		expect(preparedFrameForSourceAppearance(preparedPartition, 1.02)).toBe(32);
		const request = {
			input,
			ledger: f.ledger,
			targetDurationFrames: 59,
			trailer: { durationMode: "EXACT", disclosure: "SETUP_ONLY" } as const,
		};
		expect(() => selectLocalStoryTrailer(request)).toThrow(
			"LOCAL_TRAILER_EXACT_DURATION_UNAVAILABLE",
		);
		expect(input.excludedWindows).toEqual([{ fromFrame: 0, toFrame: 32 }]);
		expect(buildLocalStoryInput(options)).not.toHaveProperty("excludedWindows");
		expect(
			selectLocalStoryTrailer({
				...request,
				trailer: { ...request.trailer, durationMode: "TARGET" },
			}).windows,
		).toEqual([{ sourceInUs: 1_066_667, durationFrames: 58 }]);
	});

	it("cannot open on repeated outcome footage at an ordinary prepared scene cut", () => {
		const f = fixture([
			{ from: 0, to: 0.06, role: "OUTCOME" },
			{ from: 0.06, to: 2, role: "CONTEXT" },
		]);
		const { options, normalization } = preparedOptions(f);
		expect(normalization.sourceFrameIndex.slice(2, 4)).toEqual([1, 2]);
		expect(buildLocalStoryInput(options).shots[1]?.fromFrame).toBe(2);
		const input = buildLocalStoryInput({
			...options,
			includeExcludedWindows: true,
		});
		const request = {
			input,
			ledger: f.ledger,
			targetDurationFrames: 58,
			trailer: { durationMode: "EXACT", disclosure: "SETUP_ONLY" } as const,
		};
		expect(() => selectLocalStoryTrailer(request)).toThrow(
			"LOCAL_TRAILER_EXACT_DURATION_UNAVAILABLE",
		);
		expect(
			selectLocalStoryTrailer({
				...request,
				trailer: { ...request.trailer, durationMode: "TARGET" },
			}).windows,
		).toEqual([{ sourceInUs: 100_000, durationFrames: 57 }]);
	});

	it("excludes a preview scene's actual bounds when another scene's shot crosses into it", () => {
		const { input, ledger, analysis, timeMap } = fixture([
			{ from: 0, to: 20, shotEnd: 30 },
			{ from: 20, to: 30, type: "PREVIEW_THIS_TITLE" },
			{ from: 30, to: 50 },
		]);
		const request = {
			input,
			ledger,
			targetDurationFrames: 900,
			trailer: { durationMode: "EXACT", disclosure: "SETUP_ONLY" } as const,
		};
		expect(() => selectLocalStoryTrailer(request)).toThrow(
			"LOCAL_TRAILER_EXACT_DURATION_UNAVAILABLE",
		);
		expect(
			selectLocalStoryTrailer({
				...request,
				trailer: { ...request.trailer, durationMode: "TARGET" },
			}).windows,
		).toEqual([{ sourceInUs: 30_000_000, durationFrames: 600 }]);
		expect(input.excludedWindows).toEqual([{ fromFrame: 600, toFrame: 900 }]);
		expect(buildLocalStoryInput({ analysis, timeMap })).not.toHaveProperty(
			"excludedWindows",
		);
	});

	it("chooses an eligible opening when speech would prepend action to a different context", () => {
		const { input, ledger } = fixture([
			{ from: 0, to: 10, role: "ACTION" },
			{ from: 10, to: 20 },
			{ from: 30, to: 40 },
		]);
		const result = selectLocalStoryTrailer({
			input: {
				...input,
				speechIntervals: [{ startUs: 9_000_000, endUs: 11_000_000 }],
			},
			ledger,
			targetDurationFrames: 330,
			trailer: { durationMode: "TARGET", disclosure: "SETUP_AND_QUESTION" },
		});
		expect(result.windows).toEqual([
			{ sourceInUs: 30_000_000, durationFrames: 300 },
		]);
		expect(result.blueprint.beats[0]?.eventIds).toEqual(["es2"]);
	});

	it("keeps another speech-supported window of the same opening context", () => {
		const text = "Where did the dog go?";
		const { input, ledger } = fixture(
			[
				{ from: 0, to: 10, role: "ACTION" },
				{ from: 10, to: 20 },
			],
			[{ startUs: 14_000_000, endUs: 16_000_000, text }],
		);
		const context = ledger.events.find((event) => event.role === "CONTEXT");
		if (!context) throw new Error("Missing context fixture");
		context.quotes = [{ ref: "s1", quote: text }];
		const result = selectLocalStoryTrailer({
			input: {
				...input,
				speechIntervals: [{ startUs: 9_000_000, endUs: 11_000_000 }],
			},
			ledger,
			targetDurationFrames: 330,
			trailer: { durationMode: "TARGET", disclosure: "SETUP_AND_QUESTION" },
		});
		expect(result.windows).toEqual([
			{ sourceInUs: 13_900_000, durationFrames: 66 },
		]);
		expect(result.blueprint.beats[0]?.eventIds).toEqual(["es1"]);
	});
});
