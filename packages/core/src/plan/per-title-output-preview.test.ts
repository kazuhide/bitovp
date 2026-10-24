import { describe, expect, it } from "vitest";
import { previewPerTitleOutput } from "./per-title-output-preview.js";
import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "./per-title-simulator.js";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected a fixture value");
	return value;
}

const fixed: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_400_000,
	countPolicy: { kind: "exact", count: 3 },
	rows: [
		{ id: "a", height: 240, minBitrate: 160_000, maxBitrate: 200_000 },
		{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
		{ id: "c", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
	],
};

function conditional(): PerTitleProposal {
	return {
		id: "baseline",
		codec: "H264",
		status: "unknown",
		applicable: false,
		evidence: "model-only",
		countGuarantee: false,
		api: {
			global: {
				minBitrate: 100,
				maxBitrate: 1000,
				minBitrateStepSize: 1.2,
				maxBitrateStepSize: 4,
			},
			streams: [
				{
					rowId: "fixed",
					height: 360,
					width: 640,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: {
						minBitrate: 200,
						maxBitrate: 400,
						bitrateSelectionMode: "COMPLEXITY_RANGE",
						lowComplexityBoundaryForMaxBitrate: 100,
						highComplexityBoundaryForMaxBitrate: 2000,
					},
				},
			],
		},
		scenarios: [],
		diagnostics: [],
	};
}

function mixed(): PerTitleProposal {
	const proposal = conditional();
	required(proposal.api.streams[0]).width = undefined;
	proposal.api.streams.push(
		{ rowId: "small", height: 180, mode: "PER_TITLE_TEMPLATE" },
		{ rowId: "large", height: 900, mode: "PER_TITLE_TEMPLATE" },
		{ rowId: "largest", height: 1080, mode: "PER_TITLE_TEMPLATE" },
	);
	proposal.api.global.fixedResolutionAndBitrateConfiguration = {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	};
	return proposal;
}

function ordinary(): PerTitleProposal {
	const proposal = conditional();
	proposal.api.global = {
		minBitrate: 128_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		autoRepresentations: {},
	};
	proposal.api.streams = [
		{ rowId: "ordinary", height: 720, mode: "PER_TITLE_TEMPLATE" },
	];
	return proposal;
}

describe("count-conditioned Per-Title output previews", () => {
	it("projects a requested six-count placement into six unselected integer slots", () => {
		const proposal = ordinary();
		const before = structuredClone(proposal);
		const result = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count: 6 },
		});
		expect(result.countProjection).toEqual({
			kind: "exact",
			requestedCount: 6,
			status: "conditional",
		});
		expect(result.rows).toHaveLength(6);
		expect(result.rows.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
		for (const row of result.rows) {
			expect(row).toMatchObject({
				kind: "count-slot",
				status: "conditional",
				basis: "count",
				rangeBasis: "spacing",
			});
			expect(Number.isInteger(row.minimumBitrate)).toBe(true);
			expect(Number.isInteger(row.maximumBitrate)).toBe(true);
			expect(row.bitrate).toBeUndefined();
			expect(row.height).toBeUndefined();
			expect(row.width).toBeUndefined();
			expect(row.rowId).toBeUndefined();
		}
		expect(result.rows[0]).toMatchObject({
			minimumBitrate: 128_000,
			maximumBitrate: 128_000,
		});
		expect(result.rows.at(-1)?.maximumBitrate).toBeLessThan(4_000_000);
		expect(result.unresolvedAdditional).toBe(true);
		expect(proposal).toEqual(before);
	});

	it("rejects an integer hole instead of rounding a noninteger fixed step into a slot", () => {
		const proposal = ordinary();
		Object.assign(proposal.api.global, {
			minBitrate: 10_001,
			maxBitrate: 20_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.5,
		});
		const baseline = previewPerTitleOutput(proposal);
		const result = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count: 2 },
		});
		expect(result.countProjection).toEqual({
			kind: "exact",
			requestedCount: 2,
			status: "infeasible",
			reason: "integer-chain-infeasible",
		});
		expect(result.rows).toEqual(baseline.rows);
		expect(result.rows.some((row) => row.kind === "count-slot")).toBe(false);
	});

	it("projects only values that can connect to every remaining slot below the analysis ceiling", () => {
		const proposal = ordinary();
		Object.assign(proposal.api.global, {
			minBitrate: 100,
			maxBitrate: 1_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 2,
		});
		const result = previewPerTitleOutput(proposal, {
			analysisInput: 500,
			countPolicy: { kind: "exact", count: 4 },
		});
		expect(
			result.rows.map((row) => [row.minimumBitrate, row.maximumBitrate]),
		).toEqual([
			[100, 100],
			[150, 200],
			[225, 333],
			[338, 500],
		]);
		expect(result.complexityInput).toBe(500);
	});

	it("shows one minimum slot at count one even when the raw analysis input is below the floor", () => {
		const result = previewPerTitleOutput(ordinary(), {
			analysisInput: 1,
			countPolicy: { kind: "exact", count: 1 },
		});
		expect(result).toMatchObject({
			analysisInput: 1,
			floor: 128_000,
			complexityInput: 128_000,
			countProjection: {
				kind: "exact",
				requestedCount: 1,
				status: "conditional",
			},
			rows: [
				{
					kind: "count-slot",
					ordinal: 1,
					minimumBitrate: 128_000,
					maximumBitrate: 128_000,
				},
			],
		});
		expect(result.rows[0]?.bitrate).toBeUndefined();
		expect(result.unresolvedAdditional).toBe(true);
	});

	it("keeps the aggregate band when the hypothetical ceiling cannot fit the requested count", () => {
		const proposal = ordinary();
		const result = previewPerTitleOutput(proposal, {
			analysisInput: 500_000,
			countPolicy: { kind: "exact", count: 6 },
		});
		expect(result.countProjection).toMatchObject({
			requestedCount: 6,
			status: "infeasible",
			reason: "integer-chain-infeasible",
		});
		expect(result.rows).toEqual(
			previewPerTitleOutput(proposal, { analysisInput: 500_000 }).rows,
		);
	});

	it("does not require the last slot to reach the global maximum for a narrow decimal ratio band", () => {
		const proposal = ordinary();
		proposal.api.global.minBitrateStepSize = 1.8795574353431477;
		proposal.api.global.maxBitrateStepSize = 1.8795625;
		const result = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count: 6 },
		});
		expect(result.countProjection?.status).toBe("conditional");
		expect(result.rows).toHaveLength(6);
		expect(result.rows.at(-1)?.maximumBitrate).toBeLessThan(4_000_000);
		expect(result.rows.at(-1)?.maximumBitrate).toBeGreaterThan(3_000_000);
	});

	it.each([
		false,
		true,
	])("projects placements independently of ordinary candidate dimensions and expansion (%s)", (expanded) => {
		const proposal = ordinary();
		if (!expanded) delete proposal.api.global.autoRepresentations;
		const options = { countPolicy: { kind: "exact", count: 3 } } as const;
		const before = previewPerTitleOutput(proposal, options);
		proposal.api.streams = [
			{ rowId: "first", mode: "PER_TITLE_TEMPLATE" },
			{
				rowId: "second",
				width: 1920,
				height: 1080,
				mode: "PER_TITLE_TEMPLATE",
			},
		];
		expect(previewPerTitleOutput(proposal, options)).toEqual(before);
	});

	it("does not turn a maximum count into a mandatory exact layout", () => {
		const proposal = ordinary();
		const baseline = previewPerTitleOutput(proposal);
		const result = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "maximum", count: 6 },
		});
		expect(result.countProjection).toEqual({
			kind: "maximum",
			requestedCount: 6,
			status: "unavailable",
			reason: "maximum-only",
		});
		expect(result.rows).toEqual(baseline.rows);
		expect(
			previewPerTitleOutput(proposal, {
				countPolicy: { kind: "unrestricted" },
			}),
		).toEqual(baseline);
	});

	it("ignores spacing witnesses and scenario metadata when projecting requested slots", () => {
		const proposal = ordinary();
		const options = { countPolicy: { kind: "exact", count: 3 } } as const;
		const before = previewPerTitleOutput(proposal, options);
		const unrelated = recommendPerTitleSettings(fixed);
		proposal.scenarios = unrelated.scenarios;
		proposal.derivation = unrelated.derivation;
		expect(previewPerTitleOutput(proposal, options)).toEqual(before);
		proposal.scenarios = [];
		delete proposal.derivation;
		expect(previewPerTitleOutput(proposal, options)).toEqual(before);
	});

	it.each([
		conditional,
		mixed,
		() => recommendPerTitleSettings(fixed),
	])("keeps fixed or mixed structures outside the pure ordinary projection", (fixture) => {
		const proposal = fixture();
		const baseline = previewPerTitleOutput(proposal);
		for (const kind of ["exact", "maximum"] as const) {
			const result = previewPerTitleOutput(proposal, {
				countPolicy: { kind, count: 3 },
			});
			expect(result.countProjection).toBeUndefined();
			expect(result).toEqual(baseline);
		}
	});

	it("does not apply the ordinary proof to positive forced counts", () => {
		const proposal = ordinary();
		proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode: "MAXIMUM",
		};
		const result = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count: 3 },
		});
		expect(result.countProjection).toMatchObject({
			status: "unavailable",
			reason: "unsupported-configuration",
		});
		expect(result.rows).toEqual(previewPerTitleOutput(proposal).rows);
	});

	it("treats a zero forced-count object like absence for this placement proof", () => {
		const proposal = ordinary();
		const options = { countPolicy: { kind: "exact", count: 3 } } as const;
		const baseline = previewPerTitleOutput(proposal, options);
		proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
		};
		expect(previewPerTitleOutput(proposal, options)).toEqual(baseline);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Infinity,
		257,
	])("keeps invalid or unsupported requested count %s out of slot rows", (count) => {
		const proposal = ordinary();
		const result = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count },
		});
		expect(result.countProjection).toMatchObject({
			status: "unavailable",
			reason: count === 257 ? "model-limit" : "invalid-count",
		});
		expect(result.rows).toEqual(previewPerTitleOutput(proposal).rows);
	});

	it.each([
		{ minBitrate: 0 },
		{ maxBitrate: 2_147_483_648 },
		{ minBitrateStepSize: 1 },
		{ maxBitrateStepSize: Number.NaN },
		{ maxBitrateStepSize: 1.49 },
	])("keeps invalid API arithmetic inputs out of slot rows (%j)", (override) => {
		const proposal = ordinary();
		Object.assign(proposal.api.global, override);
		const result = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count: 3 },
		});
		expect(result.countProjection).toMatchObject({
			status: "unavailable",
			reason: "invalid-input",
		});
		expect(result.rows.some((row) => row.kind === "count-slot")).toBe(false);
	});
});

