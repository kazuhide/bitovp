import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { assessPerTitleValidity } from "./per-title-simulator-analysis-validity";

const rule = "fixedResolutionAndBitrateConfiguration.";
const count = "forcedRenditionAboveHighestFixedRepresentation";
const factor = `${count}Factor`;
const mode = `${count}CalculationMode`;
const low = "lowComplexityBoundaryForMaxBitrate";
const high = "highComplexityBoundaryForMaxBitrate";

function fixture(): { goal: PerTitleGoal; proposal: PerTitleProposal } {
	const goal: PerTitleGoal = {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100,
		maxBitrate: 1000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		rows: [
			{ id: "a", height: 240, minBitrate: 100, maxBitrate: 120 },
			{ id: "b", height: 720, minBitrate: 400, maxBitrate: 500 },
		],
	};
	return {
		goal,
		proposal: {
			id: "baseline",
			codec: goal.codec,
			status: "candidate",
			applicable: true,
			evidence: "model-only",
			countGuarantee: false,
			api: {
				global: {
					minBitrate: 100,
					maxBitrate: 1000,
					minBitrateStepSize: 1.5,
					maxBitrateStepSize: 4,
				},
				streams: (goal.rows ?? []).map(({ id, height, ...settings }) => ({
					rowId: id,
					height,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: settings,
				})),
			},
			scenarios: [],
			diagnostics: [],
		},
	};
}

const codes = (value: ReturnType<typeof fixture>) =>
	assessPerTitleValidity(value.goal, value.proposal).map(({ code }) => code);
function stream(value: ReturnType<typeof fixture>, row = 0) {
	const result = value.proposal.api.streams[row];
	if (!result) throw new Error(`Missing fixture stream ${row}`);
	return result;
}
function setting(value: ReturnType<typeof fixture>, row = 0) {
	const result = stream(value, row).perTitleSettings;
	if (!result) throw new Error(`Missing fixture settings ${row}`);
	return result;
}

