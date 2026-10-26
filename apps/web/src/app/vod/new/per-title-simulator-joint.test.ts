import {
	certifyComplexityIntervals,
	complexityTargetsDoNotDecrease,
	evaluateComplexityRange,
	evaluateForcedRenditions,
	PER_TITLE_MIN_BITRATE,
	type PerTitleGoal,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	perTitleAdvice,
} from "./per-title-simulator-advice";
import { perTitleAdviceFieldKey } from "./per-title-simulator-advice-fields";
import {
	jointPerTitleExpansion,
	jointPerTitleExpansionLayouts,
} from "./per-title-simulator-joint";

const BITRATE_SCALE = 10_000;

/** Keep all bitrate units proportional; ratios, codec controls and dimensions stay unchanged. */
function apiBitrates(goal: PerTitleGoal): PerTitleGoal {
	const scaleSettings = <
		T extends {
			minBitrate?: number;
			maxBitrate?: number;
			lowComplexityBoundaryForMaxBitrate?: number;
			highComplexityBoundaryForMaxBitrate?: number;
		},
	>(
		row: T,
	) => ({
		...row,
		...(row.minBitrate === undefined
			? {}
			: { minBitrate: row.minBitrate * BITRATE_SCALE }),
		...(row.maxBitrate === undefined
			? {}
			: { maxBitrate: row.maxBitrate * BITRATE_SCALE }),
		...(row.lowComplexityBoundaryForMaxBitrate === undefined
			? {}
			: {
					lowComplexityBoundaryForMaxBitrate:
						row.lowComplexityBoundaryForMaxBitrate * BITRATE_SCALE,
				}),
		...(row.highComplexityBoundaryForMaxBitrate === undefined
			? {}
			: {
					highComplexityBoundaryForMaxBitrate:
						row.highComplexityBoundaryForMaxBitrate * BITRATE_SCALE,
				}),
	});
	return {
		...goal,
		minBitrate: goal.minBitrate * BITRATE_SCALE,
		maxBitrate: goal.maxBitrate * BITRATE_SCALE,
		...(goal.rows ? { rows: goal.rows.map(scaleSettings) } : {}),
		...(goal.automaticTemplates
			? { automaticTemplates: goal.automaticTemplates.map(scaleSettings) }
			: {}),
	};
}

function arithmeticJoint(previous: PerTitleGoal, maximum: number) {
	const candidate = jointPerTitleExpansion(
		previous,
		{ ...previous, maxBitrate: maximum },
		new Set(),
	)[0];
	if (!candidate) throw new Error("Expected a checked arithmetic adjustment.");
	return candidate;
}