describe("Per-Title output previews", () => {
	it("uses an explicit capped analysis input for exact row interpolation", () => {
		const proposal = conditional();
		const before = structuredClone(proposal);
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 575 }),
		).toMatchObject({
			requestedAnalysisInput: 575,
			analysisInput: 575,
			rows: [{ bitrate: 250, minimumBitrate: 250, maximumBitrate: 250 }],
		});
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 3000 }),
		).toMatchObject({
			requestedAnalysisInput: 3000,
			analysisInput: 1000,
			rows: [{ bitrate: 294 }],
		});
		expect(previewPerTitleOutput(proposal).requestedAnalysisInput).toBe(1000);
		expect(proposal).toEqual(before);
	});

	it("selects the lower endpoint only for a closed narrow effective interval", () => {
		const proposal = conditional();
		proposal.api.global.minBitrateStepSize = 4;
		required(proposal.api.streams[0]?.perTitleSettings).maxBitrate = 800;
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 1000 }).rows[0],
		).toMatchObject({
			status: "conditional",
			rangeBasis: "effective",
			minimumBitrate: 250,
			maximumBitrate: 484,
			bitrate: 250,
		});
		// The interval ratio 484/250 is below 4 - .01; the first point is 250,
		// not the interval's upper target, and a second ordinary step cannot fit.
	});

	it.each([
		Number.NaN,
		Infinity,
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER,
	])("keeps an invalid explicit analysis input unavailable (%s)", (analysisInput) => {
		const result = previewPerTitleOutput(mixed(), { analysisInput });
		expect(result.analysisInput).toBeNull();
		expect(result.status).toBe("unavailable");
		expect(result.rows.every((row) => row.bitrate === undefined)).toBe(true);
	});

	it("groups higher automatic candidates into an assumed band without selecting a point or resolution", () => {
		const proposal = mixed();
		const result = previewPerTitleOutput(proposal, { analysisInput: 900 });
		const top = result.rows.filter((row) => row.basis === "analysis");
		expect(top).toEqual([
			expect.objectContaining({
				kind: "automatic-group",
				status: "conditional",
				rangeBasis: "assumed",
				minimumBitrate: 338,
				maximumBitrate: 900,
				candidateRowIds: ["large", "largest"],
			}),
		]);
		// At C=900 the fixed target is 284. The next possible ordinary rate
		// starts at ceil(284 * (1.2 - .01)) = 338, not at the assumed cap 900.
		expect(top[0]?.bitrate).toBeUndefined();
		expect(top[0]?.height).toBeUndefined();
		expect(top[0]?.width).toBeUndefined();
		expect(top[0]?.rowId).toBeUndefined();
		expect(
			result.rows.some(
				(row) => row.rowId === "large" || row.rowId === "largest",
			),
		).toBe(false);
		expect(result.rows.filter((row) => row.basis === "forced")).toEqual([]);
		expect(result.forcedFallback).toMatchObject({
			minimumBitrate: 355,
			maximumBitrate: 355,
		});
		expect(result.unresolvedAdditional).toBe(true);
		expect(result.rows.find((row) => row.basis === "minimum")?.bitrate).toBe(
			100,
		);
		expect(result.status).toBe("partial");
	});

	it("separates an ordinary upper hypothesis from the conditional forced fallback", () => {
		const proposal = mixed();
		proposal.api.global.maxBitrate = 2400;
		proposal.api.global.minBitrateStepSize = 1.5;
		const settings = required(proposal.api.streams[0]?.perTitleSettings);
		settings.maxBitrate = 600;
		const rule = required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		);
		rule.forcedRenditionAboveHighestFixedRepresentationFactor = 1.2;
		const before = structuredClone(proposal);
		const result = previewPerTitleOutput(proposal);
		expect(result.rows.find((row) => row.basis === "analysis")).toMatchObject({
			kind: "automatic-group",
			rangeBasis: "assumed",
			minimumBitrate: 894,
			maximumBitrate: 2400,
		});
		expect(
			result.rows.find((row) => row.basis === "analysis")?.bitrate,
		).toBeUndefined();
		expect(result.forcedFallback).toEqual({
			baseMinimumBitrate: 600,
			baseMaximumBitrate: 600,
			minimumBitrate: 720,
			maximumBitrate: 720,
			count: 1,
			factor: 1.2,
		});
		expect(result.rows.filter((row) => row.basis === "forced")).toEqual([]);
		expect(result.rows.map((row) => row.kind)).toEqual([
			"fixed",
			"automatic",
			"automatic-group",
		]);
		expect(result.unresolvedAdditional).toBe(true);
		expect(proposal).toEqual(before);
	});

	it("rounds each hypothetical forced step for every supported nominal mode", () => {
		const proposal = mixed();
		proposal.api.global.maxBitrate = 600;
		const settings = required(proposal.api.streams[0]?.perTitleSettings);
		settings.minBitrate = 201;
		settings.maxBitrate = 201;
		const rule = required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		);
		rule.forcedRenditionAboveHighestFixedRepresentation = 2;
		rule.forcedRenditionAboveHighestFixedRepresentationFactor = 1.5;
		expect(previewPerTitleOutput(proposal).forcedFallback).toMatchObject({
			minimumBitrate: 453,
			maximumBitrate: 453,
			count: 2,
		});
		rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode =
			"MAXIMUM";
		expect(previewPerTitleOutput(proposal).forcedFallback).toMatchObject({
			minimumBitrate: 453,
			maximumBitrate: 453,
		});
		rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode =
			"UNKNOWN" as "MAXIMUM";
		expect(previewPerTitleOutput(proposal).forcedFallback).toBeUndefined();
	});

	it("does not require a forced rule or select a resolution for one upper candidate", () => {
		const proposal = mixed();
		delete proposal.api.global.fixedResolutionAndBitrateConfiguration;
		proposal.api.streams = proposal.api.streams.filter(
			(stream) => stream.rowId !== "largest",
		);
		const top = previewPerTitleOutput(proposal).rows.find(
			(row) => row.basis === "analysis",
		);
		expect(top).toMatchObject({
			kind: "automatic-group",
			rangeBasis: "assumed",
			minimumBitrate: 350,
			maximumBitrate: 1000,
			status: "conditional",
			candidateRowIds: ["large"],
		});
		expect(top?.bitrate).toBeUndefined();
		expect(top?.height).toBeUndefined();
		expect(top?.rowId).toBeUndefined();
	});

	it("bounds an ordinary group by the minimum step without assuming one maximum-step jump", () => {
		const proposal = mixed();
		for (const analysisInput of [100, 247]) {
			expect(
				previewPerTitleOutput(proposal, { analysisInput }).rows.some(
					(row) => row.basis === "analysis",
				),
			).toBe(false);
		}
		// The floor raises C to 250, yielding [208,215]. An ordinary upper
		// rate first fits at ceil(208 * 1.19) = 248, while the raw cap stays V.
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 248 }).rows.find(
				(row) => row.basis === "analysis",
			),
		).toMatchObject({ minimumBitrate: 248, maximumBitrate: 248 });
		proposal.api.global.maxBitrateStepSize = 2;
		expect(
			previewPerTitleOutput(proposal).rows.find(
				(row) => row.basis === "analysis",
			),
		).toMatchObject({ minimumBitrate: 350, maximumBitrate: 1000 });
		proposal.api.global.maxBitrateStepSize = 4;
		proposal.api.streams.push({
			rowId: "same-dimension",
			height: 900,
			mode: "PER_TITLE_TEMPLATE",
		});
		const top = previewPerTitleOutput(proposal).rows.find(
			(row) => row.basis === "analysis",
		);
		expect(top?.candidateRowIds).toEqual([
			"large",
			"same-dimension",
			"largest",
		]);
		expect(top?.bitrate).toBeUndefined();
		expect(top?.height).toBeUndefined();
		expect(top?.rowId).toBeUndefined();
	});

	it("does not reuse an upper scenario as proof for a different analysis input", () => {
		const proposal = recommendPerTitleSettings(fixed);
		const result = previewPerTitleOutput(proposal, {
			analysisInput: 1_500_000,
		});
		expect(result.rows.every((row) => row.status !== "example")).toBe(true);
	});

	it.each([
		false,
		true,
	])("checks every tied first fixed dimension before binding the minimum (reversed %s)", (reversed) => {
		const proposal = mixed();
		proposal.api.global.minBitrateStepSize = 2;
		const high = required(proposal.api.streams[0]);
		Object.assign(required(high.perTitleSettings), {
			minBitrate: 400,
			maxBitrate: 500,
			lowComplexityBoundaryForMaxBitrate: 100,
			highComplexityBoundaryForMaxBitrate: 1000,
		});
		const low = structuredClone(high);
		low.rowId = "lower-range";
		Object.assign(required(low.perTitleSettings), {
			minBitrate: 110,
			maxBitrate: 150,
		});
		if (reversed) proposal.api.streams.unshift(low);
		else proposal.api.streams.push(low);
		expect(
			previewPerTitleOutput(proposal).rows.find((row) => row.rowId === "small"),
		).toMatchObject({ status: "unknown" });
	});
	it("starts the unique smaller explicit template at the global minimum", () => {
		const proposal = mixed();
		const before = structuredClone(proposal);
		expect(previewPerTitleOutput(proposal).rows).toContainEqual(
			expect.objectContaining({
				rowId: "small",
				kind: "automatic",
				basis: "minimum",
				status: "conditional",
				bitrate: 100,
			}),
		);
		expect(proposal).toEqual(before);
	});

	it("keeps a LAST_CALCULATED_BITRATE interval conditional and its destination unresolved", () => {
		const result = previewPerTitleOutput(mixed(), { analysisInput: 100 });
		const additional = result.rows.filter((row) => row.basis === "forced");
		// F=trunc(200 * 1.25)=250 raises C above the assumed cap 100.
		// q=round(250/1.2)=208 and t=215; one rounded addition is [260,269].
		expect(result).toMatchObject({ floor: 250, complexityInput: 250 });
		expect(additional).toEqual([
			expect.objectContaining({
				basis: "forced",
				status: "conditional",
				rangeBasis: "effective",
				minimumBitrate: 260,
				maximumBitrate: 269,
				candidateRowIds: ["large", "largest"],
			}),
		]);
		expect(additional[0]?.bitrate).toBeUndefined();
		expect(additional[0]?.height).toBeUndefined();
		expect(additional[0]?.width).toBeUndefined();
		expect(additional[0]?.rowId).toBeUndefined();
		expect(
			result.rows.some(
				(row) => row.rowId === "large" || row.rowId === "largest",
			),
		).toBe(false);
		expect(result.rows.map((row) => row.kind)).toEqual([
			"fixed",
			"automatic",
			"additional",
		]);
		expect(result.status).toBe("partial");
	});

	it.each([
		undefined,
		{ kind: "exact" as const, count: 2 },
		{ kind: "exact" as const, count: 9 },
		{ kind: "maximum" as const, count: 1 },
	])("consumes upper prototypes only in the displayed forced branch, independently of count policy %j", (countPolicy) => {
		const proposal = mixed();
		const before = structuredClone(proposal);
		const result = previewPerTitleOutput(proposal, {
			analysisInput: 100,
			countPolicy,
		});
		expect(result.rows.map((row) => row.kind)).toEqual([
			"fixed",
			"automatic",
			"additional",
		]);
		expect(result.rows.map((row) => row.rowId)).toEqual([
			"fixed",
			"small",
			undefined,
		]);
		expect(result.rows.at(-1)).toMatchObject({
			basis: "forced",
			status: "conditional",
			minimumBitrate: 260,
			maximumBitrate: 269,
			candidateRowIds: ["large", "largest"],
		});
		expect(result.forcedFallback).toEqual({
			baseMinimumBitrate: 208,
			baseMaximumBitrate: 215,
			minimumBitrate: 260,
			maximumBitrate: 269,
			count: 1,
			factor: 1.25,
		});
		expect(result.countProjection).toBeUndefined();
		expect(result.unresolvedAdditional).toBe(true);
		expect(proposal).toEqual(before);
	});

	it.each([
		["LAST_CALCULATED_BITRATE", [278, 348]],
		["MINIMUM", [250, 313]],
		["MAXIMUM", [500, 625]],
		["AVERAGE", [375, 469]],
	] as const)("keeps every rounded %s forced step as a role rather than repeating its destination candidates", (mode, points) => {
		const proposal = mixed();
		const rule = required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		);
		rule.forcedRenditionAboveHighestFixedRepresentation = 2;
		rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode = mode;
		const result = previewPerTitleOutput(proposal, { analysisInput: 100 });
		expect(result.rows.map((row) => row.kind)).toEqual([
			"fixed",
			"automatic",
			"additional",
			"additional",
		]);
		expect(result.rows.filter((row) => row.basis === "forced")).toEqual(
			points.map((point) =>
				expect.objectContaining({
					status: "conditional",
					bitrate: point,
					candidateRowIds: ["large", "largest"],
				}),
			),
		);
		expect(
			result.rows
				.filter((row) => row.basis === "forced")
				.every(
					(row) =>
						row.rowId === undefined &&
						row.height === undefined &&
						row.width === undefined,
				),
		).toBe(true);
	});

	it.each([
		"missing-count",
		"unsupported-mode",
		"invalid-fixed-range",
		"overlapping-fixed-order",
	] as const)("retains unknown upper prototypes when forced output is unresolved: %s", (reason) => {
		const proposal = mixed();
		const rule = required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		);
		if (reason === "missing-count")
			delete rule.forcedRenditionAboveHighestFixedRepresentation;
		else if (reason === "unsupported-mode")
			rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode =
				"UNKNOWN" as "MAXIMUM";
		else if (reason === "invalid-fixed-range")
			required(proposal.api.streams[0]?.perTitleSettings).maxBitrate = 1001;
		else {
			const duplicate = structuredClone(required(proposal.api.streams[0]));
			duplicate.rowId = "overlapping-fixed";
			proposal.api.streams.push(duplicate);
		}
		const before = structuredClone(proposal);
		const result = previewPerTitleOutput(proposal, { analysisInput: 100 });
		expect(result.rows.filter((row) => row.basis === "forced")).toEqual([]);
		expect(result.forcedFallback).toBeUndefined();
		for (const rowId of ["large", "largest"])
			expect(result.rows.find((row) => row.rowId === rowId)).toMatchObject({
				kind: "automatic",
				status: "unknown",
			});
		expect(proposal).toEqual(before);
	});

	it("rounds each conditional additional step and does not clip it to the global maximum", () => {
		const proposal = mixed();
		const rule = required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		);
		rule.forcedRenditionAboveHighestFixedRepresentation = 3;
		rule.forcedRenditionAboveHighestFixedRepresentationFactor = 2.1;
		// F=trunc(200 * 2.1^3)=1852 and t(1852)=384. Additional
		// multiplication rounds each step: 806, 1693, 3555; U remains 1000.
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 100 })
				.rows.filter((row) => row.basis === "forced")
				.map((row) => row.bitrate),
		).toEqual([806, 1693, 3555]);
	});

	it("does not bind arithmetic examples to templates expanded by autoRepresentations", () => {
		const proposal = mixed();
		proposal.api.global.autoRepresentations = {};
		const result = previewPerTitleOutput(proposal);
		expect(
			result.rows
				.filter((row) => row.kind === "automatic")
				.every((row) => row.status === "unknown" && row.bitrate === undefined),
		).toBe(true);
		expect(result.rows.map((row) => row.kind)).toEqual([
			"fixed",
			"automatic-group",
		]);
		expect(result.rows.filter((row) => row.basis === "forced")).toEqual([]);
		expect(result.forcedFallback).toMatchObject({ count: 1, factor: 1.25 });
		expect(result.unresolvedAdditional).toBe(true);
	});

	it("does not choose among several lower candidates or bind an unresolved dimension order", () => {
		const proposal = mixed();
		proposal.api.streams.push({
			rowId: "another-small",
			height: 240,
			mode: "PER_TITLE_TEMPLATE",
		});
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.basis !== "minimum",
			),
		).toBe(true);
		required(proposal.api.streams[0]).width = 640;
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.basis === undefined,
			),
		).toBe(true);
	});

	it("requires room below the first fixed bound for a minimum example", () => {
		const proposal = mixed();
		const settings = required(proposal.api.streams[0]?.perTitleSettings);
		settings.minBitrate = 100;
		settings.maxBitrate = 110;
		settings.bitrateSelectionMode = "OPTIMIZED";
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.basis !== "minimum",
			),
		).toBe(true);
	});

	it("does not turn a range outside the global limits into a simulated ladder", () => {
		const proposal = mixed();
		required(proposal.api.streams[0]?.perTitleSettings).maxBitrate = 40_000_000;
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.bitrate === undefined,
			),
		).toBe(true);
	});

	it("uses emitted intervals rather than a checked upper placement witness", () => {
		const proposal = recommendPerTitleSettings(fixed);
		const before = structuredClone(proposal);
		const upper = proposal.scenarios.find(
			(scenario) => scenario.fraction === 1,
		);
		expect(upper?.status).toBe("modelled");
		const result = previewPerTitleOutput(proposal);
		expect(result).toMatchObject({
			analysisInput: fixed.maxBitrate,
			status: "partial",
			// Per-row intervals do not establish closure of the entire ladder.
			unresolvedAdditional: true,
		});
		expect(
			result.rows.every(
				(row) => row.kind === "fixed" && row.status === "conditional",
			),
		).toBe(true);
		const withoutWitness = structuredClone(proposal);
		withoutWitness.scenarios = [];
		withoutWitness.derivation = undefined;
		expect(previewPerTitleOutput(withoutWitness)).toEqual(result);
		expect(proposal).toEqual(before);
	});

	it("derives conditional additional intervals from emitted rules without consuming a checked witness", () => {
		const proposal = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 5 },
		});
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows).toHaveLength(5);
		expect(result.rows.filter((row) => row.kind === "additional")).toHaveLength(
			2,
		);
		expect(
			result.rows
				.filter((row) => row.kind === "additional")
				.every(
					(row) =>
						row.status === "conditional" &&
						row.height === undefined &&
						row.rowId === undefined,
				),
		).toBe(true);
		required(proposal.derivation?.constraints).status = "unknown";
		expect(previewPerTitleOutput(proposal)).toEqual(result);
	});

	it("keeps equal-height mixed templates as conditional fixed rows and unresolved automatic candidates", () => {
		const proposal = recommendPerTitleSettings({
			...fixed,
			rows: fixed.rows?.map((row, index) => ({
				...row,
				height: index < 2 ? 360 : 720,
			})),
			automaticTemplates: [
				{ id: "small-candidate", height: 180 },
				{ id: "large-candidate", height: 1080 },
			],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		const before = structuredClone(proposal);
		expect(
			proposal.api.streams[0]?.perTitleSettings?.bitrateSelectionMode,
		).toBe("COMPLEXITY_RANGE");
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows.filter((row) => row.kind === "fixed")).toHaveLength(3);
		const automatic = result.rows.filter(
			(row) => row.kind === "automatic-group",
		);
		expect(automatic).toEqual([
			expect.objectContaining({
				status: "conditional",
				rangeBasis: "assumed",
			}),
		]);
		expect(automatic[0]?.height).toBeUndefined();
		expect(automatic[0]?.bitrate).toBeUndefined();
		expect(result.unresolvedAdditional).toBe(true);
		expect(proposal).toEqual(before);
	});

	it("evaluates only actual emitted settings at the global maximum, not stale scenario fields", () => {
		const proposal = conditional();
		proposal.scenarios = [
			{
				id: "untrusted",
				fraction: 1,
				assumedMaxBitrate: 9000,
				status: "conflict",
				modelCountRange: null,
				rowModels: [
					{
						rowId: "fixed",
						minimumBitrate: 9000,
						maximumBitrate: 9000,
						linearTargetBitrate: 9000,
						boundaryFraction: 1,
					},
				],
				modelRungs: [
					{ rowId: "fixed", height: 360, bitrate: 9000, kind: "required" },
				],
				diagnostics: [],
			},
		];
		expect(previewPerTitleOutput(proposal)).toMatchObject({
			analysisInput: 1000,
			status: "partial",
			rows: [
				{
					kind: "fixed",
					status: "conditional",
					minimumBitrate: 294,
					maximumBitrate: 294,
					bitrate: 294,
				},
			],
		});
	});

	it.each([
		{ lowComplexityBoundaryForMaxBitrate: undefined },
		{ highComplexityBoundaryForMaxBitrate: Number.NaN },
		{
			lowComplexityBoundaryForMaxBitrate: 2000,
			highComplexityBoundaryForMaxBitrate: 100,
		},
		{ minBitrate: 99 },
	])("does not fabricate numbers from invalid fixed settings %j", (change) => {
		const proposal = conditional();
		Object.assign(required(proposal.api.streams[0]?.perTitleSettings), change);
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("unavailable");
		expect(result.rows[0]).toMatchObject({ kind: "fixed", status: "unknown" });
		expect(result.rows[0]?.bitrate).toBeUndefined();
		expect(result.rows[0]?.minimumBitrate).toBeUndefined();
	});

	it("shows one assumed automatic band instead of nine arithmetic witness points", () => {
		const proposal = conditional();
		proposal.api.streams = [
			{ rowId: "candidate", height: 720, mode: "PER_TITLE_TEMPLATE" },
		];
		proposal.scenarios = [
			{
				id: "upper",
				fraction: 1,
				assumedMaxBitrate: 1000,
				status: "modelled",
				modelCountRange: null,
				rowModels: [],
				modelRungs: [100, 125, 157, 197, 247, 309, 387, 484, 605].map(
					(bitrate) => ({ bitrate, kind: "illustrative" }),
				),
				diagnostics: [],
			},
		];
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows).toEqual([
			expect.objectContaining({
				kind: "automatic-group",
				status: "conditional",
				rangeBasis: "assumed",
				minimumBitrate: 100,
				maximumBitrate: 1000,
			}),
		]);
		expect(result.rows[0]?.height).toBeUndefined();
		expect(result.rows[0]?.width).toBeUndefined();
		expect(result.rows[0]?.rowId).toBeUndefined();
		expect(result.rows[0]?.bitrate).toBeUndefined();
		expect(result.unresolvedAdditional).toBe(true);
	});

	it("rejects a stale upper example after emitted row settings change", () => {
		const proposal = recommendPerTitleSettings(fixed);
		required(proposal.api.streams[0]?.perTitleSettings).maxBitrate = 180_000;
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows[0]).toMatchObject({
			status: "conditional",
			bitrate: 180_000,
		});
		expect(result.rows.every((row) => row.status !== "example")).toBe(true);
	});

	it("does not pick one of several contradictory upper examples", () => {
		const proposal = recommendPerTitleSettings(fixed);
		const before = previewPerTitleOutput(proposal);
		proposal.scenarios.push(
			structuredClone(
				required(
					proposal.scenarios.find((scenario) => scenario.fraction === 1),
				),
			),
		);
		expect(previewPerTitleOutput(proposal)).toEqual(before);
		expect(before.status).toBe("partial");
	});

	it("ignores witness dimensions and coverage instead of using them as output evidence", () => {
		const proposal = recommendPerTitleSettings(fixed);
		const before = previewPerTitleOutput(proposal);
		const upper = required(
			proposal.scenarios.find((scenario) => scenario.fraction === 1),
		);
		required(upper.modelRungs[0]).height = 999;
		expect(previewPerTitleOutput(proposal)).toEqual(before);
		upper.modelRungs.shift();
		expect(previewPerTitleOutput(proposal)).toEqual(before);
		expect(before.rows.every((row) => row.status !== "example")).toBe(true);
	});

	it("does not show a joint example that violates the emitted ordinary steps", () => {
		const proposal = recommendPerTitleSettings(fixed);
		proposal.api.global.minBitrateStepSize = 3;
		proposal.api.global.maxBitrateStepSize = 4;
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows.every((row) => row.status !== "example")).toBe(true);
	});

	it("does not reuse additional points after their emitted rule changes", () => {
		const proposal = mixed();
		Object.assign(required(proposal.api.streams[0]?.perTitleSettings), {
			minBitrate: 201,
			maxBitrate: 201,
		});
		const rule = required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		);
		rule.forcedRenditionAboveHighestFixedRepresentation = 2;
		rule.forcedRenditionAboveHighestFixedRepresentationFactor = 1.5;
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 100 })
				.rows.filter((row) => row.basis === "forced")
				.map((row) => row.bitrate),
		).toEqual([302, 453]);
		rule.forcedRenditionAboveHighestFixedRepresentationFactor = 1.01;
		const result = previewPerTitleOutput(proposal, { analysisInput: 100 });
		expect(result.unresolvedAdditional).toBe(true);
		// The emitted factor now rounds 201*1.01 to 203, then 203*1.01 to 205.
		expect(
			result.rows
				.filter((row) => row.basis === "forced")
				.map((row) => row.bitrate),
		).toEqual([203, 205]);
	});

	it("keeps malformed duplicate identifiers unique in the view without using them for numeric proof", () => {
		const proposal = conditional();
		proposal.api.streams.push(
			structuredClone(required(proposal.api.streams[0])),
		);
		proposal.api.streams.push({
			rowId: "fixed",
			height: 180,
			mode: "PER_TITLE_TEMPLATE",
		});
		const result = previewPerTitleOutput(proposal);
		expect(new Set(result.rows.map((row) => row.id)).size).toBe(3);
		expect(
			result.rows.every(
				(row) => row.status === "unknown" && row.bitrate === undefined,
			),
		).toBe(true);
	});

	it("labels resolution-only and optimized intervals as configured without selecting their upper endpoints", () => {
		const proposal = conditional();
		required(proposal.api.streams[0]?.perTitleSettings).bitrateSelectionMode =
			"OPTIMIZED";
		proposal.api.streams.push({
			rowId: "resolution",
			height: 720,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(
			result.rows.every(
				(row) =>
					row.status === "conditional" &&
					row.rangeBasis === "configured" &&
					row.bitrate === undefined,
			),
		).toBe(true);
		expect(result.rows).toMatchObject([
			{ minimumBitrate: 200, maximumBitrate: 400 },
			{ minimumBitrate: 100, maximumBitrate: 1000 },
		]);
		expect(result.rows[0]?.width).toBe(640);
	});

	it.each(
		(
			[
				["LAST_CALCULATED_BITRATE", 294, 662],
				["MINIMUM", 200, 450],
				["MAXIMUM", 400, 900],
				["AVERAGE", 300, 675],
			] as const
		).flatMap(([mode, base, last]) =>
			[false, true].map((ordinaryUpper) => ({
				mode,
				base,
				last,
				ordinaryUpper,
			})),
		),
	)("uses the $mode base without simultaneous alternative outputs (ordinary upper: $ordinaryUpper)", ({
		mode,
		base,
		last,
		ordinaryUpper,
	}) => {
		const proposal = mixed();
		if (!ordinaryUpper)
			proposal.api.streams = proposal.api.streams.filter(
				(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
			);
		Object.assign(
			required(proposal.api.global.fixedResolutionAndBitrateConfiguration),
			{
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode: mode,
			},
		);
		// F=trunc(200*1.5^2)=450, below V=1000. The effective fixed point
		// remains 200+floor(900*200/1900)=294; nominal modes use 200/400/300.
		const result = previewPerTitleOutput(proposal);
		expect(result.forcedFallback).toEqual({
			baseMinimumBitrate: base,
			baseMaximumBitrate: base,
			minimumBitrate: last,
			maximumBitrate: last,
			count: 2,
			factor: 1.5,
		});
		const additional = result.rows.filter((row) => row.basis === "forced");
		if (ordinaryUpper) {
			expect(additional).toEqual([]);
			expect(
				result.rows.filter((row) => row.basis === "analysis"),
			).toHaveLength(1);
		} else {
			expect(additional).toHaveLength(2);
			expect(additional.at(-1)?.bitrate).toBe(last);
			expect(result.rows.some((row) => row.basis === "analysis")).toBe(false);
		}
		expect(
			additional.every(
				(row) =>
					row.status === "conditional" &&
					row.height === undefined &&
					row.width === undefined &&
					row.rowId === undefined,
			),
		).toBe(true);
		expect(additional[0]?.candidateRowIds).toBeUndefined();
	});

	it("does not invent a selected bitrate when an effective interval admits another step", () => {
		const proposal = conditional();
		Object.assign(proposal.api.global, {
			maxBitrate: 2000,
			minBitrateStepSize: 1.5,
		});
		Object.assign(required(proposal.api.streams[0]?.perTitleSettings), {
			minBitrate: 200,
			maxBitrate: 1200,
			lowComplexityBoundaryForMaxBitrate: 200,
			highComplexityBoundaryForMaxBitrate: 1200,
		});
		// At C=600 the public interpolation gives t=600 and q=round(600/1.5)=400.
		// The ratio 600/400 is 1.5, so a single template is not a one-output proof.
		const result = previewPerTitleOutput(proposal, { analysisInput: 600 });
		expect(result.rows[0]).toMatchObject({
			status: "conditional",
			rangeBasis: "effective",
			minimumBitrate: 400,
			maximumBitrate: 600,
		});
		expect(result.rows[0]?.bitrate).toBeUndefined();
		expect(result.unresolvedAdditional).toBe(true);
	});

	it.each([
		[0.5, 100],
		[1, 200],
	])("retains a positive additional factor %s without clipping or deduplicating its result", (factor, bitrate) => {
		const proposal = mixed();
		proposal.api.global.minBitrate = 150;
		Object.assign(required(proposal.api.streams[0]?.perTitleSettings), {
			minBitrate: 200,
			maxBitrate: 200,
		});
		Object.assign(
			required(proposal.api.global.fixedResolutionAndBitrateConfiguration),
			{
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: factor,
			},
		);
		// A nominal point remains 200 even when F=trunc(200*factor) changes.
		// Factor .5 adds 100 below G=150; factor 1 adds a second 200 point.
		const result = previewPerTitleOutput(proposal, { analysisInput: 150 });
		expect(result.forcedFallback).toMatchObject({
			baseMinimumBitrate: 200,
			baseMaximumBitrate: 200,
			minimumBitrate: bitrate,
			maximumBitrate: bitrate,
			factor,
			count: 1,
		});
		expect(result.rows.filter((row) => row.basis === "forced")).toEqual([
			expect.objectContaining({
				status: "conditional",
				bitrate,
				minimumBitrate: bitrate,
				maximumBitrate: bitrate,
				candidateRowIds: ["large", "largest"],
			}),
		]);
	});

	it("does not apply a forced fallback on the resolution-only calculator branch", () => {
		const proposal = mixed();
		proposal.api.streams = [
			{
				rowId: "resolution",
				height: 720,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		];
		const result = previewPerTitleOutput(proposal);
		expect(result.rows[0]).toMatchObject({
			rangeBasis: "configured",
			minimumBitrate: 100,
			maximumBitrate: 1000,
		});
		expect(result.rows[0]?.bitrate).toBeUndefined();
		expect(result.forcedFallback).toBeUndefined();
		expect(result.rows.some((row) => row.basis === "forced")).toBe(false);
		expect(result.unresolvedAdditional).toBe(true);
	});

	it("withholds effective numbers when a forced factor overflows the analysis floor", () => {
		const proposal = mixed();
		Object.assign(
			required(proposal.api.global.fixedResolutionAndBitrateConfiguration),
			{
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: Number.MAX_VALUE,
			},
		);
		const result = previewPerTitleOutput(proposal);
		expect(result).toMatchObject({
			floor: null,
			complexityInput: null,
			status: "unavailable",
		});
		expect(
			result.rows.every(
				(row) =>
					row.bitrate === undefined &&
					row.minimumBitrate === undefined &&
					row.maximumBitrate === undefined,
			),
		).toBe(true);
		expect(result.forcedFallback).toBeUndefined();
	});

	it("keeps candidates visible with unavailable global inputs and incomplete additional settings", () => {
		const proposal = conditional();
		proposal.api.global.maxBitrate = Number.NaN;
		proposal.api.global.fixedResolutionAndBitrateConfiguration = {};
		proposal.api.streams.push({
			rowId: "candidate",
			mode: "PER_TITLE_TEMPLATE",
		});
		const result = previewPerTitleOutput(proposal);
		expect(result.analysisInput).toBeNull();
		expect(result.status).toBe("unavailable");
		expect(result.rows).toHaveLength(2);
		expect(result.rows.every((row) => row.bitrate === undefined)).toBe(true);
		expect(result.unresolvedAdditional).toBe(true);
	});
});
