import { describe, expect, it } from "vitest";
import {
	type PerTitleGoal,
	proposePerTitleSettings,
} from "./per-title-simulator.js";

const automatic: PerTitleGoal = {
	strategy: "automatic",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 1_600_000,
	minBitrateStepSize: 2,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "unrestricted" },
};

describe("proposePerTitleSettings", () => {
	it("keeps automatic output counts separate from API fields and provider evidence", () => {
		const [proposal] = proposePerTitleSettings(automatic);
		expect(proposal).toMatchObject({
			codec: "H264",
			evidence: "model-only",
			countGuarantee: false,
			api: { global: { autoRepresentations: {} } },
		});
		expect(proposal?.api.global).not.toHaveProperty("count");
		expect(proposal?.scenarios).toHaveLength(3);
		expect(proposal?.scenarios[2]?.modelCountRange?.maximum).toBe(5);
	});

	it("reduces the modeled upper count through steps without inventing a count API field", () => {
		const proposals = proposePerTitleSettings({
			...automatic,
			strategy: "count",
			countPolicy: { kind: "maximum", count: 3 },
		});
		expect(proposals).toHaveLength(2);
		expect(proposals[0]?.applicable).toBe(false);
		const candidate = proposals[1];
		expect(candidate?.api.global.minBitrate).toBe(automatic.minBitrate);
		expect(candidate?.api.global.maxBitrate).toBe(automatic.maxBitrate);
		expect(
			candidate?.scenarios[2]?.modelCountRange?.maximum,
		).toBeLessThanOrEqual(3);
		expect(candidate?.api.global).not.toHaveProperty("count");
	});

	it("offers an explicit step change when an exact count needs closer spacing", () => {
		const [baseline, candidate] = proposePerTitleSettings({
			...automatic,
			strategy: "count",
			countPolicy: { kind: "exact", count: 6 },
		});
		expect(baseline?.applicable).toBe(false);
		expect(candidate?.api.global.minBitrateStepSize).toBeLessThan(2);
		expect(candidate?.scenarios[2]?.modelCountRange?.maximum).toBe(6);
		expect(candidate?.applicable).toBe(true);
	});

	it.each([
		"automatic",
		"count",
	] as const)("keeps %s count suggestions compatible with integer examples without claiming all scenarios meet the goal", (strategy) => {
		const [, candidate] = proposePerTitleSettings({
			...automatic,
			strategy,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 6 },
		});
		expect(candidate?.applicable).toBe(true);
		expect(candidate?.api.global).toMatchObject({
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
		});
		expect(candidate?.api.global.minBitrateStepSize).toBeLessThan(
			candidate?.api.global.maxBitrateStepSize ?? 0,
		);
		expect(candidate?.scenarios[2]?.modelCountRange?.maximum).toBe(6);
		expect(candidate?.scenarios[2]?.modelRungs).toHaveLength(6);
		expect(candidate?.scenarios[2]?.status).toBe("modelled");
		for (const scenario of candidate?.scenarios ?? []) {
			expect(
				scenario.diagnostics.some((item) => item.code === "row-step-conflict"),
			).toBe(false);
			for (let index = 1; index < scenario.modelRungs.length; index++) {
				const ratio =
					(scenario.modelRungs[index]?.bitrate ?? 0) /
					(scenario.modelRungs[index - 1]?.bitrate ?? 1);
				expect(ratio).toBeGreaterThanOrEqual(
					(candidate?.api.global.minBitrateStepSize ?? 1) - 1e-10,
				);
				expect(ratio).toBeLessThanOrEqual(
					(candidate?.api.global.maxBitrateStepSize ?? 1) + 1e-10,
				);
			}
		}
		expect(
			candidate?.scenarios[0]?.diagnostics.some(
				(item) => item.code === "count-unreachable",
			),
		).toBe(true);
		expect(candidate?.scenarios[0]?.status).toBe("conflict");
		expect(candidate?.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "scenario-conflict",
				severity: "warning",
			}),
		);
		expect(candidate?.countGuarantee).toBe(false);
	});

	it("does not invent a second bitrate point in a single-point interval", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "count",
			maxBitrate: automatic.minBitrate,
			countPolicy: { kind: "exact", count: 2 },
		});
		expect(proposal?.applicable).toBe(false);
		expect(
			proposal?.diagnostics.some((item) => item.code === "count-unreachable"),
		).toBe(true);
	});

	it("rejects an invalid source size before exporting an automatic template", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			inputHeight: Number.NaN,
		});
		expect(proposal?.applicable).toBe(false);
	});

	it("leaves an unspecified automatic template resolution to source analysis", () => {
		const [proposal] = proposePerTitleSettings(automatic);
		expect(proposal?.api.streams[0]?.height).toBeUndefined();
		expect(proposal?.api.streams[0]?.width).toBeUndefined();
	});

	it("shows an explicitly linear boundary example independently from the full interval count bound", () => {
		const row = {
			id: "r",
			height: 400,
			minBitrate: 100_000,
			maxBitrate: 400_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: 500_000,
			highComplexityBoundaryForMaxBitrate: 2_500_000,
		};
		const [wide] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			rows: [row],
		});
		const [narrow] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			rows: [{ ...row, highComplexityBoundaryForMaxBitrate: 1_000_000 }],
		});
		expect(wide?.scenarios[2]?.rowModels[0]?.linearTargetBitrate).toBe(265_000);
		expect(narrow?.scenarios[2]?.rowModels[0]?.linearTargetBitrate).toBe(
			400_000,
		);
		expect(narrow?.scenarios[2]?.modelCountRange).toEqual(
			wide?.scenarios[2]?.modelCountRange,
		);
		expect(
			narrow?.scenarios[2]?.diagnostics.some(
				(item) => item.code === "scenario-range-bound",
			),
		).toBe(true);
	});

	it("clamps the linear illustration below and at its public low/high boundaries", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			scenarioFractions: [0, 4 / 15, 0.4, 0.6, 1],
			rows: [
				{
					id: "r",
					height: 400,
					minBitrate: 100_000,
					maxBitrate: 400_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 500_000,
					highComplexityBoundaryForMaxBitrate: 1_000_000,
				},
			],
		});
		expect(
			proposal?.scenarios.map(
				(scenario) => scenario.rowModels[0]?.linearTargetBitrate,
			),
		).toEqual([100_000, 100_000, 220_000, 400_000, 400_000]);
	});

	it("keeps fixed resolution modes distinct from required resolutions with free additions", () => {
		const rows = [
			{ id: "required", height: 800, minBitrate: 123_456, maxBitrate: 234_567 },
		];
		const [required] = proposePerTitleSettings({
			...automatic,
			strategy: "required-resolutions",
			rows,
		});
		const [fixed] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-resolutions",
			rows,
		});
		expect(required?.api.streams.map((row) => row.mode)).toEqual([
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE",
		]);
		expect(required?.api.global.autoRepresentations).toEqual({});
		expect(fixed?.api.streams).toHaveLength(1);
		expect(fixed?.api.global.autoRepresentations).toBeUndefined();
		expect(fixed?.api.streams[0]?.perTitleSettings).toBeUndefined();
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		0,
		-1,
	])("rejects an invalid global bound %s without producing a zero-count success", (minBitrate) => {
		const [proposal] = proposePerTitleSettings({ ...automatic, minBitrate });
		expect(proposal?.applicable).toBe(false);
		expect(
			proposal?.scenarios.every(
				(scenario) =>
					scenario.status === "unknown" && scenario.modelCountRange === null,
			),
		).toBe(true);
	});

	it.each([
		1,
		0,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects the unsupported minimum step %s", (minBitrateStepSize) => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			minBitrateStepSize,
		});
		expect(proposal?.applicable).toBe(false);
		expect(
			proposal?.diagnostics.some((item) => item.code === "invalid-step"),
		).toBe(true);
	});

	it("bounds the work for a minimum step very close to one", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			minBitrateStepSize: 1 + Number.EPSILON,
		});
		expect(proposal?.applicable).toBe(false);
		expect(
			proposal?.diagnostics.some((item) => item.code === "model-limit"),
		).toBe(true);
		expect(
			proposal?.scenarios.every(
				(scenario) => scenario.modelCountRange === null,
			),
		).toBe(true);
	});

	it("preserves a single-point global interval", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			maxBitrate: automatic.minBitrate,
		});
		expect(
			proposal?.scenarios.every(
				(scenario) =>
					scenario.modelCountRange?.maximum === 1 &&
					scenario.modelRungs.length === 1,
			),
		).toBe(true);
	});

	it("requires both complexity boundaries and exports them without pretending to infer analysis", () => {
		const row = {
			id: "r",
			height: 400,
			minBitrate: 100_000,
			maxBitrate: 400_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
		};
		const [invalid] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			rows: [row],
		});
		expect(
			invalid?.diagnostics.some(
				(item) => item.code === "invalid-complexity-range",
			),
		).toBe(true);
		const [valid] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			rows: [
				{
					...row,
					lowComplexityBoundaryForMaxBitrate: 500_000,
					highComplexityBoundaryForMaxBitrate: 2_500_000,
				},
			],
		});
		expect(valid?.api.streams[0]?.perTitleSettings).toMatchObject({
			lowComplexityBoundaryForMaxBitrate: 500_000,
			highComplexityBoundaryForMaxBitrate: 2_500_000,
		});
		expect(
			valid?.diagnostics.some(
				(item) => item.code === "complexity-analysis-required",
			),
		).toBe(true);
	});

	it("can bridge a required gap by adjusting the maximum step without changing row intervals", () => {
		const goal: PerTitleGoal = {
			...automatic,
			strategy: "fixed-ranges",
			countPolicy: { kind: "maximum", count: 2 },
			rows: [
				{ id: "small", height: 400, minBitrate: 100_000, maxBitrate: 100_000 },
				{
					id: "large",
					height: 800,
					minBitrate: 1_000_000,
					maxBitrate: 1_000_000,
				},
			],
		};
		const [baseline, adjusted] = proposePerTitleSettings(goal);
		expect(
			baseline?.diagnostics.some((item) => item.code === "row-gap-conflict"),
		).toBe(true);
		expect(adjusted?.applicable).toBe(true);
		expect(adjusted?.api.global.maxBitrateStepSize).toBeCloseTo(10);
		expect(adjusted?.api.streams).toEqual(baseline?.api.streams);
	});

	it("reports an unreachable exact count instead of asserting that settings guarantee it", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "count",
			countPolicy: { kind: "exact", count: 10 },
		});
		expect(
			proposal?.scenarios.every(
				(scenario) =>
					scenario.status === "conflict" &&
					scenario.diagnostics.some(
						(item) => item.code === "count-unreachable",
					),
			),
		).toBe(true);
		expect(proposal?.countGuarantee).toBe(false);
	});

	it("does not mutate the requirements", () => {
		const goal = {
			...automatic,
			strategy: "fixed-ranges" as const,
			rows: [
				{ id: "b", height: 800, minBitrate: 500_000, maxBitrate: 800_000 },
				{ id: "a", height: 400, minBitrate: 100_000, maxBitrate: 200_000 },
			],
		};
		const before = structuredClone(goal);
		proposePerTitleSettings(goal);
		expect(goal).toEqual(before);
	});

	it("does not treat a count bound as a constructed exact-count example", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			countPolicy: { kind: "exact", count: 3 },
			rows: [
				{ id: "r", height: 400, minBitrate: 100_000, maxBitrate: 400_000 },
			],
		});
		expect(proposal?.scenarios[2]?.modelCountRange).toEqual({
			minimum: 1,
			maximum: 3,
		});
		expect(proposal?.scenarios[2]?.modelRungs).toHaveLength(1);
		expect(proposal?.scenarios[2]?.status).toBe("unknown");
	});

	it("does not reuse a required row ID for the automatic template", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "required-resolutions",
			rows: [{ id: "automatic-template", height: 400 }],
		});
		expect(new Set(proposal?.api.streams.map((row) => row.rowId)).size).toBe(2);
	});

	it("orders same-resolution ranges by bitrate without making edit order a constraint", () => {
		const high = {
			id: "high",
			height: 400,
			minBitrate: 600_000,
			maxBitrate: 900_000,
		};
		const low = {
			id: "low",
			height: 400,
			minBitrate: 300_000,
			maxBitrate: 500_000,
		};
		const goal: PerTitleGoal = {
			...automatic,
			strategy: "fixed-ranges",
			maxBitrate: 2_000_000,
			minBitrateStepSize: 1.5,
		};
		const [reversed] = proposePerTitleSettings({ ...goal, rows: [high, low] });
		const [ordered] = proposePerTitleSettings({ ...goal, rows: [low, high] });
		expect(reversed?.applicable).toBe(true);
		expect(reversed?.api.streams).toEqual(ordered?.api.streams);
		expect(reversed?.api.streams.map((row) => row.rowId)).toEqual([
			"low",
			"high",
		]);
	});

	it.each([
		{
			narrowMinimum: 110_000,
			narrowMaximum: 110_000,
			order: ["narrow", "wide"],
		},
		{
			narrowMinimum: 800_000,
			narrowMaximum: 900_000,
			order: ["wide", "narrow"],
		},
	])("finds a feasible ordering of overlapping same-resolution ranges ($narrowMinimum)", ({
		narrowMinimum,
		narrowMaximum,
		order,
	}) => {
		const wide = {
			id: "wide",
			height: 360,
			minBitrate: 100_000,
			maxBitrate: 1_000_000,
		};
		const narrow = {
			id: "narrow",
			height: 360,
			minBitrate: narrowMinimum,
			maxBitrate: narrowMaximum,
		};
		for (const rows of [
			[wide, narrow],
			[narrow, wide],
		]) {
			const [baseline] = proposePerTitleSettings({
				...automatic,
				strategy: "fixed-ranges",
				maxBitrate: 1_000_000,
				minBitrateStepSize: 1.5,
				maxBitrateStepSize: 1.9,
				rows,
			});
			expect(baseline?.applicable).toBe(true);
			expect(baseline?.api.streams.map((row) => row.rowId)).toEqual(order);
			expect(
				baseline?.scenarios.every((scenario) => scenario.status === "modelled"),
			).toBe(true);
		}
	});

	it("reports bounded row-order exploration as unknown instead of proving an unsatisfiable ladder", () => {
		const [baseline] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			maxBitrate: 1_000_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			rows: [
				...Array.from({ length: 7 }, (_, index) => ({
					id: `overlap-${index}`,
					height: 360,
					minBitrate: 100_000,
					maxBitrate: 2_000_000 + index,
				})),
				{ id: "later", height: 720, minBitrate: 110_000, maxBitrate: 110_000 },
			],
		});
		expect(baseline?.applicable).toBe(false);
		expect(baseline?.status).toBe("unknown");
		expect(baseline?.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "row-order-unknown",
				severity: "warning",
				values: expect.objectContaining({ limit: 2048 }),
			}),
		);
		const search = baseline?.diagnostics.find(
			(item) => item.code === "row-order-unknown",
		);
		expect(search?.values?.states).toBeLessThanOrEqual(2048);
		expect(
			baseline?.diagnostics.some((item) => item.code === "row-step-conflict"),
		).toBe(false);
		expect(
			baseline?.scenarios.every(
				(scenario) =>
					scenario.status === "unknown" && scenario.modelCountRange === null,
			),
		).toBe(true);
	});

	it("orders same-resolution illustrative targets independently of their feasible interval ordering", () => {
		const boundaries = {
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: 100_000,
			highComplexityBoundaryForMaxBitrate: 1_000_000,
		};
		const [baseline] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			maxBitrate: 1_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			scenarioFractions: [2 / 9],
			rows: [
				{
					id: "wide",
					height: 360,
					minBitrate: 100_000,
					maxBitrate: 1_000_000,
					...boundaries,
				},
				{
					id: "narrow",
					height: 360,
					minBitrate: 500_000,
					maxBitrate: 600_000,
					...boundaries,
				},
			],
		});
		expect(baseline?.applicable).toBe(true);
		expect(baseline?.scenarios[0]?.status).toBe("modelled");
		expect(
			baseline?.scenarios[0]?.modelRungs.map((rung) => [
				rung.rowId,
				rung.bitrate,
			]),
		).toEqual([
			["wide", 300_000],
			["narrow", 522_222],
		]);
	});

	it.each([
		63, 64,
	])("includes the automatic template when enforcing the stream limit (%s required rows)", (count) => {
		const [baseline] = proposePerTitleSettings({
			...automatic,
			strategy: "required-resolutions",
			minBitrateStepSize: 1.02,
			rows: Array.from({ length: count }, (_, index) => ({
				id: `r-${index}`,
				height: 360,
			})),
		});
		expect(baseline?.applicable).toBe(count === 63);
		if (count === 64) {
			expect(baseline?.diagnostics).toContainEqual(
				expect.objectContaining({ code: "model-limit", severity: "conflict" }),
			);
			expect(
				baseline?.scenarios.every((scenario) => scenario.status === "unknown"),
			).toBe(true);
		} else {
			expect(baseline?.api.streams).toHaveLength(64);
		}
	});

	it("does not count fractional bitrate points in a one-bit-per-second interval", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			minBitrate: 100,
			maxBitrate: 101,
			minBitrateStepSize: 1.001,
		});
		expect(proposal?.scenarios[2]?.modelCountRange?.maximum).toBe(2);
		expect(
			proposal?.scenarios[2]?.modelRungs.map((rung) => rung.bitrate),
		).toEqual([100, 101]);
	});

	it("does not label a rounded required-row example as valid when its steps are violated", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			minBitrate: 1,
			maxBitrate: 3,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 2,
			rows: [
				{ id: "small", height: 400, minBitrate: 1, maxBitrate: 2 },
				{ id: "large", height: 800, minBitrate: 3, maxBitrate: 3 },
			],
		});
		expect(
			proposal?.scenarios.every((scenario) => scenario.status !== "modelled"),
		).toBe(true);
	});

	it("constructs integer count examples whose step ratios match the proposed steps", () => {
		const [, candidate] = proposePerTitleSettings({
			...automatic,
			strategy: "count",
			countPolicy: { kind: "exact", count: 6 },
		});
		const points = candidate?.scenarios[2]?.modelRungs ?? [];
		expect(points).toHaveLength(6);
		for (let index = 1; index < points.length; index++) {
			const ratio =
				(points[index]?.bitrate ?? 0) / (points[index - 1]?.bitrate ?? 1);
			expect(ratio).toBeGreaterThanOrEqual(
				(candidate?.api.global.minBitrateStepSize ?? 1) - 1e-10,
			);
			expect(ratio).toBeLessThanOrEqual(
				(candidate?.api.global.maxBitrateStepSize ?? 1) + 1e-10,
			);
		}
	});

	it("preserves separate rows at the same resolution", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			rows: [
				{ id: "a", height: 400, minBitrate: 100_000, maxBitrate: 150_000 },
				{ id: "b", height: 400, minBitrate: 300_000, maxBitrate: 500_000 },
			],
		});
		expect(proposal?.api.streams.map((row) => row.rowId)).toEqual(["a", "b"]);
		expect(proposal?.api.global.autoRepresentations).toBeUndefined();
		expect(
			proposal?.scenarios[2]?.modelRungs.filter(
				(rung) => rung.kind === "required",
			),
		).toHaveLength(2);
	});

	it("rejects contradictory row intervals instead of changing requested bounds", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			rows: [
				{ id: "a", height: 400, minBitrate: 300_000, maxBitrate: 400_000 },
				{ id: "b", height: 800, minBitrate: 400_000, maxBitrate: 500_000 },
			],
		});
		expect(proposal?.applicable).toBe(false);
		expect(
			proposal?.diagnostics.some((item) => item.code === "row-step-conflict"),
		).toBe(true);
		expect(proposal?.api.streams[1]?.perTitleSettings?.maxBitrate).toBe(
			500_000,
		);
	});

	it("does not claim a count policy is achievable when required rows already exceed it", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-resolutions",
			countPolicy: { kind: "maximum", count: 1 },
			rows: [
				{ id: "a", height: 400 },
				{ id: "b", height: 800 },
			],
		});
		expect(proposal?.applicable).toBe(false);
		expect(
			proposal?.diagnostics.some(
				(item) => item.code === "required-count-exceeded",
			),
		).toBe(true);
	});
});