const source = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.25,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: false,
	rows: [
		{
			id: "a",
			height: 240,
			minBitrate: 200_000,
			maxBitrate: 400_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_250_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
		{
			id: "b",
			height: 720,
			minBitrate: 1_000_000,
			maxBitrate: 1_600_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_250_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
	automaticTemplates: [
		{ id: "bottom", height: 120 },
		{ id: "top", height: 1080 },
	],
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	targetQualityCrf: 18,
});

function joint(previous: PerTitleGoal, maximum = previous.maxBitrate * 2) {
	const current = { ...previous, maxBitrate: maximum };
	expect(previous.minBitrate).toBeGreaterThanOrEqual(PER_TITLE_MIN_BITRATE);
	expect(current.maxBitrate).toBeGreaterThanOrEqual(PER_TITLE_MIN_BITRATE);
	const items = perTitleAdvice(previous, current, {
		scope: "global",
		key: "maxBitrate",
	});
	const advice = items[0];
	expect(advice?.reason).toBe("joint-range");
	if (!advice) throw new Error("Expected a joint range adjustment.");
	return { current, advice };
}

describe("joint Per-Title range advice", () => {
	it("adjusts ranges, steps and the existing additional factor as one explicit option", () => {
		const previous = source();
		const snapshot = structuredClone(previous);
		const { current, advice } = joint(previous);
		expect(advice.goal.minBitrate).toBe(previous.minBitrate);
		expect(advice.goal.maxBitrate).toBe(8_000_000);
		expect(advice.goal.automaticTemplates).toEqual(previous.automaticTemplates);
		expect(advice.goal.countPolicy).toEqual(previous.countPolicy);
		expect(advice.goal.targetQualityCrf).toBe(18);
		const exponent = Math.log(80) / Math.log(40);
		expect(advice.goal.rows?.[0]?.minBitrate).toBe(230_000);
		expect(advice.goal.rows?.[0]?.minBitrate).not.toBe(400_000);
		expect(advice.facts.exponent).toBe(exponent);
		expect(advice.goal.minBitrateStepSize).toBe(1.31);
		expect(advice.goal.maxBitrateStepSize).toBeGreaterThanOrEqual(
			4 ** exponent,
		);
		expect(advice.goal.maxBitrateStepSize).toBeGreaterThanOrEqual(
			(advice.goal.rows?.[1]?.minBitrate ?? Infinity) /
				(advice.goal.rows?.[0]?.minBitrate ?? 1),
		);
		expect(advice.facts.connectionRisk).toBe(0);
		expect(
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.24);
		expect(
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentation,
		).toBe(1);
		expect(advice.proof).toBe("conditional-settings");
		expect(previous).toEqual(snapshot);
		expect(current.rows).toEqual(snapshot.rows);
		expect(applyPerTitleAdvice(current, advice)).toEqual(advice.goal);
		expect(
			applyPerTitleAdvice({ ...current, minBitrate: 110_000 }, advice),
		).toBeNull();
	});

	it("does not lower a fixed-C target even when mapping both boundaries would lower it", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100,
			maxBitrate: 400,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "fixed",
					height: 240,
					minBitrate: 100,
					maxBitrate: 200,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 200,
					highComplexityBoundaryForMaxBitrate: 400,
				},
			],
		};
		const scaled = apiBitrates(previous);
		const { advice } = joint(scaled, 1600 * BITRATE_SCALE);
		const row = advice.goal.rows?.[0];
		expect(row?.minBitrate).toBe(100 * BITRATE_SCALE);
		expect(row?.maxBitrate).toBe(400 * BITRATE_SCALE);
		expect(row?.lowComplexityBoundaryForMaxBitrate).toBe(200 * BITRATE_SCALE);
		expect(row?.highComplexityBoundaryForMaxBitrate).toBe(800 * BITRATE_SCALE);
		expect(
			complexityTargetsDoNotDecrease(
				{
					minimum: 100 * BITRATE_SCALE,
					maximum: 200 * BITRATE_SCALE,
					low: 200 * BITRATE_SCALE,
					high: 400 * BITRATE_SCALE,
				},
				{
					minimum: row?.minBitrate ?? 0,
					maximum: row?.maxBitrate ?? 0,
					low: row?.lowComplexityBoundaryForMaxBitrate ?? 0,
					high: row?.highComplexityBoundaryForMaxBitrate ?? 0,
				},
				{ minimum: 1, maximum: scaled.maxBitrate },
			),
		).toBe(true);
		for (let sample = 1; sample <= 400; sample++) {
			const input = sample * BITRATE_SCALE;
			const after = evaluateComplexityRange({
				minimum: row?.minBitrate ?? 0,
				maximum: row?.maxBitrate ?? 0,
				low: row?.lowComplexityBoundaryForMaxBitrate ?? 0,
				high: row?.highComplexityBoundaryForMaxBitrate ?? 0,
				input,
				minStep: advice.goal.minBitrateStepSize ?? 0,
			});
			const before = evaluateComplexityRange({
				minimum: 100 * BITRATE_SCALE,
				maximum: 200 * BITRATE_SCALE,
				low: 200 * BITRATE_SCALE,
				high: 400 * BITRATE_SCALE,
				input,
				minStep: 2,
			});
			expect(after?.maximum).toBeGreaterThanOrEqual(
				before?.maximum ?? Infinity,
			);
		}
	});

	it("preserves custom upper boundaries and repeated resolutions", () => {
		const previous = source();
		previous.rows = previous.rows?.map((row) => ({
			...row,
			height: 360,
			highComplexityBoundaryForMaxBitrate: 3_500_000,
		}));
		const { advice } = joint(previous);
		expect(
			advice.goal.rows?.map((row) => [
				row.id,
				row.height,
				row.highComplexityBoundaryForMaxBitrate,
			]),
		).toEqual([
			["a", 360, 3_500_000],
			["b", 360, 3_500_000],
		]);
	});

	it("limits an existing additional factor when repeated rounding would exceed the new cap", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 1,
			maxBitrate: 8,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [{ id: "fixed", height: 240, minBitrate: 1, maxBitrate: 2 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		// Preserve the one-bit rounding counterexample in the shared arithmetic engine.
		const arithmetic = arithmeticJoint(previous, 16);
		expect(arithmetic.goal.rows?.[0]?.maxBitrate).toBe(3);
		expect(
			arithmetic.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(2.35);
		expect(
			evaluateForcedRenditions({
				base: { minimum: 3, maximum: 3 },
				count: 2,
				factor: 2.35,
			}),
		).toEqual([
			{ minimum: 7, maximum: 7 },
			{ minimum: 16, maximum: 16 },
		]);
		const { advice } = joint(apiBitrates(previous), 16 * BITRATE_SCALE);
		const factor =
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor ?? 0;
		expect(factor).toBeGreaterThan(1);
		expect(factor).toBeLessThan(2 ** (4 / 3));
		const top = advice.goal.rows?.[0]?.maxBitrate ?? 0;
		expect(top).toBe(25_200);
		const first = Math.round(top * factor),
			second = Math.round(first * factor);
		const unclamped = 2 ** (4 / 3);
		expect(Math.round(Math.round(top * unclamped) * unclamped)).toBeGreaterThan(
			16 * BITRATE_SCALE,
		);
		expect(first).toBeGreaterThan(top);
		expect(second).toBeGreaterThan(first);
		expect(second).toBeLessThanOrEqual(16 * BITRATE_SCALE);
		expect(
			applyPerTitleAdvice(
				{ ...apiBitrates(previous), maxBitrate: 16 * BITRATE_SCALE },
				advice,
			),
		).toEqual(advice.goal);
	});

	it("uses an adopted protected factor when checking the remaining range expansion", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 1,
			maxBitrate: 6,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [{ id: "fixed", height: 240, minBitrate: 1, maxBitrate: 4 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.62,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const arithmetic = arithmeticJoint(previous, 7);
		expect(arithmetic.goal.rows?.[0]?.maxBitrate).toBe(5);
		expect(
			arithmetic.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.49);
		expect(
			evaluateForcedRenditions({
				base: { minimum: 5, maximum: 5 },
				count: 1,
				factor: 1.49,
			}),
		).toEqual([{ minimum: 7, maximum: 7 }]);
		const scaled = apiBitrates(previous);
		const { current, advice } = joint(scaled, 7 * BITRATE_SCALE);
		const factor = {
			scope: "global" as const,
			key: "fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
		};
		const arithmeticHeld = jointPerTitleExpansion(
			previous,
			{
				...previous,
				maxBitrate: 7,
				fixedResolutionAndBitrateConfiguration: {
					...previous.fixedResolutionAndBitrateConfiguration,
					forcedRenditionAboveHighestFixedRepresentationFactor: 1.49,
				},
			},
			new Set([perTitleAdviceFieldKey(factor)]),
		)[0];
		expect(arithmeticHeld?.goal.rows?.[0]?.maxBitrate).toBe(5);
		expect(
			arithmeticHeld?.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.49);
		expect(advice.goal.rows?.[0]?.maxBitrate).toBe(45_067);
		expect(
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.5532540439789644);
		const partial = applySelectedPerTitleAdvice(current, advice, [factor]);
		if (!partial) throw new Error("Expected to adopt only the offered factor.");
		expect(partial.rows?.[0]?.maxBitrate).toBe(4 * BITRATE_SCALE);
		const options = { protectedFields: [factor], appliedFields: [factor] };
		const next = perTitleAdvice(
			scaled,
			partial,
			{ scope: "global", key: "maxBitrate" },
			options,
		)[0];
		if (!next) throw new Error("Expected the remaining range adjustment.");
		expect(next.goal.rows?.[0]?.maxBitrate).toBe(45_067);
		expect(
			next.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.5532540439789644);
		expect(next.changes.some((change) => change.key === factor.key)).toBe(
			false,
		);
		expect(next.facts.capacity).toBeLessThanOrEqual(
			next.facts.previousCapacity ?? 0,
		);
		expect(
			evaluateForcedRenditions({
				base: { minimum: 45_067, maximum: 45_067 },
				count: 1,
				factor: 1.5532540439789644,
			}),
		).toEqual([{ minimum: 70_000, maximum: 70_000 }]);
		expect(applyPerTitleAdvice(partial, next, options)).toEqual(next.goal);
	});

	it("raises the mapped minimum step when integer rounding otherwise adds a placement", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 1,
			maxBitrate: 4,
			minBitrateStepSize: 1.6,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [{ id: "fixed", height: 240, minBitrate: 1, maxBitrate: 2 }],
		};
		// Scaling removes this small-integer collision, so retain its exact arithmetic proof.
		const arithmetic = arithmeticJoint(previous, 8);
		const integerSpacing = arithmetic.goal.minBitrateStepSize ?? 0;
		expect(integerSpacing).toBe(2.13);
		expect(integerSpacing).toBeGreaterThan(1.6 ** 1.5);
		expect(
			Math.round(
				Math.round(Math.round(1 * integerSpacing) * integerSpacing) *
					integerSpacing,
			),
		).toBeGreaterThan(8);
		expect(arithmetic.facts.previousCapacity).toBe(3);
		expect(arithmetic.facts.capacity).toBe(3);
		const { advice } = joint(apiBitrates(previous), 8 * BITRATE_SCALE);
		const spacing = advice.goal.minBitrateStepSize ?? 0;
		expect(spacing).toBeGreaterThan(1.6 ** 1.5);
		expect(spacing).toBe(2.03);
		expect(
			Math.round(
				Math.round(Math.round(BITRATE_SCALE * spacing) * spacing) * spacing,
			),
		).toBeGreaterThan(8 * BITRATE_SCALE);
		expect(advice.facts.previousCapacity).toBe(3);
		expect(advice.facts.capacity).toBe(3);
	});

	it("retains certified connections after rounding ranges and steps without increasing placement room", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100,
			maxBitrate: 10_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "a",
					height: 240,
					minBitrate: 250,
					maxBitrate: 420,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 5400,
					highComplexityBoundaryForMaxBitrate: 10_000,
				},
				{
					id: "b",
					height: 720,
					minBitrate: 500,
					maxBitrate: 750,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 5400,
					highComplexityBoundaryForMaxBitrate: 10_000,
				},
			],
			automaticTemplates: [{ id: "top", height: 1080 }],
		};
		const { advice } = joint(apiBitrates(previous), 30_000 * BITRATE_SCALE);
		const step = advice.goal.minBitrateStepSize ?? 0;
		expect(step).toBe(Number(step.toFixed(2)));
		const certificate = certifyComplexityIntervals(
			(advice.goal.rows ?? []).map((row) => ({
				minimum: row.minBitrate ?? 0,
				maximum: row.maxBitrate ?? 0,
				low: row.lowComplexityBoundaryForMaxBitrate ?? 0,
				high: row.highComplexityBoundaryForMaxBitrate ?? 0,
			})),
			{ minimum: 1, maximum: advice.goal.maxBitrate },
			step,
		);
		expect(certificate).not.toBeNull();
		expect(certificate?.minimumAdjacentRatio).toBeGreaterThanOrEqual(step);
		expect(certificate?.maximumAdjacentRatio).toBeLessThanOrEqual(
			advice.goal.maxBitrateStepSize ?? 0,
		);
		expect(
			advice.goal.rows?.[0]?.highComplexityBoundaryForMaxBitrate,
		).toBeGreaterThan(10_000 * BITRATE_SCALE);
		expect(advice.facts.capacity).toBeLessThanOrEqual(
			advice.facts.previousCapacity ?? 0,
		);
		expect(advice.facts.connectionRisk).toBe(0);
	});

	it("does not invent a joint expansion for degenerate or invalid source ranges", () => {
		for (const previous of [
			{ ...source(), minBitrate: 4_000_000 },
			{ ...source(), minBitrateStepSize: 1 },
		]) {
			const result = perTitleAdvice(
				previous,
				{ ...previous, maxBitrate: 8_000_000 },
				{ scope: "global", key: "maxBitrate" },
			);
			expect(result.some((item) => item.reason === "joint-range")).toBe(false);
		}
	});

	it("retries free range growth when the fully expanded layout loses a protected connection", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 120_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				[280_000, 480_000, 240],
				[560_000, 840_000, 240],
				[960_000, 1_320_000, 540],
				[1_720_000, 2_280_000, 720],
			].map(([minBitrate, maxBitrate, height], i) => ({
				id: `row-${i}`,
				height: height as number,
				minBitrate,
				maxBitrate,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 2_100_000,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			})),
			automaticTemplates: [{ id: "top", height: 1080 }],
		};
		const current = { ...previous, maxBitrate: 6_000_000 };
		const snapshots = structuredClone({ previous, current });
		const pins = new Set(
			["minBitrate", "maxBitrate"].map((key) =>
				perTitleAdviceFieldKey({ scope: "stream", key, rowId: "row-0" }),
			),
		);
		const candidates = jointPerTitleExpansion(previous, current, pins);
		expect(candidates.length).toBeGreaterThan(0);
		const candidate = candidates[0];
		if (!candidate) throw new Error("Expected a certified partial expansion.");
		const { goal, facts } = candidate;
		expect(goal.rows?.[0]).toMatchObject({
			minBitrate: 280_000,
			maxBitrate: 480_000,
		});
		expect(goal.maxBitrate).toBe(6_000_000);
		expect(goal.rows?.[3]?.maxBitrate).toBeGreaterThan(2_280_000);
		expect(facts.capacity).toBeLessThanOrEqual(facts.previousCapacity ?? 0);
		expect(facts.connectionRisk).toBe(0);
		const asCurve = (row: NonNullable<PerTitleGoal["rows"]>[number]) => ({
			minimum: row.minBitrate ?? 0,
			maximum: row.maxBitrate ?? 0,
			low: row.lowComplexityBoundaryForMaxBitrate ?? 0,
			high: row.highComplexityBoundaryForMaxBitrate ?? 0,
		});
		for (const [i, row] of (goal.rows ?? []).entries()) {
			const old = previous.rows?.[i];
			if (!old) throw new Error("Missing source row.");
			expect(
				complexityTargetsDoNotDecrease(asCurve(old), asCurve(row), {
					minimum: 1,
					maximum: previous.maxBitrate,
				}),
			).toBe(true);
		}
		const certificate = certifyComplexityIntervals(
			(goal.rows ?? []).map(asCurve),
			{ minimum: 1, maximum: goal.maxBitrate },
			goal.minBitrateStepSize ?? 0,
		);
		expect(certificate?.minimumAdjacentRatio).toBeGreaterThanOrEqual(
			goal.minBitrateStepSize ?? Infinity,
		);
		expect(certificate?.maximumAdjacentRatio).toBeLessThanOrEqual(
			goal.maxBitrateStepSize ?? 0,
		);
		expect({ previous, current }).toEqual(snapshots);
	});

	it("offers later endpoint layouts in order after preserving the primary protected option", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const pins = new Set(
			["minBitrate", "maxBitrate"].map((key) =>
				perTitleAdviceFieldKey({ scope: "stream", key, rowId: "a" }),
			),
		);
		const layouts = jointPerTitleExpansionLayouts(previous, current, pins);
		const first = layouts.next().value;
		expect(first).toEqual(jointPerTitleExpansion(previous, current, pins));
		if (!first?.length) throw new Error("Missing primary endpoint layout.");
		const second = layouts.next().value;
		if (!second?.length) throw new Error("Missing fallback endpoint layout.");
		expect(second[0]?.goal.rows?.[1]?.maxBitrate).toBeLessThan(
			first[0]?.goal.rows?.[1]?.maxBitrate ?? 0,
		);
		const all = [first, second, ...layouts];
		expect(all.length).toBeLessThanOrEqual(5);
		for (const candidates of all) {
			expect(candidates.length).toBeLessThanOrEqual(32);
			for (const { goal } of candidates) {
				expect(goal.maxBitrate).toBe(8_000_000);
				expect(goal.rows?.[0]).toMatchObject({
					minBitrate: 200_000,
					maxBitrate: 400_000,
				});
			}
		}
	});
});
