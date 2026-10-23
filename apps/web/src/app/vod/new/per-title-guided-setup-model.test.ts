import {
	certifyComplexityIntervals,
	evaluateComplexityRange,
	type PerTitleGoal,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildPerTitleSetup,
	type PerTitleSetupInput,
} from "./per-title-guided-setup-model";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const rows = () =>
	[240, 360, 480, 720, 1080].map((height, index) => ({
		id: `row-${index + 1}`,
		height,
	}));

const input = (
	strategy: PerTitleGoal["strategy"] = "fixed-ranges",
): PerTitleSetupInput => ({
	strategy,
	codec: "H264",
	minBitrate: 250_000,
	maxBitrate: 6_000_000,
	inputHeight: 1080,
	...(strategy === "count" ? { count: 5 } : {}),
	rows: strategy === "automatic" || strategy === "count" ? [] : rows(),
});

function requireGoal(result: ReturnType<typeof buildPerTitleSetup>) {
	expect(result.goal).not.toBeNull();
	expect(result.proposal).not.toBeNull();
	if (!result.goal || !result.proposal) throw new Error("Expected a setup.");
	return { goal: result.goal, proposal: result.proposal };
}

describe("new Per-Title requirements", () => {
	it.each([
		"automatic",
		"count",
		"required-resolutions",
		"fixed-resolutions",
		"fixed-ranges",
	] as const)("builds a stable %s candidate from fresh requirements", (strategy) => {
		const source = input(strategy);
		const before = structuredClone(source);
		const result = buildPerTitleSetup(source);
		const { goal, proposal } = requireGoal(result);
		expect(result.status).toBe("ready");
		expect(result.issues).toEqual([]);
		expect(goal.minBitrate).toBe(source.minBitrate);
		expect(goal.maxBitrate).toBe(source.maxBitrate);
		expect(goal.codec).toBe(source.codec);
		expect(goal.strategy).toBe(strategy);
		expect(tunePerTitleSettings(goal, goal).proposal.api).toEqual(proposal.api);
		expect(proposal.countGuarantee).toBe(false);
		expect(proposal.evidence).toBe("model-only");
		expect(result.reasoning.length).toBeGreaterThan(0);
		expect(result.reasoning.every((item) => item.en && item.ja)).toBe(true);
		expect(source).toEqual(before);
	});

	it.each([
		"H264",
		"H265",
		"VP9",
		"AV1",
	] as const)("allows public %s without importing a codec-specific quality target", (codec) => {
		const result = buildPerTitleSetup({ ...input("automatic"), codec });
		const { goal, proposal } = requireGoal(result);
		expect(result.status).toBe("ready");
		expect(proposal.codec).toBe(codec);
		expect(goal.targetQualityCrf).toBeUndefined();
		expect(goal.targetQualityQp).toBeUndefined();
		expect(goal.fixedResolutionAndBitrateConfiguration).toBeUndefined();
	});

	it("allows a restricted codec only when explicitly permitted", () => {
		const source = { ...input("automatic"), codec: "H265V2" as const };
		expect(buildPerTitleSetup(source).status).toBe("conflict");
		expect(buildPerTitleSetup(source, ["H265V2"]).status).toBe("ready");
		expect(buildPerTitleSetup(input("automatic"), ["VP9"]).status).toBe(
			"conflict",
		);
	});

	it.each([
		"automatic",
		"count",
	] as const)("does not invent required resolutions in %s mode", (strategy) => {
		const { goal, proposal } = requireGoal(buildPerTitleSetup(input(strategy)));
		expect(goal.rows).toEqual([]);
		expect(
			proposal.api.streams.every(
				(stream) => stream.mode === "PER_TITLE_TEMPLATE",
			),
		).toBe(true);
		expect(proposal.api.streams).toHaveLength(1);
		expect(goal.countPolicy).toEqual(
			strategy === "count"
				? { kind: "exact", count: 5 }
				: { kind: "unrestricted" },
		);
	});

	it("keeps partial required resolutions open and an explicit count conditional", () => {
		const partial = {
			...input("required-resolutions"),
			rows: rows().slice(-2),
		};
		const result = buildPerTitleSetup({ ...partial, count: 6 });
		const { goal, proposal } = requireGoal(result);
		expect(goal.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(goal.rows?.map((row) => row.id)).toEqual(["row-4", "row-5"]);
		expect(
			proposal.api.streams.filter((row) => row.mode === "PER_TITLE_TEMPLATE"),
		).toHaveLength(1);
		expect(proposal.countGuarantee).toBe(false);
	});

	it.each([
		"fixed-resolutions",
		"fixed-ranges",
	] as const)("closes %s output around every requested row without a fallback", (strategy) => {
		const source = input(strategy);
		const { goal, proposal } = requireGoal(buildPerTitleSetup(source));
		expect(goal.countPolicy).toEqual({ kind: "exact", count: 5 });
		expect(goal.autoRepresentations).toBe(false);
		expect(goal.automaticTemplates).toEqual([]);
		expect(goal.fixedResolutionAndBitrateConfiguration).toBeUndefined();
		expect(proposal.api.global.autoRepresentations).toBeUndefined();
		expect(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		).toBeUndefined();
		expect(proposal.api.streams).toHaveLength(source.rows.length);
		expect(proposal.api.streams.map((row) => [row.rowId, row.height])).toEqual(
			source.rows.map((row) => [row.id, row.height]),
		);
		expect(
			proposal.api.streams.some((row) => row.mode === "PER_TITLE_TEMPLATE"),
		).toBe(false);
	});

	it("derives common-boundary ranges with rounding-aware spacing", () => {
		const { goal, proposal } = requireGoal(buildPerTitleSetup(input()));
		const generated = goal.rows ?? [];
		expect(generated[0]?.minBitrate).toBe(250_000);
		expect(generated[0]?.maxBitrate).toBe(250_000);
		expect(generated.at(-1)?.maxBitrate).toBe(6_000_000);
		const curves = generated.map((row) => ({
			minimum: row.minBitrate as number,
			maximum: row.maxBitrate as number,
			low: row.lowComplexityBoundaryForMaxBitrate as number,
			high: row.highComplexityBoundaryForMaxBitrate as number,
		}));
		expect(new Set(curves.map((row) => row.low)).size).toBe(1);
		expect(new Set(curves.map((row) => row.high)).size).toBe(1);
		const certificate = certifyComplexityIntervals(
			curves,
			{ minimum: goal.minBitrate, maximum: goal.maxBitrate },
			proposal.api.global.minBitrateStepSize,
		);
		expect(certificate).not.toBeNull();
		expect(
			(certificate?.maximumWithinRowRatio ?? Infinity) + 0.01,
		).toBeLessThan(proposal.api.global.minBitrateStepSize);
		expect(certificate?.minimumAdjacentRatio).toBeGreaterThanOrEqual(
			proposal.api.global.minBitrateStepSize,
		);
		expect(certificate?.maximumAdjacentRatio).toBeLessThanOrEqual(
			proposal.api.global.maxBitrateStepSize,
		);
	});

	it("uses whole kbps for generated interior endpoints in ordinary bitrate ranges", () => {
		const { goal } = requireGoal(buildPerTitleSetup(input()));
		for (const row of goal.rows ?? []) {
			expect((row.minBitrate ?? 0) % 1000).toBe(0);
			expect((row.maxBitrate ?? 0) % 1000).toBe(0);
		}
	});

	it("reaches every configured minimum at the native structural floor and every maximum at the cap", () => {
		const { goal, proposal } = requireGoal(buildPerTitleSetup(input()));
		const ordered = [...(goal.rows ?? [])].sort((a, b) => a.height - b.height);
		const floor = ordered.at(-1)?.minBitrate ?? NaN;
		for (const row of ordered) {
			expect(row.lowComplexityBoundaryForMaxBitrate).toBe(floor);
			const curve = {
				minimum: row.minBitrate as number,
				maximum: row.maxBitrate as number,
				low: row.lowComplexityBoundaryForMaxBitrate as number,
				high: row.highComplexityBoundaryForMaxBitrate as number,
				minStep: proposal.api.global.minBitrateStepSize,
			};
			expect(evaluateComplexityRange({ ...curve, input: floor })).toEqual({
				minimum: row.minBitrate,
				maximum: row.minBitrate,
			});
			expect(
				evaluateComplexityRange({ ...curve, input: goal.maxBitrate }),
			).toEqual({ minimum: row.maxBitrate, maximum: row.maxBitrate });
		}
	});

	it("rejects width below a highest fixed minimum already at the overall cap", () => {
		const result = buildPerTitleSetup({
			...input(),
			rows: [
				{ id: "low", height: 240, minBitrate: 250_000, maxBitrate: 500_000 },
				{
					id: "top",
					height: 1080,
					minBitrate: 6_000_000,
					maxBitrate: 6_000_000,
				},
			],
		});
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
		expect(result.proposal).toBeNull();
		expect(
			result.issues.some((issue) => issue.code === "unreachable-minimum"),
		).toBe(true);
	});

	it("preserves supplied bitrate endpoints while deriving omitted endpoints", () => {
		const source = input();
		source.rows = rows().map((row, index) =>
			index === 0
				? { ...row, minBitrate: 250_000, maxBitrate: 250_000 }
				: index === 4
					? { ...row, maxBitrate: 6_000_000 }
					: row,
		);
		const result = buildPerTitleSetup(source);
		const { goal } = requireGoal(result);
		expect(result.status).toBe("ready");
		for (const row of source.rows) {
			const returned = goal.rows?.find((item) => item.id === row.id);
			if (row.minBitrate !== undefined)
				expect(returned?.minBitrate).toBe(row.minBitrate);
			if (row.maxBitrate !== undefined)
				expect(returned?.maxBitrate).toBe(row.maxBitrate);
		}
	});

	it("uses one adaptable fixed range for a single requested resolution", () => {
		const result = buildPerTitleSetup({
			...input(),
			rows: [{ id: "one", height: 1080 }],
		});
		const { goal, proposal } = requireGoal(result);
		expect(result.status).toBe("ready");
		expect(goal.rows?.[0]).toMatchObject({
			minBitrate: 250_000,
			maxBitrate: 6_000_000,
		});
		expect(proposal.api.streams).toHaveLength(1);
	});

	it("supports one constant rendition when the overall range is a point", () => {
		const result = buildPerTitleSetup({
			...input(),
			maxBitrate: 250_000,
			rows: [{ id: "one", height: 240 }],
		});
		const { goal } = requireGoal(result);
		expect(result.status).toBe("ready");
		expect(goal.rows?.[0]).toMatchObject({
			minBitrate: 250_000,
			maxBitrate: 250_000,
		});
	});

	it("keeps same-resolution rows separate rather than silently removing one", () => {
		const source = input();
		source.rows = rows().map((row, index) => ({
			...row,
			height: index === 2 ? 360 : row.height,
		}));
		const result = buildPerTitleSetup(source);
		const { goal, proposal } = requireGoal(result);
		expect(["ready", "unverified"]).toContain(result.status);
		expect(goal.rows).toHaveLength(5);
		expect(proposal.api.streams).toHaveLength(5);
		expect(goal.rows?.filter((row) => row.height === 360)).toHaveLength(2);
	});

	it("does not import unrelated quality targets, rules, or locks", () => {
		const source = {
			...input("automatic"),
			targetQualityCrf: 14,
			complexityFactor: 4,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
			},
			settingLocks: { global: ["targetQualityCrf"] },
			adjustments: { global: { maxBitrate: { mode: "auto" } } },
		};
		const { goal } = requireGoal(buildPerTitleSetup(source));
		expect(goal.targetQualityCrf).toBeUndefined();
		expect(goal.complexityFactor).toBeUndefined();
		expect(goal.fixedResolutionAndBitrateConfiguration).toBeUndefined();
		expect(goal.adjustments).toBeUndefined();
	});

	it.each([
		{ name: "nonfinite bitrate", patch: { maxBitrate: NaN } },
		{ name: "fractional bitrate", patch: { minBitrate: 250_000.5 } },
		{ name: "reversed range", patch: { minBitrate: 7_000_000 } },
		{ name: "provider integer limit", patch: { maxBitrate: 2_147_483_648 } },
		{ name: "invalid source height", patch: { inputHeight: Infinity } },
		{ name: "invalid strategy", patch: { strategy: "other" } },
		{ name: "invalid codec", patch: { codec: "other" } },
		{ name: "missing rows", patch: { rows: [] } },
		{
			name: "duplicate identity",
			patch: {
				rows: [
					{ id: "a", height: 240 },
					{ id: "a", height: 360 },
				],
			},
		},
		{ name: "empty identity", patch: { rows: [{ id: "", height: 240 }] } },
		{
			name: "fractional height",
			patch: { rows: [{ id: "a", height: 240.5 }] },
		},
		{ name: "upscaling", patch: { inputHeight: 720 } },
		{
			name: "too many rows",
			patch: {
				rows: Array.from({ length: 65 }, (_, index) => ({
					id: `r${index}`,
					height: index + 1,
				})),
			},
		},
		{ name: "different closed count", patch: { count: 6 } },
		{ name: "invalid count", patch: { count: 0 } },
		{ name: "fractional count", patch: { count: 2.5 } },
		{ name: "too many outputs", patch: { count: 65 } },
		{
			name: "row below global range",
			patch: {
				rows: [
					{ id: "a", height: 240, minBitrate: 249_999, maxBitrate: 500_000 },
				],
			},
		},
		{
			name: "row above global range",
			patch: {
				rows: [
					{ id: "a", height: 240, minBitrate: 300_000, maxBitrate: 6_000_001 },
				],
			},
		},
		{
			name: "reversed row",
			patch: {
				rows: [
					{ id: "a", height: 240, minBitrate: 800_000, maxBitrate: 400_000 },
				],
			},
		},
	] as const)("rejects $name with a concrete localized issue", ({ patch }) => {
		const result = buildPerTitleSetup({
			...input(),
			...patch,
		} as PerTitleSetupInput);
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
		expect(result.proposal).toBeNull();
		expect(result.issues.length).toBeGreaterThan(0);
		expect(
			result.issues.every(
				(issue) => issue.code && issue.message.en && issue.message.ja,
			),
		).toBe(true);
	});

	it("rejects ignored rows or ranges rather than quietly dropping requirements", () => {
		expect(
			buildPerTitleSetup({ ...input("automatic"), rows: rows() }).status,
		).toBe("conflict");
		expect(
			buildPerTitleSetup({
				...input("fixed-resolutions"),
				rows: [{ id: "one", height: 240, minBitrate: 300_000 }],
			}).status,
		).toBe("conflict");
		expect(
			buildPerTitleSetup({ ...input("count"), count: undefined }).status,
		).toBe("conflict");
	});

	it("rejects an exact count that has too few distinct integer bitrate values", () => {
		const result = buildPerTitleSetup({
			...input("count"),
			minBitrate: 100,
			maxBitrate: 102,
			count: 4,
		});
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
	});

	it("never labels a tiny unresolved spacing interval ready", () => {
		const result = buildPerTitleSetup({
			...input(),
			minBitrate: 100,
			maxBitrate: 101,
			rows: rows().slice(0, 2),
		});
		expect(["conflict", "unverified"]).toContain(result.status);
		expect(result.issues.length).toBeGreaterThan(0);
	});

	it("blocks contradictory overlapping bands without changing manual requirements", () => {
		const requested = [
			{ id: "low", height: 240, minBitrate: 400_000, maxBitrate: 800_000 },
			{ id: "high", height: 720, minBitrate: 400_000, maxBitrate: 800_000 },
		];
		const before = structuredClone(requested);
		const result = buildPerTitleSetup({ ...input(), rows: requested });
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
		expect(result.proposal).toBeNull();
		expect(result.issues.length).toBeGreaterThan(0);
		expect(requested).toEqual(before);
	});
});
