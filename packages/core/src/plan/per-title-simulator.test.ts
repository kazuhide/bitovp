import { describe, expect, it } from "vitest";
import {
	type PerTitleGoal,
	proposePerTitleSettings,
	recommendPerTitleSettings,
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
	it("checks every retained witness against the emitted steps across a bounded lock corpus", () => {
		let retained = 0;
		for (const maxBitrate of [4000000, 10000000])
			for (const count of [2, 3, 4, 5, 6])
				for (const minimum of [2, 4, 8, 12])
					for (const maximum of [undefined, 3, 8])
						for (const fixedMaximum of [false, true]) {
							const goal: PerTitleGoal = {
								strategy: "count",
								codec: "H264",
								minBitrate: 100000,
								maxBitrate,
								countPolicy: { kind: "exact", count },
								minBitrateStepSize: minimum,
								maxBitrateStepSize: maximum,
								settingLocks: {
									global: [
										"minBitrateStepSize",
										...(fixedMaximum ? ["maxBitrateStepSize"] : []),
									],
								},
							};
							const result = recommendPerTitleSettings(goal);
							const context = JSON.stringify({
								maxBitrate,
								count,
								minimum,
								maximum,
								fixedMaximum,
							});
							for (const scenario of result.scenarios.filter(
								(item) => item.status === "modelled",
							)) {
								for (const [index, rung] of scenario.modelRungs.entries()) {
									expect(Number.isSafeInteger(rung.bitrate), context).toBe(
										true,
									);
									expect(rung.bitrate, context).toBeGreaterThanOrEqual(
										goal.minBitrate,
									);
									expect(rung.bitrate, context).toBeLessThanOrEqual(
										Math.min(goal.maxBitrate, scenario.assumedMaxBitrate),
									);
									if (index === 0) continue;
									const ratio =
										rung.bitrate /
										(scenario.modelRungs[index - 1]?.bitrate ?? NaN);
									expect(ratio, context).toBeGreaterThanOrEqual(
										result.api.global.minBitrateStepSize,
									);
									expect(ratio, context).toBeLessThanOrEqual(
										result.api.global.maxBitrateStepSize,
									);
								}
							}
							if (result.derivation?.targetSatisfied) {
								expect(result.applicable, context).toBe(true);
								const high = result.scenarios.find(
									(item) => item.fraction === 1,
								);
								expect(high?.status, context).toBe("modelled");
								expect(high?.modelRungs, context).toHaveLength(count);
							}
							const witness = result.derivation?.integerWitness;
							if (!witness?.length) continue;
							retained++;
							for (const [index, bitrate] of witness.entries()) {
								expect(Number.isSafeInteger(bitrate), context).toBe(true);
								expect(bitrate, context).toBeGreaterThanOrEqual(
									goal.minBitrate,
								);
								expect(bitrate, context).toBeLessThanOrEqual(goal.maxBitrate);
								if (index === 0) continue;
								const ratio = bitrate / (witness[index - 1] ?? NaN);
								expect(ratio, context).toBeGreaterThanOrEqual(
									result.api.global.minBitrateStepSize,
								);
								expect(ratio, context).toBeLessThanOrEqual(
									result.api.global.maxBitrateStepSize,
								);
							}
						}
		expect(retained).toBeGreaterThan(0);
	});
	it("preserves the valid exact-three locked-eight case without inventing a trial witness", () => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: 100000,
			maxBitrate: 10000000,
			countPolicy: { kind: "exact", count: 3 },
			minBitrateStepSize: 8,
			settingLocks: { global: ["minBitrateStepSize"] },
		});
		expect(result.api.global).toMatchObject({
			minBitrateStepSize: 8,
			maxBitrateStepSize: 8,
		});
		expect(result.derivation).toMatchObject({
			method: "preserved-existing",
			targetSatisfied: true,
		});
		expect(result.derivation).not.toHaveProperty("integerWitness");
	});
	it("treats prototype-like row IDs as ordinary JSON keys in setting locks", () => {
		for (const id of ["__proto__", "constructor", "toString"]) {
			for (const streams of [
				{},
				JSON.parse(`{"${id}":["bitrateSelectionMode"]}`),
			]) {
				const goal: PerTitleGoal = JSON.parse(
					JSON.stringify({
						...automatic,
						strategy: "fixed-ranges",
						rows: [{ id, height: 360, minBitrate: 200000, maxBitrate: 400000 }],
						settingLocks: { global: ["minBitrate"], streams },
					}),
				);
				expect(() => recommendPerTitleSettings(goal)).not.toThrow();
				const result = recommendPerTitleSettings(goal);
				expect(result.api.streams[0]?.rowId).toBe(id);
				if (Object.hasOwn(streams, id))
					expect(result.api.streams[0]?.perTitleSettings).not.toHaveProperty(
						"bitrateSelectionMode",
					);
			}
		}
	});
	it("rejects malformed JSON setting-lock arrays with a diagnostic rather than throwing", () => {
		for (const settingLocks of [
			null,
			[],
			{ global: "minBitrate" },
			{ global: [null] },
			{ streams: [] },
			{ streams: { a: null } },
			{ streams: { a: "minBitrate" } },
			{ streams: { a: [false] } },
		]) {
			const goal = JSON.parse(
				JSON.stringify({
					...automatic,
					strategy: "fixed-ranges",
					rows: [
						{ id: "a", height: 360, minBitrate: 200000, maxBitrate: 400000 },
					],
					settingLocks,
				}),
			) as PerTitleGoal;
			expect(() => recommendPerTitleSettings(goal)).not.toThrow();
			expect(recommendPerTitleSettings(goal).diagnostics).toContainEqual(
				expect.objectContaining({
					code: "invalid-setting",
					severity: "conflict",
				}),
			);
		}
	});
	it("emits supported optional settings and independent outer stream factors without defaults", () => {
		const goal: PerTitleGoal = {
			...automatic,
			strategy: "fixed-ranges",
			targetQualityCrf: 0,
			complexityFactor: 1.2,
			resolutionScaleFactor: -2,
			codecMinBitrateFactor: 0.8,
			codecMaxBitrateFactor: 1.5,
			codecBufsizeFactor: 2,
			rows: [
				{
					id: "fixed",
					height: 360,
					minBitrate: 200000,
					maxBitrate: 400000,
					codecMaxBitrateFactor: 1.4,
					codecBufsizeFactor: 1.8,
				},
			],
			automaticTemplates: [
				{
					id: "auto",
					height: 720,
					codecMaxBitrateFactor: 1.6,
					codecBufsizeFactor: 2.2,
				},
			],
		};
		const before = structuredClone(goal);
		const result = recommendPerTitleSettings(goal);
		expect(result.api.global).toMatchObject({
			targetQualityCrf: 0,
			complexityFactor: 1.2,
			resolutionScaleFactor: -2,
			codecMinBitrateFactor: 0.8,
			codecMaxBitrateFactor: 1.5,
			codecBufsizeFactor: 2,
		});
		expect(
			result.api.streams.find((s) => s.rowId === "fixed")?.perTitleSettings,
		).toMatchObject({ codecMaxBitrateFactor: 1.4, codecBufsizeFactor: 1.8 });
		expect(
			result.api.streams.find((s) => s.rowId === "auto")?.perTitleSettings,
		).toEqual({ codecMaxBitrateFactor: 1.6, codecBufsizeFactor: 2.2 });
		expect(goal).toEqual(before);
		expect(recommendPerTitleSettings(automatic).api.global).not.toHaveProperty(
			"targetQualityCrf",
		);
	});
	it("rejects unsupported codec settings and nonfinite SDK values without hiding them", () => {
		for (const extras of [
			{ codec: "H265V2" as const, targetQualityCrf: 20 },
			{ codec: "H264" as const, targetQualityQp: 20 },
			{ codec: "VP9" as const, codecBufsizeFactor: 2 },
			{ codec: "AV1" as const, codecMaxBitrateFactor: 2 },
			{ complexityFactor: 0 },
			{ resolutionScaleFactor: 16 },
			{ targetQualityCrf: NaN },
		]) {
			const result = recommendPerTitleSettings({ ...automatic, ...extras });
			expect(result.applicable).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "invalid-setting",
					severity: "conflict",
				}),
			);
		}
		const v2 = recommendPerTitleSettings({
			...automatic,
			codec: "H265V2",
			targetQualityQp: 0,
		});
		expect(v2.api.global.targetQualityQp).toBe(0);
	});
	it("keeps explicit unset/false/zero locks out of inference and provider metadata", () => {
		for (const autoRepresentations of [
			undefined,
			false,
			{ adoptConfigurationThreshold: 0 },
		] as const) {
			const goal: PerTitleGoal = {
				...automatic,
				autoRepresentations,
				settingLocks: { global: ["autoRepresentations", "targetQualityCrf"] },
				adjustments: { global: { targetQualityCrf: { mode: "fixed" } } },
			};
			const result = recommendPerTitleSettings(goal);
			expect(result.api.global.autoRepresentations).toEqual(
				autoRepresentations === false ? undefined : autoRepresentations,
			);
			expect(result.api.global).not.toHaveProperty("targetQualityCrf");
			expect(result.api).not.toHaveProperty("settingLocks");
			expect(result.api).not.toHaveProperty("adjustments");
		}
	});
	it("rejects unknown lock keys and unsupported independent stream factors", () => {
		for (const goal of [
			{ ...automatic, settingLocks: { global: ["countPolicy"] } },
			{ ...automatic, settingLocks: { streams: { a: ["width"] } } },
			{
				...automatic,
				codec: "H265V2" as const,
				automaticTemplates: [{ id: "auto", codecBufsizeFactor: 2 }],
			},
		]) {
			expect(recommendPerTitleSettings(goal).diagnostics).toContainEqual(
				expect.objectContaining({
					code: "invalid-setting",
					severity: "conflict",
				}),
			);
		}
	});
	it("emits outer factors independently of fixed-block modes and retains locked boundary values", () => {
		const goal: PerTitleGoal = {
			...automatic,
			strategy: "fixed-resolutions",
			rows: [{ id: "a", height: 360, codecMaxBitrateFactor: 1.4 }],
		};
		expect(
			recommendPerTitleSettings(goal).api.streams[0]?.perTitleSettings,
		).toEqual({ codecMaxBitrateFactor: 1.4 });
		const locked: PerTitleGoal = {
			...goal,
			strategy: "fixed-ranges",
			rows: [
				{
					id: "a",
					height: 360,
					minBitrate: 200000,
					maxBitrate: 400000,
					bitrateSelectionMode: "OPTIMIZED",
					lowComplexityBoundaryForMaxBitrate: 0,
				},
			],
			settingLocks: { streams: { a: ["lowComplexityBoundaryForMaxBitrate"] } },
		};
		expect(
			recommendPerTitleSettings(locked).api.streams[0]?.perTitleSettings
				?.lowComplexityBoundaryForMaxBitrate,
		).toBe(0);
		expect(recommendPerTitleSettings(locked).applicable).toBe(false);
	});
	it("ignores parked stream factor restrictions while enforcing emitted automatic factors", () => {
		const parked = {
			...automatic,
			codec: "VP9" as const,
			rows: [{ id: "parked", height: 360, codecMaxBitrateFactor: 2 }],
		};
		expect(recommendPerTitleSettings(parked).diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "invalid-setting" }),
		);
		const active = {
			...parked,
			automaticTemplates: [{ id: "auto", codecMaxBitrateFactor: 2 }],
		};
		expect(recommendPerTitleSettings(active).diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid-setting" }),
		);
	});
	it("reports a locked missing required step and never adjusts an explicitly locked step", () => {
		const missing = recommendPerTitleSettings({
			...automatic,
			minBitrateStepSize: undefined,
			settingLocks: { global: ["minBitrateStepSize"] },
		});
		expect(missing.applicable).toBe(false);
		expect(missing.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-setting",
				severity: "conflict",
			}),
		);
		const results = proposePerTitleSettings({
			...automatic,
			strategy: "count",
			countPolicy: { kind: "exact", count: 6 },
			settingLocks: { global: ["minBitrateStepSize"] },
		});
		expect(results.every((r) => r.api.global.minBitrateStepSize === 2)).toBe(
			true,
		);
	});
	it("does not accept automatic resolution generation without an ordinary template", () => {
		const [proposal] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-resolutions",
			autoRepresentations: {},
			rows: [{ id: "fixed", height: 480 }],
		});
		expect(proposal?.applicable).toBe(false);
		expect(proposal?.diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid-row", severity: "conflict" }),
		);
	});
	it("preserves an explicit disabled or configured automatic-resolution policy", () => {
		const disabled = proposePerTitleSettings({
			...automatic,
			autoRepresentations: false,
		});
		expect(disabled[0]?.api.global.autoRepresentations).toBeUndefined();
		const configured = proposePerTitleSettings({
			...automatic,
			autoRepresentations: { adoptConfigurationThreshold: 0.7 },
		});
		expect(configured[0]?.api.global.autoRepresentations).toEqual({
			adoptConfigurationThreshold: 0.7,
		});
	});

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

	it("keeps an already feasible bitrate ordering before spending the permutation budget", () => {
		const rows = [
			...Array.from({ length: 7 }, (_, index) => ({
				id: `wide-${index}`,
				height: 360,
				minBitrate: 100_000,
				maxBitrate: 10_000_000 + index,
			})),
			{
				id: "fixed-360",
				height: 360,
				minBitrate: 200_000,
				maxBitrate: 200_000,
			},
			{
				id: "fixed-720",
				height: 720,
				minBitrate: 300_000,
				maxBitrate: 300_000,
			},
		];
		const [baseline] = proposePerTitleSettings({
			...automatic,
			strategy: "fixed-ranges",
			maxBitrate: 10_000_006,
			minBitrateStepSize: 1.1,
			maxBitrateStepSize: 1.9,
			rows,
		});
		expect(baseline?.status).toBe("candidate");
		expect(baseline?.applicable).toBe(true);
		expect(baseline?.api.streams.map((row) => row.rowId)).toEqual(
			rows.map((row) => row.id),
		);
		expect(
			baseline?.diagnostics.some((item) => item.code === "row-order-unknown"),
		).toBe(false);
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

describe("recommendPerTitleSettings", () => {
	it.each([
		"exact",
		"maximum",
	] as const)("leaves a measurable cap margin for a fresh %s one-output request", (kind) => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 200_000,
			countPolicy: { kind, count: 1 },
		});
		expect(result.api.global.minBitrateStepSize).toBe(2.02);
		expect(result.api.global.maxBitrateStepSize).toBe(2.02);
		expect(
			Math.round(100_000 * result.api.global.minBitrateStepSize),
		).toBeGreaterThan(200_000);
		expect(result.evidence).toBe("model-only");
		expect(result.countGuarantee).toBe(false);
	});

	it.each([
		[1, 2],
		[10_000, 10_001],
		[2_000_000_000, 2_000_000_001],
	])("keeps the next integer point above a one-output cap of %i–%i", (minimum, maximum) => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: minimum,
			maxBitrate: maximum,
			countPolicy: { kind: "exact", count: 1 },
		});
		const step = result.api.global.minBitrateStepSize;
		expect(Number.isFinite(step)).toBe(true);
		expect(step).toBeGreaterThan(1);
		expect(Math.round(minimum * step)).toBeGreaterThan(maximum);
	});

	it("retains explicitly supplied one-output spacing without claiming a verified count", () => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 200_000,
			minBitrateStepSize: 2.0000000001386296,
			maxBitrateStepSize: 2.0000000001386296,
			countPolicy: { kind: "exact", count: 1 },
			settingLocks: { global: ["minBitrateStepSize", "maxBitrateStepSize"] },
		});
		expect(result.api.global.minBitrateStepSize).toBe(2.0000000001386296);
		expect(result.countGuarantee).toBe(false);
	});

	const narrow: PerTitleGoal = {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 1_000_000,
		countPolicy: { kind: "unrestricted" },
		rows: [
			{
				id: "low",
				height: 360,
				width: 640,
				minBitrate: 300_000,
				maxBitrate: 301_000,
			},
			{ id: "high", height: 360, minBitrate: 302_000, maxBitrate: 303_000 },
		],
	};

	it("preserves valid existing ratios when the requested constraints already fit", () => {
		const result = recommendPerTitleSettings({
			...automatic,
			minBitrateStepSize: 1.25,
			maxBitrateStepSize: 3,
		});
		expect(result.api.global.minBitrateStepSize).toBe(1.25);
		expect(result.api.global.maxBitrateStepSize).toBe(3);
		expect(result.derivation?.method).toBe("preserved-existing");
	});

	it("reports a checked minimum-step range that retains the integer example at a fixed maximum step", () => {
		const goal: PerTitleGoal = {
			...automatic,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 3,
			countPolicy: { kind: "exact", count: 5 },
		};
		const result = recommendPerTitleSettings(goal);
		expect(result.derivation?.method).toBe("preserved-existing");
		const range = result.derivation?.minimumStepRange;
		expect(range).toBeDefined();
		if (!range) return;
		expect(range.exampleCount).toBe(5);
		expect(range.maximumStep).toBe(3);
		expect(range.lowerInclusive).toBeGreaterThan(16 ** 0.2);
		expect(range.upperInclusive).toBe(2);
		const points =
			result.scenarios[2]?.modelRungs.map((rung) => rung.bitrate) ?? [];
		for (const minimumStep of [
			range.lowerInclusive,
			(range.lowerInclusive + range.upperInclusive) / 2,
			range.upperInclusive,
		]) {
			const [checked] = proposePerTitleSettings({
				...goal,
				minBitrateStepSize: minimumStep,
				maxBitrateStepSize: range.maximumStep,
			});
			expect(checked?.applicable).toBe(true);
			expect(checked?.scenarios[2]?.modelCountRange?.maximum).toBe(5);
			expect(checked?.api.global.maxBitrateStepSize).toBe(3);
			for (let index = 1; index < points.length; index++) {
				const ratio = (points[index] as number) / (points[index - 1] as number);
				expect(ratio).toBeGreaterThanOrEqual(minimumStep);
				expect(ratio).toBeLessThanOrEqual(range.maximumStep);
			}
		}
		const [below] = proposePerTitleSettings({
			...goal,
			minBitrateStepSize: 16 ** 0.2,
		});
		expect(below?.scenarios[2]?.modelCountRange?.maximum).toBe(6);
	});

	it("does not publish an adjustable range for unknown, invalid, or single-point results", () => {
		for (const goal of [
			{
				...automatic,
				fixedResolutionAndBitrateConfiguration: {
					forcedRenditionAboveHighestFixedRepresentation: 1,
				},
			},
			{ ...automatic, minBitrate: 0 },
			{
				...automatic,
				countPolicy: { kind: "exact", count: 1 } as const,
			},
		]) {
			const result = recommendPerTitleSettings(goal);
			expect(result.derivation?.minimumStepRange).toBeUndefined();
		}
	});

	it("does not use step comparison tolerance as proof of an adjustable interval", () => {
		for (const steps of [
			{ minBitrateStepSize: 2 + 5e-11, maxBitrateStepSize: 3 },
			{ minBitrateStepSize: 1.5, maxBitrateStepSize: 2 - 5e-11 },
		]) {
			const result = recommendPerTitleSettings({
				...automatic,
				...steps,
				minBitrate: 1,
				maxBitrate: 2,
				countPolicy: { kind: "exact", count: 2 },
			});
			expect(result.derivation?.targetSatisfied).toBe(true);
			expect(result.derivation?.minimumStepRange).toBeUndefined();
		}
	});

	it("preserves valid saved spacing independently of the displayed scenario fractions", () => {
		const goal = {
			...automatic,
			minBitrateStepSize: 1.25,
			maxBitrateStepSize: 3,
		};
		const full = recommendPerTitleSettings(goal);
		const displayed = recommendPerTitleSettings({
			...goal,
			scenarioFractions: [0.25, 0.5],
		});
		expect(displayed.derivation?.method).toBe("preserved-existing");
		expect(displayed.api).toEqual(full.api);
		expect(displayed.derivation?.targetSatisfied).toBe(true);
		expect(displayed.scenarios.map((scenario) => scenario.fraction)).toEqual([
			0.25, 0.5,
		]);
	});

	it("checks a count target internally without appending a full-upper presentation scenario", () => {
		const goal: PerTitleGoal = {
			strategy: "count",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			countPolicy: { kind: "exact", count: 6 },
		};
		const full = recommendPerTitleSettings(goal);
		for (const fractions of [
			[0.25, 0.5],
			Array.from({ length: 9 }, (_, index) => (index + 1) / 20),
		]) {
			const displayed = recommendPerTitleSettings({
				...goal,
				scenarioFractions: fractions,
			});
			expect(displayed.api).toEqual(full.api);
			expect(displayed.derivation).toEqual(full.derivation);
			expect(displayed.derivation?.targetSatisfied).toBe(true);
			expect(displayed.status).toBe("candidate");
			expect(displayed.applicable).toBe(true);
			expect(displayed.scenarios.map((scenario) => scenario.fraction)).toEqual(
				fractions,
			);
			expect(
				displayed.scenarios.every((scenario) => scenario.status === "conflict"),
			).toBe(true);
		}
	});

	it("replaces saved ratios that have no valid integer example for the exact count", () => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: 1,
			maxBitrate: 2,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.5,
			countPolicy: { kind: "exact", count: 2 },
		});
		expect(result.derivation?.method).toBe("geometric-count");
		expect(result.applicable).toBe(true);
		expect(result.derivation?.targetSatisfied).toBe(true);
		const high = result.scenarios.find((scenario) => scenario.fraction === 1);
		expect(high?.status).toBe("modelled");
		expect(high?.modelRungs.map((rung) => rung.bitrate)).toEqual([1, 2]);
		expect(result.api.global.minBitrateStepSize).toBeLessThanOrEqual(2);
		expect(result.api.global.maxBitrateStepSize).toBeGreaterThanOrEqual(2);
	});

	it("finds an alternate integer placement when rounded equal-log points miss the count interval", () => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: 100,
			maxBitrate: 104,
			countPolicy: { kind: "exact", count: 4 },
		});
		expect(result.applicable).toBe(true);
		expect(result.derivation?.targetSatisfied).toBe(true);
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1.04 ** 0.25);
		const high = result.scenarios.find((scenario) => scenario.fraction === 1);
		expect(high?.status).toBe("modelled");
		expect(high?.modelCountRange?.maximum).toBe(4);
		expect(high?.modelRungs).toHaveLength(4);
		for (let index = 1; index < (high?.modelRungs.length ?? 0); index++) {
			const ratio =
				(high?.modelRungs[index]?.bitrate ?? 0) /
				(high?.modelRungs[index - 1]?.bitrate ?? 1);
			expect(ratio).toBeGreaterThanOrEqual(
				result.api.global.minBitrateStepSize,
			);
			expect(ratio).toBeLessThanOrEqual(result.api.global.maxBitrateStepSize);
		}
	});

	it("derives a count interval even when the default upper count would already be below the target", () => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_600_000,
			countPolicy: { kind: "maximum", count: 10 },
		});
		expect(result.derivation?.method).toBe("geometric-count");
		expect(result.derivation?.desiredCount).toBe(10);
		expect(result.derivation?.ratioLowerExclusive).toBeCloseTo(16 ** (1 / 10));
		expect(result.derivation?.ratioUpperInclusive).toBeCloseTo(16 ** (1 / 9));
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(
			16 ** (1 / 10),
		);
		expect(result.api.global.minBitrateStepSize).toBeLessThan(16 ** (1 / 9));
		expect(result.derivation?.targetSatisfied).toBe(true);
	});

	it("fits many required resolutions without using an almost-one ratio that exceeds model capacity", () => {
		const result = recommendPerTitleSettings({
			strategy: "fixed-resolutions",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_600_000,
			countPolicy: { kind: "unrestricted" },
			rows: Array.from({ length: 10 }, (_, index) => ({
				id: `r-${index}`,
				height: 180 + index * 60,
			})),
		});
		expect(result.applicable).toBe(true);
		expect(result.derivation?.method).toBe("required-intervals");
		expect(result.derivation?.integerWitness).toHaveLength(10);
		expect(result.derivation?.fixedOrderRowIds).toHaveLength(10);
		expect(result.scenarios[2]?.modelCountRange?.maximum).toBe(10);
	});

	it("uses the checked integer witness when biased required-row examples exceed a narrow ratio interval", () => {
		const result = recommendPerTitleSettings({
			strategy: "fixed-resolutions",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "maximum", count: 3 },
			rows: [
				{ id: "a", height: 360 },
				{ id: "b", height: 720 },
				{ id: "c", height: 1080 },
			],
		});
		expect(result.applicable).toBe(true);
		for (const id of ["medium", "high"]) {
			const scenario = result.scenarios.find((item) => item.id === id);
			expect(scenario?.status).toBe("modelled");
			expect(scenario?.modelRungs.map((rung) => rung.bitrate)).toEqual(
				result.derivation?.integerWitness,
			);
			expect(
				scenario?.modelRungs.every(
					(rung) => rung.bitrate <= scenario.assumedMaxBitrate,
				),
			).toBe(true);
		}
		expect(result.scenarios[0]?.status).toBe("conflict");
	});

	it("labels the documented default assumption when no count, required row, or saved ratio exists", () => {
		const result = recommendPerTitleSettings({
			strategy: "automatic",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_600_000,
			countPolicy: { kind: "unrestricted" },
		});
		expect(result.derivation?.method).toBe("documented-defaults");
		expect(result.derivation?.rationale).toContain(
			"https://developer.bitmovin.com/encoding/docs/per-title-configuration-options",
		);
	});

	it("uses the integer capacity when a short interval cannot contain an extra bitrate point", () => {
		const result = recommendPerTitleSettings({
			strategy: "count",
			codec: "H264",
			minBitrate: 1,
			maxBitrate: 4,
			countPolicy: { kind: "exact", count: 4 },
		});
		expect(result.applicable).toBe(true);
		expect(result.scenarios[2]?.modelRungs).toHaveLength(4);
		const witness = result.derivation?.integerWitness ?? [];
		expect(witness).toHaveLength(4);
		for (let index = 1; index < witness.length; index++) {
			const ratio = (witness[index] as number) / (witness[index - 1] as number);
			expect(ratio).toBeGreaterThanOrEqual(
				result.api.global.minBitrateStepSize,
			);
			expect(ratio).toBeLessThanOrEqual(result.api.global.maxBitrateStepSize);
		}
	});

	it("keeps unknown complexity boundaries in the API without projecting them into recommended bitrate examples", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_600_000,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "r",
					height: 360,
					minBitrate: 100_000,
					maxBitrate: 400_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 500_000,
					highComplexityBoundaryForMaxBitrate: 1_000_000,
				},
			],
		};
		const original = recommendPerTitleSettings(goal);
		const changed = recommendPerTitleSettings({
			...goal,
			rows: goal.rows?.map((row) => ({
				...row,
				highComplexityBoundaryForMaxBitrate: 2_000_000,
			})),
		});
		expect(changed.scenarios).toEqual(original.scenarios);
		expect(
			original.scenarios.every((scenario) =>
				scenario.rowModels.every(
					(row) =>
						row.linearTargetBitrate === null && row.boundaryFraction === null,
				),
			),
		).toBe(true);
		expect(
			original.api.streams[0]?.perTitleSettings
				?.highComplexityBoundaryForMaxBitrate,
		).toBe(1_000_000);
		expect(
			changed.api.streams[0]?.perTitleSettings
				?.highComplexityBoundaryForMaxBitrate,
		).toBe(2_000_000);
		expect(original.diagnostics).toContainEqual(
			expect.objectContaining({ code: "complexity-analysis-required" }),
		);
	});

	it("derives narrow spacing while withholding application for unresolved dimension ordering", () => {
		const goal = {
			...narrow,
			minBitrateStepSize: Number.NaN,
			maxBitrateStepSize: 1,
		};
		const before = structuredClone(goal);
		const result = recommendPerTitleSettings(goal);
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "row-order-unknown" }),
		);
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1);
		expect(result.api.global.minBitrateStepSize).toBeLessThan(1.5);
		expect(
			result.api.streams.map((row) => [
				row.rowId,
				row.height,
				row.width,
				row.perTitleSettings?.minBitrate,
				row.perTitleSettings?.maxBitrate,
			]),
		).toEqual([
			["low", 360, 640, 300_000, 301_000],
			["high", 360, undefined, 302_000, 303_000],
		]);
		expect(goal).toEqual(before);
		expect(result.evidence).toBe("model-only");
		expect(result.countGuarantee).toBe(false);
	});

	it("derives a wide maximum gap without changing fixed bitrate points", () => {
		const result = recommendPerTitleSettings({
			...narrow,
			rows: [
				{ id: "low", height: 360, minBitrate: 200_000, maxBitrate: 200_000 },
				{ id: "high", height: 720, minBitrate: 800_000, maxBitrate: 800_000 },
			],
		});
		expect(result.applicable).toBe(true);
		expect(result.api.global.maxBitrateStepSize).toBeGreaterThanOrEqual(4);
		expect(result.api.streams[1]?.perTitleSettings?.maxBitrate).toBe(800_000);
	});

	it("keeps the touching-interval count calculation separate from unresolved probe order", () => {
		const result = recommendPerTitleSettings({
			...narrow,
			countPolicy: { kind: "maximum", count: 2 },
			rows: [
				{ id: "low", height: 360, minBitrate: 300_000, maxBitrate: 301_000 },
				{ id: "high", height: 360, minBitrate: 301_000, maxBitrate: 302_000 },
			],
		});
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "row-order-unknown" }),
		);
		expect(result.scenarios[2]?.modelCountRange?.maximum).toBeLessThanOrEqual(
			2,
		);
	});

	it.each([
		{ kind: "exact", count: 6 },
		{ kind: "maximum", count: 3 },
	] as const)("derives one automatic candidate for $kind $count without a count API field", (countPolicy) => {
		const result = recommendPerTitleSettings({
			...automatic,
			strategy: "count",
			maxBitrate: 8_000_000,
			minBitrateStepSize: 20,
			maxBitrateStepSize: 20,
			countPolicy,
		});
		expect(result.applicable).toBe(true);
		expect(result.scenarios[2]?.modelCountRange?.maximum).toBeLessThanOrEqual(
			countPolicy.count,
		);
		expect(result.api.global).not.toHaveProperty("count");
		expect(result.countGuarantee).toBe(false);
	});

	it("refuses two required rows at the same single bitrate instead of changing their ranges", () => {
		const result = recommendPerTitleSettings({
			...narrow,
			rows: [
				{ id: "a", height: 360, minBitrate: 300_000, maxBitrate: 300_000 },
				{ id: "b", height: 360, minBitrate: 300_000, maxBitrate: 300_000 },
			],
		});
		expect(result.applicable).toBe(false);
		expect(result.status).not.toBe("candidate");
		expect(
			result.api.streams.every(
				(row) =>
					row.perTitleSettings?.minBitrate === 300_000 &&
					row.perTitleSettings.maxBitrate === 300_000,
			),
		).toBe(true);
	});

	it("preserves automatic candidates separately from required rows in a mixed ladder", () => {
		const result = recommendPerTitleSettings({
			...narrow,
			rows: [
				{
					id: "fixed-a",
					height: 360,
					minBitrate: 200_000,
					maxBitrate: 250_000,
				},
				{
					id: "fixed-b",
					height: 540,
					minBitrate: 500_000,
					maxBitrate: 600_000,
				},
			],
			automaticTemplates: [
				{
					id: "auto-a",
					height: 180,
					width: 320,
					minBitrate: 100_000,
					maxBitrate: 200_000,
				},
				{ id: "auto-b", height: 720 },
			],
		});
		expect(result.api.global.autoRepresentations).toEqual({});
		expect(
			result.api.streams.filter((row) => row.mode === "PER_TITLE_TEMPLATE"),
		).toEqual([
			{
				rowId: "auto-a",
				height: 180,
				width: 320,
				mode: "PER_TITLE_TEMPLATE",
			},
			{ rowId: "auto-b", height: 720, mode: "PER_TITLE_TEMPLATE" },
		]);
		expect(result.scenarios[2]?.modelCountRange?.minimum).toBe(2);
	});

	it("omits inactive fixed-only settings from automatic API streams while preserving the goal and count model", () => {
		const goal: PerTitleGoal = {
			...automatic,
			automaticTemplates: [
				{
					id: "candidate-low",
					height: 240,
					width: 426,
					minBitrate: 120_000,
					maxBitrate: 240_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 800_000,
					highComplexityBoundaryForMaxBitrate: 2_000_000,
				},
				{ id: "candidate-high", height: 720 },
			],
		};
		const original = structuredClone(goal);
		const expected = recommendPerTitleSettings({
			...goal,
			automaticTemplates: goal.automaticTemplates?.map(
				({ id, height, width }) => ({
					id,
					height,
					...(width !== undefined ? { width } : {}),
				}),
			),
		});
		const result = recommendPerTitleSettings(goal);
		expect(result.api).toEqual(expected.api);
		expect(result.scenarios).toEqual(expected.scenarios);
		expect(result.derivation).toEqual(expected.derivation);
		expect(goal).toEqual(original);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "inactive-template-settings",
				severity: "warning",
				rowIds: ["candidate-low"],
			}),
		);
		expect(
			result.api.streams.every(
				(stream) =>
					stream.mode === "PER_TITLE_TEMPLATE" &&
					stream.perTitleSettings === undefined,
			),
		).toBe(true);
	});

	it("ignores inactive automatic settings without weakening ID and dimension validation", () => {
		const goal: PerTitleGoal = {
			...automatic,
			automaticTemplates: [
				{
					id: "candidate",
					height: 480,
					minBitrate: 600_000,
					maxBitrate: 200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_000_000,
				},
			],
		};
		const result = recommendPerTitleSettings(goal);
		expect(result.applicable).toBe(true);
		expect(
			result.diagnostics.some((item) => item.severity === "conflict"),
		).toBe(false);
		for (const invalid of [{ id: "" }, { height: 0 }, { width: 1.5 }]) {
			const rejected = recommendPerTitleSettings({
				...goal,
				automaticTemplates: goal.automaticTemplates?.map((row) => ({
					...row,
					...invalid,
				})),
			});
			expect(rejected.applicable).toBe(false);
			expect(rejected.diagnostics).toContainEqual(
				expect.objectContaining({ code: "invalid-row" }),
			);
		}
	});

	it("preserves forced configuration while leaving its output count unknown and preventing application", () => {
		const forced = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"MAXIMUM" as const,
		};
		const result = recommendPerTitleSettings({
			...narrow,
			fixedResolutionAndBitrateConfiguration: forced,
		});
		expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			forced,
		);
		expect(result.status).toBe("unknown");
		expect(result.applicable).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "forced-count-unknown" }),
		);
		expect(
			result.scenarios.every(
				(scenario) =>
					scenario.status === "unknown" && scenario.modelCountRange === null,
			),
		).toBe(true);
	});

	it("does not declare an exact count impossible when additional-rendition rules are unmodelled", () => {
		const result = recommendPerTitleSettings({
			...narrow,
			countPolicy: { kind: "exact", count: 250 },
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
			},
		});
		expect(result.status).toBe("unknown");
		expect(result.applicable).toBe(false);
		expect(
			result.diagnostics.some(
				(item) =>
					item.code === "count-unreachable" ||
					item.code === "extra-rungs-possible",
			),
		).toBe(false);
	});

	it("counts every explicit automatic candidate against the template limit", () => {
		const result = recommendPerTitleSettings({
			...narrow,
			rows: Array.from({ length: 63 }, (_, index) => ({
				id: `fixed-${index}`,
				height: 360,
				minBitrate: 100_000,
				maxBitrate: 1_000_000,
			})),
			automaticTemplates: [{ id: "auto-a" }, { id: "auto-b" }],
		});
		expect(result.applicable).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "model-limit" }),
		);
	});
});
