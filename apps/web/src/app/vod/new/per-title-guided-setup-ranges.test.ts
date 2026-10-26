import { describe, expect, it } from "vitest";
import {
	buildPerTitleSetup,
	type PerTitleSetupInput,
} from "./per-title-guided-setup-model";
import { allocatePerTitleSetupRanges } from "./per-title-guided-setup-ranges";

const requirements = (): PerTitleSetupInput => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 160_000,
	maxBitrate: 6_400_000,
	rows: [288, 288, 576, 864].map((height, i) => ({ id: `band-${i}`, height })),
	automaticEdges: { lowerHeight: 144, upperHeights: [1080, 1296] },
	inputHeight: 1296,
});

describe("automatic bitrate bands from requirements", () => {
	it("rejects a width-only row at the height-based setup allocation boundary", () => {
		const source = JSON.parse(
			JSON.stringify({
				...requirements(),
				rows: [
					{
						id: "width-only",
						width: 640,
						minBitrate: 300_000,
						maxBitrate: 700_000,
					},
				],
			}),
		) as PerTitleSetupInput;
		const before = structuredClone(source);
		expect(allocatePerTitleSetupRanges(source, 1.5, 1.2)).toBeNull();
		expect(buildPerTitleSetup(source)).toMatchObject({
			status: "conflict",
			goal: null,
			issues: expect.arrayContaining([
				expect.objectContaining({ code: "invalid-height" }),
			]),
		});
		expect(source).toEqual(before);
	});

	it.each([
		"H264",
		"H265",
		"VP9",
	] as const)("reserves an upper role and a useful lower band for %s", (codec) => {
		const input = { ...requirements(), codec };
		const before = structuredClone(input);
		const result = buildPerTitleSetup(input);
		expect(result.goal).not.toBeNull();
		const rows = result.goal?.rows ?? [];
		expect(rows).toHaveLength(4);
		const step = result.goal?.minBitrateStepSize ?? 0;
		expect((rows.at(-1)?.minBitrate ?? 0) * (step - 0.01) ** 2).toBeGreaterThan(
			input.maxBitrate,
		);
		expect(
			(rows[0]?.maxBitrate ?? 0) / (rows[0]?.minBitrate ?? Infinity),
		).toBeGreaterThan(1.4);
		expect(result.goal?.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(result.proposal?.countGuarantee).toBe(false);
		expect(result.goal?.targetQualityCrf).toBeUndefined();
		expect(input).toEqual(before);
	});

	it("scales an unmeasured bitrate budget without inventing codec quality", () => {
		const input = requirements();
		const a = allocatePerTitleSetupRanges(input, 1.5, 1.2);
		const b = allocatePerTitleSetupRanges(
			{
				...input,
				minBitrate: input.minBitrate * 10,
				maxBitrate: input.maxBitrate * 10,
			},
			1.5,
			1.2,
		);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		for (const [index, row] of (a ?? []).entries()) {
			expect(b?.[index]?.minBitrate).toBe((row.minBitrate ?? 0) * 10);
			expect(b?.[index]?.maxBitrate).toBe((row.maxBitrate ?? 0) * 10);
		}
	});

	it("keeps user endpoints when only part of the budget is supplied", () => {
		const input = requirements();
		input.rows = input.rows.map((row, index) => ({
			...row,
			...(index === 0 ? { minBitrate: 450_000 } : {}),
			...(index === 1 ? { maxBitrate: 1_200_000 } : {}),
		}));
		const result = buildPerTitleSetup(input);
		expect(result.goal).not.toBeNull();
		expect(result.goal?.rows?.[0]?.minBitrate).toBe(450_000);
		expect(result.goal?.rows?.[1]?.maxBitrate).toBe(1_200_000);
	});

	it("recalculates a higher overall ceiling while retaining chosen lower endpoints", () => {
		const input = requirements();
		input.maxBitrate *= 1.5;
		input.rows = input.rows.map((row, index) => ({
			...row,
			...(index === 0 ? { minBitrate: 450_000 } : {}),
			...(index === 1 ? { minBitrate: 720_000 } : {}),
		}));
		const result = buildPerTitleSetup(input);
		expect(result.goal?.rows?.[0]?.minBitrate).toBe(450_000);
		expect(result.goal?.rows?.[1]?.minBitrate).toBe(720_000);
		expect(result.goal?.rows?.at(-1)?.maxBitrate).toBeGreaterThan(5_000_000);
		expect(result.proposal?.applicable).toBe(true);
		expect(
			result.proposal?.derivation?.constraints?.conditionalModel?.count,
		).toBe(6);
		expect(result.proposal?.countGuarantee).toBe(false);
	});

	it.each([
		1, 2, 3, 4, 5, 6,
	])("retains all %i required fixed rows when creating empty bands", (count) => {
		const input = requirements();
		input.rows = Array.from({ length: count }, (_, i) => ({
			id: `r-${i}`,
			height: 240 + i * 120,
		}));
		const result = buildPerTitleSetup(input);
		expect(result.goal?.rows).toHaveLength(count);
		expect(result.goal?.countPolicy).toEqual({
			kind: "exact",
			count: count + 2,
		});
		expect(result.proposal?.api.streams).toHaveLength(count + 3);
		expect(result.proposal?.countGuarantee).toBe(false);
	});

	it("keeps resolution identities after reordering distinct heights", () => {
		const input = requirements();
		input.rows = input.rows.slice(1);
		const a = allocatePerTitleSetupRanges(input, 1.5, 1.2);
		const b = allocatePerTitleSetupRanges(
			{ ...input, rows: [...input.rows].reverse() },
			1.5,
			1.2,
		);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect([...(a ?? [])].sort((x, y) => x.height - y.height)).toEqual(
			[...(b ?? [])].sort((x, y) => x.height - y.height),
		);
	});
});
