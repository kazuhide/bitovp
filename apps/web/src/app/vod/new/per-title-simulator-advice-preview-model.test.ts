import { type PerTitleGoal, previewPerTitleOutput } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	createPerTitleEvaluationAdvice,
	type PerTitleAdvice,
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAdvicePreview } from "./per-title-simulator-advice-preview-model";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const field = (key: string): PerTitleAdviceField => ({ scope: "global", key });
const empty = { selected: [], kept: [] };

function fixture(options: PerTitleAdviceOptions = {}) {
	const goal: PerTitleGoal = {
		strategy: "automatic",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 8_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		countPolicy: { kind: "unrestricted" },
	};
	const candidate = {
		...goal,
		minBitrate: 80_000,
		maxBitrate: 10_000_000,
		minBitrateStepSize: 2,
		maxBitrateStepSize: 3,
	};
	const advice = createPerTitleEvaluationAdvice(goal, candidate, options);
	if (!advice) throw new Error("Expected a checked configuration adjustment.");
	return { goal, candidate, advice };
}

describe("read-only staged advice preview", () => {
	it("keeps the exact output-count requirement through full, partial and keep-only comparisons", () => {
		const goal: PerTitleGoal = {
			codec: "H264",
			strategy: "automatic",
			minBitrate: 128_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 6 },
			autoRepresentations: {},
		};
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("count"),
		};
		const advice = analyzePerTitleSettings(goal, "count", options).advice[0];
		if (!advice) throw new Error("Expected a count-spacing adjustment.");
		const offered = advice.changes.map(({ scope, key, rowId }) => ({
			scope,
			key,
			...(rowId === undefined ? {} : { rowId }),
		}));
		const first = offered[0];
		if (!first) throw new Error("Expected an offered setting change.");
		const selections = [
			empty,
			{ selected: [first], kept: offered.slice(1) },
			{ selected: [], kept: [first] },
		];
		for (const selection of selections) {
			const result = perTitleAdvicePreview(goal, advice, selection, options);
			const expected =
				result.mode === "keep"
					? goal
					: result.mode === "all"
						? applyPerTitleAdvice(goal, advice, options)
						: applySelectedPerTitleAdvice(
								goal,
								advice,
								selection.selected,
								options,
							);
			if (!expected || !result.after)
				throw new Error("Expected a calculated comparison.");
			expect(result.currentCountPolicy).toEqual(goal.countPolicy);
			expect(result.afterCountPolicy).toEqual(expected.countPolicy);
			expect(result.after.api).toEqual(
				tunePerTitleSettings(expected, goal).proposal.api,
			);
			for (const [proposal, countPolicy] of [
				[result.current, result.currentCountPolicy],
				[result.after, result.afterCountPolicy],
			] as const) {
				const chart = previewPerTitleOutput(proposal, { countPolicy });
				expect(chart.countProjection).toMatchObject({
					kind: "exact",
					requestedCount: 6,
					status: "conditional",
				});
				expect(chart.rows).toHaveLength(6);
				expect(chart.rows.map((row) => row.ordinal)).toEqual([
					1, 2, 3, 4, 5, 6,
				]);
				expect(chart.rows.every((row) => row.bitrate === undefined)).toBe(true);
			}
		}
	});
	it("compares equivalent API objects independently of optional-setting insertion order", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 10,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "fixed",
					height: 720,
					minBitrate: 1_000_000,
					maxBitrate: 2_000_000,
				},
			],
		};
		const candidate: PerTitleGoal = {
			...goal,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const advice = createPerTitleEvaluationAdvice(goal, candidate);
		if (!advice) throw new Error("Expected an optional-setting adjustment.");
		const offered = advice.changes.map(({ scope, key, rowId }) => ({
			scope,
			key,
			...(rowId === undefined ? {} : { rowId }),
		}));
		const fullGoal = applyPerTitleAdvice(goal, advice);
		const selectedGoal = applySelectedPerTitleAdvice(goal, advice, offered);
		if (!fullGoal || !selectedGoal)
			throw new Error("Expected both adoption paths to accept the advice.");
		const fullApi = tunePerTitleSettings(fullGoal, fullGoal).proposal.api;
		const selectedApi = tunePerTitleSettings(selectedGoal, selectedGoal)
			.proposal.api;
		expect(selectedApi).toEqual(fullApi);
		expect(JSON.stringify(selectedApi)).not.toBe(JSON.stringify(fullApi));
		for (const selection of [
			empty,
			{ selected: offered, kept: [] },
			{ selected: [], kept: offered },
		]) {
			const preview = perTitleAdvicePreview(goal, advice, selection);
			expect(preview.status).toBe("ready");
			expect(preview.after?.api).toEqual(
				preview.mode === "keep" ? preview.current.api : fullApi,
			);
		}
	});

	it("previews the full recommendation, selected fields, keeps, and a cleared selection", () => {
		const { goal, advice, candidate } = fixture();
		const full = perTitleAdvicePreview(goal, advice, empty);
		expect(full.status).toBe("ready");
		expect(full.mode).toBe("all");
		expect(full.current.api).toEqual(
			tunePerTitleSettings(goal, goal).proposal.api,
		);
		expect(full.after?.api).toEqual(
			tunePerTitleSettings(candidate, candidate).proposal.api,
		);
		const partial = perTitleAdvicePreview(goal, advice, {
			selected: [field("maxBitrate")],
			kept: [field("minBitrate")],
		});
		expect(partial.status).toBe("ready");
		expect(partial.mode).toBe("selected");
		expect(partial.after?.api.global).toEqual({
			...full.current.api.global,
			maxBitrate: candidate.maxBitrate,
		});
		const kept = perTitleAdvicePreview(goal, advice, {
			selected: [],
			kept: [field("maxBitrate")],
		});
		expect(kept.status).toBe("ready");
		expect(kept.mode).toBe("keep");
		expect(kept.after?.api).toEqual(kept.current.api);
		expect(perTitleAdvicePreview(goal, advice, empty)).toEqual(full);
		expect(full.axis).toEqual({ minimum: 80_000, maximum: 10_000_000 });
		expect(partial.axis).toEqual(full.axis);
		expect(kept.axis).toEqual(full.axis);
	});

	it("never mutates the input, recommendation, selection, or protections", () => {
		const options = {
			contextKey: "preview-cap",
			protectedFields: [field("targetQualityCrf")],
		};
		const { goal, advice } = fixture(options);
		const selection = {
			selected: [field("maxBitrate")],
			kept: [field("minBitrate")],
		};
		const before = structuredClone({ goal, advice, selection, options });
		expect(perTitleAdvicePreview(goal, advice, selection, options).status).toBe(
			"ready",
		);
		expect({ goal, advice, selection, options }).toEqual(before);
	});

	it.each([
		"goal",
		"context",
		"protection",
	] as const)("rejects stale %s evidence even for keep-only previews", (kind) => {
		const options = {
			contextKey: "preview-cap",
			protectedFields: [field("targetQualityCrf")],
		};
		const { goal, advice } = fixture(options);
		const result = perTitleAdvicePreview(
			kind === "goal" ? { ...goal, maxBitrate: 9_000_000 } : goal,
			advice,
			{ selected: [], kept: [field("maxBitrate")] },
			kind === "context"
				? { ...options, contextKey: "preview-count" }
				: kind === "protection"
					? { ...options, protectedFields: [] }
					: options,
		);
		expect(result.status).toBe("unavailable");
		expect(result.after).toBeNull();
	});

	it.each([
		{ selected: [field("maxBitrate"), field("maxBitrate")], kept: [] },
		{ selected: [], kept: [field("maxBitrate"), field("maxBitrate")] },
		{ selected: [field("maxBitrate")], kept: [field("maxBitrate")] },
		{ selected: [field("targetQualityCrf")], kept: [] },
		{ selected: [{ ...field("maxBitrate"), rowId: "unknown" }], kept: [] },
		{ selected: [{ ...field("maxBitrate"), unexpected: true }], kept: [] },
		{ selected: [{ scope: "count", key: "maxBitrate" }], kept: [] },
		{ selected: null, kept: [] },
		{ selected: [], kept: "maxBitrate" },
	])("rejects malformed, duplicate, foreign, or overlapping decisions %#", (value) => {
		const { goal, advice } = fixture();
		const result = perTitleAdvicePreview(
			goal,
			advice,
			value as unknown as Parameters<typeof perTitleAdvicePreview>[2],
		);
		expect(result.status).toBe("unavailable");
		expect(result.after).toBeNull();
	});

	it.each([
		"before",
		"after",
		"missing",
		"duplicate",
	] as const)("rejects malformed offered changes: %s", (kind) => {
		const { goal, advice } = fixture();
		const malformed = structuredClone(advice);
		const change = malformed.changes[0];
		if (!change) throw new Error("Expected an offered change.");
		if (kind === "missing") malformed.changes.pop();
		else if (kind === "duplicate") malformed.changes.push({ ...change });
		else change[kind] = 42;
		const result = perTitleAdvicePreview(goal, malformed, empty);
		expect(result.status).toBe("unavailable");
		expect(result.after).toBeNull();
	});

	it("marks a valid but conflicting subset and keeps the full-recommendation axis", () => {
		const { goal, advice } = fixture();
		const full = perTitleAdvicePreview(goal, advice, empty);
		const partial = perTitleAdvicePreview(goal, advice, {
			selected: [field("minBitrateStepSize")],
			kept: [],
		});
		expect(full.status).toBe("ready");
		expect(partial.status).toBe("conflict");
		expect(partial.after?.api.global.minBitrateStepSize).toBe(2);
		expect(partial.after?.api.global.maxBitrateStepSize).toBe(1.9);
		expect(
			partial.after?.diagnostics.some((item) => item.severity === "conflict"),
		).toBe(true);
		expect(partial.axis).toEqual(full.axis);
	});

	it("retains mixed fixed and ordinary templates without asserting native output count", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 10,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "fixed",
					height: 720,
					minBitrate: 1_000_000,
					maxBitrate: 2_000_000,
				},
			],
			automaticTemplates: [
				{ id: "lower", height: 180 },
				{ id: "upper", height: 1080 },
			],
		};
		const candidate = { ...goal, maxBitrate: 9_000_000 };
		const advice = createPerTitleEvaluationAdvice(goal, candidate);
		if (!advice) throw new Error("Expected a mixed-template adjustment.");
		const preview = perTitleAdvicePreview(goal, advice, empty);
		expect(preview.status).toBe("ready");
		expect(preview.after?.api.streams.map((row) => row.rowId)).toEqual(
			preview.current.api.streams.map((row) => row.rowId),
		);
		expect(preview.after?.api.streams).toHaveLength(3);
		expect(preview.after?.countGuarantee).toBe(false);
		expect(preview.after?.evidence).toBe("model-only");
	});

	it("rejects malformed recommendation objects without inventing an after proposal", () => {
		const { goal } = fixture();
		const result = perTitleAdvicePreview(goal, {} as PerTitleAdvice, empty);
		expect(result.status).toBe("unavailable");
		expect(result.after).toBeNull();
	});
});