describe("Per-Title configuration validity", () => {
	it.each([
		["goal", "minBitrate"],
		["goal", "maxBitrate"],
		["emitted", "minBitrate"],
		["emitted", "maxBitrate"],
	] as const)("links a below-floor %s %s to the global control", (location, key) => {
		const current = fixture();
		Object.assign(current.goal, { minBitrate: 10000, maxBitrate: 20000 });
		Object.assign(current.proposal.api.global, {
			minBitrate: 10000,
			maxBitrate: 20000,
		});
		const value =
			location === "goal" ? current.goal : current.proposal.api.global;
		value[key] = 9999;
		expect(
			assessPerTitleValidity(current.goal, current.proposal),
		).toContainEqual(
			expect.objectContaining({
				code: "global-bitrate-below-api-minimum",
				severity: "conflict",
				fields: [{ scope: "global", key }],
				message: {
					en: expect.stringContaining("10,000"),
					ja: expect.stringContaining("10,000"),
				},
			}),
		);
	});
	it("accepts equal global bounds at the API minimum without changing row validation", () => {
		const current = fixture();
		Object.assign(current.goal, { minBitrate: 10000, maxBitrate: 10000 });
		Object.assign(current.proposal.api.global, {
			minBitrate: 10000,
			maxBitrate: 10000,
		});
		expect(codes(current)).not.toContain("global-bitrate-below-api-minimum");
	});
	it.each([
		["minBitrate", 0],
		["maxBitrate", 2_147_483_648],
		["minBitrateStepSize", Number.NaN],
		["maxBitrateStepSize", 0],
		["complexityFactor", 0],
		["resolutionScaleFactor", 16],
		["targetQualityCrf", "18"],
		["codecMinBitrateFactor", -1],
		["codecMaxBitrateFactor", Infinity],
		["codecBufsizeFactor", 0],
	] as const)("identifies invalid global %s without requiring a previous edit", (key, value) => {
		const current = fixture();
		Object.assign(current.goal, { [key]: value });
		expect(
			assessPerTitleValidity(current.goal, current.proposal),
		).toContainEqual(
			expect.objectContaining({
				code: "invalid-value",
				severity: "conflict",
				fields: [{ scope: "global", key }],
			}),
		);
	});
	it("checks both current input and emitted settings rather than masking an invalid input", () => {
		const current = fixture();
		current.goal.minBitrate = 2000;
		expect(codes(current)).toContain("global-range-order");
		current.goal.minBitrate = 100;
		current.proposal.api.global.minBitrateStepSize = 5;
		expect(codes(current)).toContain("step-range-order");
	});
	it("distinguishes positive API spacing outside the increasing-rung model", () => {
		const current = fixture();
		current.proposal.api.global.minBitrateStepSize = 1;
		expect(
			assessPerTitleValidity(current.goal, current.proposal),
		).toContainEqual(
			expect.objectContaining({
				code: "non-increasing-spacing",
				severity: "warning",
			}),
		);
		expect(codes(current)).not.toContain("invalid-value");
	});
	it.each([
		["minBitrate", 100.2],
		["maxBitrate", -1],
		["bitrateSelectionMode", "LINEAR"],
		[low, 0],
		[high, Number.NaN],
		["codecMaxBitrateFactor", 0],
		["codecBufsizeFactor", -1],
	] as const)("validates stream %s", (key, value) => {
		const current = fixture();
		Object.assign(setting(current), { [key]: value });
		expect(
			assessPerTitleValidity(current.goal, current.proposal),
		).toContainEqual(
			expect.objectContaining({
				code: "invalid-value",
				fields: [{ scope: "stream", rowId: "a", key }],
			}),
		);
	});
	it("identifies reversed and out-of-envelope fixed ranges", () => {
		const current = fixture();
		setting(current).minBitrate = 300;
		setting(current).maxBitrate = 200;
		setting(current, 1).maxBitrate = 2000;
		expect(codes(current)).toEqual(
			expect.arrayContaining(["stream-range-order", "stream-outside-envelope"]),
		);
	});
	it("checks saved row coherence even if a proposal contains different valid values", () => {
		const current = fixture();
		current.goal.rows = [
			{ id: "a", height: 240, minBitrate: 1300, maxBitrate: 1200 },
		];
		expect(codes(current)).toEqual(
			expect.arrayContaining(["stream-range-order", "stream-outside-envelope"]),
		);
	});
	it("checks a single supplied bound against either end of the global envelope", () => {
		const current = fixture();
		delete setting(current).maxBitrate;
		setting(current).minBitrate = 1200;
		expect(codes(current)).toContain("stream-outside-envelope");
	});
	it("reports missing active bounds and complexity boundaries without inventing provider defaults", () => {
		const current = fixture();
		delete setting(current).minBitrate;
		setting(current, 1).bitrateSelectionMode = "COMPLEXITY_RANGE";
		expect(codes(current)).toEqual(
			expect.arrayContaining([
				"fixed-range-unresolved",
				"complexity-boundaries-unresolved",
			]),
		);
	});
	it("rejects reversed complexity boundaries and reports inactive boundary settings", () => {
		const current = fixture();
		Object.assign(setting(current), {
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 800,
			[high]: 700,
		});
		Object.assign(setting(current, 1), {
			bitrateSelectionMode: "OPTIMIZED",
			[low]: 200,
			[high]: 900,
		});
		expect(codes(current)).toEqual(
			expect.arrayContaining([
				"complexity-boundary-order",
				"inactive-complexity-boundaries",
			]),
		);
	});
	it("flags fixed settings parked on an ordinary template without treating codec overrides as inactive", () => {
		const current = fixture();
		stream(current).mode = "PER_TITLE_TEMPLATE";
		setting(current).codecMaxBitrateFactor = 1.2;
		const result = assessPerTitleValidity(current.goal, current.proposal);
		const inactive = result.find(
			({ code }) => code === "inactive-fixed-settings",
		);
		expect(inactive?.fields?.map(({ key }) => key)).toEqual([
			"minBitrate",
			"maxBitrate",
		]);
	});
	it("reports saturation above and below the explicitly assumed input domain", () => {
		const current = fixture();
		Object.assign(setting(current), {
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 1100,
			[high]: 1400,
		});
		Object.assign(setting(current, 1), {
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 20,
			[high]: 80,
		});
		expect(codes(current)).toEqual(
			expect.arrayContaining([
				"complexity-always-minimum",
				"complexity-always-maximum",
			]),
		);
	});
	it("audits every integer input rather than only low and high endpoints", () => {
		const current = fixture();
		Object.assign(setting(current), {
			minBitrate: 100,
			maxBitrate: 600,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 200,
			[high]: 1000,
		});
		Object.assign(setting(current, 1), {
			minBitrate: 150,
			maxBitrate: 800,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 100,
			[high]: 300,
		});
		const result = codes(current);
		expect(result).toEqual(
			expect.arrayContaining([
				"within-row-expansion-risk",
				"adjacent-spacing-unproved",
				"adjacent-gap-unproved",
			]),
		);
	});
	it("checks the lifted complexity domain when a higher fixed-resolution row raises its floor above the cap", () => {
		const current = fixture();
		const global = {
			minBitrate: 100_000,
			maxBitrate: 1_000_000,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 4,
		};
		Object.assign(current.goal, global);
		Object.assign(current.proposal.api.global, global);
		current.proposal.api.streams = [
			{
				rowId: "lower",
				height: 360,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: {
					minBitrate: 200_000,
					maxBitrate: 900_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					[low]: 1_000_000,
					[high]: 1_100_000,
				},
			},
			{
				rowId: "higher",
				height: 720,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: {
					minBitrate: 600_000,
					maxBitrate: 700_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					[low]: 2_000_000,
					[high]: 3_000_000,
				},
			},
			{
				rowId: "fixed-resolution-only",
				height: 1080,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		];
		const result = assessPerTitleValidity(current.goal, current.proposal);
		// F = 600k * 2 = 1.2M. At C = 1.2M the row points are 900k
		// and 600k (ratio 2/3); the raw 100k..1M domain gives 200k/600k.
		expect(result.map(({ code }) => code)).toContain(
			"adjacent-spacing-unproved",
		);
		expect(
			result.find(({ code }) => code === "complexity-domain-checked")?.message
				.en,
		).toContain("1200000 to 1200000");
		expect(
			result.some(
				({ code, fields }) =>
					code === "complexity-always-minimum" &&
					fields?.some(({ rowId }) => rowId === "lower"),
			),
		).toBe(false);
	});
	it("uses the complexity floor for lower-end saturation advice", () => {
		const current = fixture();
		Object.assign(setting(current), {
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 200,
			[high]: 300,
		});
		// The highest fixed minimum is 400, so all C are at least 400.
		expect(codes(current)).toContain("complexity-always-maximum");
	});
	it("withholds interval and saturation claims when the complexity floor is ambiguous", () => {
		const current = fixture();
		stream(current, 1).height = stream(current).height;
		for (const row of [0, 1])
			Object.assign(setting(current, row), {
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				[low]: 1100,
				[high]: 1400,
			});
		const result = codes(current);
		expect(result).toContain("interval-analysis-unresolved");
		expect(result).not.toContain("complexity-domain-checked");
		expect(result).not.toContain("complexity-always-minimum");
		expect(result).not.toContain("complexity-always-maximum");
	});
	it("does not bound a LAST forced base through an unresolved complexity floor", () => {
		const current = fixture();
		stream(current, 1).width = 1280;
		Object.assign(setting(current, 1), {
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 300,
			[high]: 900,
		});
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 1,
			[factor]: 1.2,
			[mode]: "LAST_CALCULATED_BITRATE",
		};
		// Height order is known, but explicit widths and height-only rows are mixed.
		expect(codes(current)).toContain("forced-base-unresolved");
	});
	it("does not mistake a sufficient interval bound for proof of an actual native count failure", () => {
		const current = fixture();
		for (const row of [0, 1])
			Object.assign(setting(current, row), {
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				[low]: 300,
				[high]: 900,
			});
		const result = assessPerTitleValidity(current.goal, current.proposal);
		expect(
			result
				.filter(
					({ code }) => code.includes("unproved") || code.includes("risk"),
				)
				.every(({ severity }) => severity === "warning"),
		).toBe(true);
		expect(
			result.some(({ code }) => code === "complexity-domain-checked"),
		).toBe(true);
	});
	it.each([
		[count, -1],
		[count, 1.5],
		[factor, 0],
		[mode, "GEOMETRIC"],
	] as const)("validates forced-rule %s", (key, value) => {
		const current = fixture();
		Object.assign(current.proposal.api.global, {
			fixedResolutionAndBitrateConfiguration: { [key]: value },
		});
		expect(
			assessPerTitleValidity(current.goal, current.proposal),
		).toContainEqual(
			expect.objectContaining({
				code: "invalid-value",
				fields: [{ scope: "global", key: `${rule}${key}` }],
			}),
		);
	});
	it("keeps absent forced defaults unresolved and limits its own model without inventing an API count maximum", () => {
		const current = fixture();
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 300,
		};
		const result = assessPerTitleValidity(current.goal, current.proposal);
		expect(result).toContainEqual(
			expect.objectContaining({
				code: "forced-model-limit",
				severity: "warning",
			}),
		);
		expect(result).toContainEqual(
			expect.objectContaining({
				code: "forced-defaults-unresolved",
				severity: "warning",
			}),
		);
		expect(result.some(({ code }) => code === "invalid-value")).toBe(false);
	});
	it("flags unknown nested API fields instead of silently certifying them", () => {
		const current = fixture();
		Object.assign(current.proposal.api.global, {
			autoRepresentations: {
				adoptConfigurationThreshold: 0.5,
				unexpected: true,
			},
			fixedResolutionAndBitrateConfiguration: { [count]: 0, unexpected: 3 },
		});
		expect(
			assessPerTitleValidity(current.goal, current.proposal).filter(
				({ code }) => code === "unrecognized-api-field",
			),
		).toHaveLength(2);
	});
	it("finds rounded nonprogress even when a forced factor exceeds one", () => {
		const current = fixture();
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 2,
			[factor]: 1.00001,
			[mode]: "MAXIMUM",
		};
		expect(codes(current)).toContain("forced-nonprogress");
	});
	it.each([
		"MINIMUM",
		"MAXIMUM",
		"AVERAGE",
		"LAST_CALCULATED_BITRATE",
	] as const)("checks cap safety for forced base %s including the existing fixed range", (calculationMode) => {
		const current = fixture();
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 2,
			[factor]: 2,
			[mode]: calculationMode,
		};
		expect(codes(current)).toContain("forced-cap-exceeded");
	});
	it("truncates the average before the forced chain: 80 and 101 become 90, then 99 and 109", () => {
		const current = fixture();
		current.proposal.api.global.minBitrate = 10;
		current.proposal.api.global.maxBitrate = 109;
		setting(current).minBitrate = 10;
		setting(current).maxBitrate = 20;
		setting(current, 1).minBitrate = 80;
		setting(current, 1).maxBitrate = 101;
		current.goal.minBitrate = 10;
		current.goal.maxBitrate = 109;
		current.goal.rows = [
			{ id: "a", height: 240, minBitrate: 10, maxBitrate: 20 },
			{ id: "b", height: 720, minBitrate: 80, maxBitrate: 101 },
		];
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 2,
			[factor]: 1.1,
			[mode]: "AVERAGE",
		};
		expect(codes(current)).not.toContain("forced-cap-exceeded");
	});
	it.each([
		"height",
		"width",
		"repeated-height",
	] as const)("orders %s rows before checking adjacent intervals", (axis) => {
		const current = fixture();
		current.proposal.api.global.maxBitrateStepSize = 6;
		for (const row of [0, 1])
			Object.assign(setting(current, row), {
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				[low]: 300,
				[high]: 900,
			});
		if (axis === "width") {
			delete stream(current).height;
			delete stream(current, 1).height;
			stream(current).width = 426;
			stream(current, 1).width = 1280;
		} else if (axis === "repeated-height") stream(current, 1).height = 240;
		const ordered = codes(current);
		expect(ordered).not.toContain("adjacent-spacing-unproved");
		current.proposal.api.streams.reverse();
		expect(codes(current)).toEqual(ordered);
	});
	it("does not invent adjacency when fixed rows have incomparable dimensions", () => {
		const current = fixture();
		delete stream(current).height;
		stream(current).width = 426;
		for (const row of [0, 1])
			Object.assign(setting(current, row), {
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				[low]: 300,
				[high]: 900,
			});
		const result = codes(current);
		expect(result).toContain("interval-order-unresolved");
		expect(result).not.toContain("complexity-domain-checked");
		expect(result).not.toContain("adjacent-spacing-unproved");
	});
	it("checks LAST_CALCULATED_BITRATE against the reachable upper curve, not an unreachable configured maximum", () => {
		const current = fixture();
		Object.assign(setting(current, 1), {
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[low]: 1000,
			[high]: 2000,
		});
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 1,
			[factor]: 2.5,
			[mode]: "LAST_CALCULATED_BITRATE",
		};
		expect(codes(current)).not.toContain("forced-cap-exceeded");
	});
	it("reports integer overflow in the actual repeated forced calculation", () => {
		const current = fixture();
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 3,
			[factor]: 1e100,
			[mode]: "MAXIMUM",
		};
		expect(codes(current)).toContain("forced-integer-overflow");
	});
	it("flags inactive rules and unsupported fixed-resolution-only base calculations", () => {
		const current = fixture();
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration = {
			[count]: 0,
			[factor]: 1.2,
			[mode]: "AVERAGE",
		};
		expect(codes(current)).toContain("inactive-forced-settings");
		current.proposal.api.global.fixedResolutionAndBitrateConfiguration[count] =
			1;
		for (const stream of current.proposal.api.streams)
			stream.mode = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
		expect(codes(current)).toContain("forced-base-unresolved");
	});
	it("validates automatic-template adoption and exposes count uncertainty", () => {
		const current = fixture();
		current.proposal.api.global.autoRepresentations = {
			adoptConfigurationThreshold: 1.1,
		};
		current.goal.countPolicy = { kind: "exact", count: 2 };
		expect(codes(current)).toEqual(
			expect.arrayContaining(["invalid-value", "automatic-count-unresolved"]),
		);
	});
	it("does not certify a count from explicit ordinary templates when automatic generation is off", () => {
		const current = fixture();
		current.goal.countPolicy = { kind: "exact", count: 3 };
		current.proposal.api.streams.push({
			rowId: "automatic",
			height: 1080,
			mode: "PER_TITLE_TEMPLATE",
		});
		expect(codes(current)).toContain("automatic-count-unresolved");
	});
	it("rejects a requested count below the required fixed template count", () => {
		const current = fixture();
		current.goal.countPolicy = { kind: "maximum", count: 1 };
		expect(codes(current)).toContain("required-count-exceeded");
	});
	it.each([
		"H264",
		"H265",
		"H265V2",
		"VP9",
		"AV1",
	] as const)("checks codec-specific unsupported controls and retained quality dependencies for %s", (codec) => {
		const current = fixture();
		current.goal.codec = codec;
		current.proposal.codec = codec;
		Object.assign(current.proposal.api.global, {
			targetQualityCrf: 18,
			targetQualityQp: 20,
			codecMinBitrateFactor: 0.8,
			codecMaxBitrateFactor: 1.2,
			codecBufsizeFactor: 2,
			complexityFactor: 1,
			resolutionScaleFactor: 0,
		});
		setting(current).codecMaxBitrateFactor = 1.5;
		const result = assessPerTitleValidity(current.goal, current.proposal);
		expect(result.some(({ code }) => code === "unsupported-codec-field")).toBe(
			true,
		);
		expect(result.some(({ code }) => code === "quality-requires-media")).toBe(
			true,
		);
		if (codec === "H264")
			expect(codes(current)).toContain("ineffective-codec-minimum");
		if (codec === "H264" || codec === "H265")
			expect(codes(current)).toContain("stream-factor-override");
	});
	it("checks codec min/max rate factors using the effective stream override", () => {
		const current = fixture();
		current.goal.codec = "H265";
		current.proposal.codec = "H265";
		current.proposal.api.global.codecMinBitrateFactor = 1.3;
		current.proposal.api.global.codecMaxBitrateFactor = 1.5;
		setting(current).codecMaxBitrateFactor = 1.1;
		expect(codes(current)).toContain("codec-factor-order");
	});
	it("checks dimensions, duplicate row IDs, upscale requirements and mixed-axis ambiguity", () => {
		const current = fixture();
		current.goal.inputHeight = 480;
		stream(current).width = 1920;
		stream(current, 1).width = 1280;
		current.proposal.api.streams.push({
			rowId: "a",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
		expect(codes(current)).toEqual(
			expect.arrayContaining([
				"duplicate-row-id",
				"fixed-dimensions-missing",
				"upscale-required",
				"dimension-order-ambiguous",
			]),
		);
	});
	it("does not certify missing dimensions or modes using arbitrary defaults", () => {
		const current = fixture();
		delete stream(current).height;
		Object.assign(stream(current, 1), { mode: "STANDARD" });
		expect(codes(current)).toEqual(
			expect.arrayContaining([
				"fixed-dimensions-missing",
				"invalid-stream-mode",
			]),
		);
	});
	it("preserves all inputs and emits field-linked, bilingual actionable findings", () => {
		const current = fixture();
		const snapshot = structuredClone(current);
		const result = assessPerTitleValidity(current.goal, current.proposal);
		expect(current).toEqual(snapshot);
		expect(result.length).toBeGreaterThan(0);
		expect(
			result.every(
				({ message }) => message.en.length > 15 && message.ja.length > 8,
			),
		).toBe(true);
		expect(result.some(({ fields }) => fields?.length)).toBe(true);
	});
});
