import { describe, expect, it } from "vitest";
import {
	buildPerTitleSetup,
	type PerTitleSetupInput,
} from "./per-title-guided-setup-model";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const strategies = [
	"automatic",
	"count",
	"required-resolutions",
	"fixed-resolutions",
	"fixed-ranges",
] as const;
const codecs = ["H264", "H265", "VP9", "AV1"] as const;

function requirements(
	strategy: PerTitleSetupInput["strategy"],
	codec: PerTitleSetupInput["codec"],
): PerTitleSetupInput {
	return {
		strategy,
		codec,
		minBitrate: 250_000,
		maxBitrate: 6_000_000,
		targetQualityCrf: 17,
		...(strategy === "count" ? { count: 5 } : {}),
		rows:
			strategy === "automatic" || strategy === "count"
				? []
				: [240, 360, 480, 720, 1080].map((height, index) => ({
						id: `required-${index}`,
						height,
					})),
	};
}

describe("requirements-based Per-Title quality target", () => {
	it.each(
		codecs.flatMap((codec) =>
			strategies.map((strategy) => ({ codec, strategy })),
		),
	)("preserves explicit quality for $codec / $strategy", ({
		codec,
		strategy,
	}) => {
		const input = requirements(strategy, codec);
		const before = structuredClone(input);
		const result = buildPerTitleSetup(input);
		expect(result.status).toBe("ready");
		expect(result.goal?.targetQualityCrf).toBe(17);
		expect(result.proposal?.api.global.targetQualityCrf).toBe(17);
		if (!result.goal) throw new Error("Expected a requirements-based goal.");
		expect(tunePerTitleSettings(result.goal, result.goal).proposal.api).toEqual(
			result.proposal?.api,
		);
		expect(input).toEqual(before);
	});

	it("keeps an explicitly entered zero rather than dropping it", () => {
		const result = buildPerTitleSetup({
			...requirements("automatic", "H264"),
			targetQualityCrf: 0,
		});
		expect(result.goal?.targetQualityCrf).toBe(0);
		expect(result.proposal?.api.global.targetQualityCrf).toBe(0);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("rejects non-finite quality %s before generating an adoptable proposal", (targetQualityCrf) => {
		const result = buildPerTitleSetup({
			...requirements("automatic", "H264"),
			targetQualityCrf,
		});
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
		expect(result.proposal).toBeNull();
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: "targetQualityCrf" }),
			]),
		);
	});

	it("does not translate a CRF input into the restricted codec's QP", () => {
		const result = buildPerTitleSetup(requirements("automatic", "H265V2"), [
			"H265V2",
		]);
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
		expect(result.proposal).toBeNull();
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: "targetQualityCrf" }),
			]),
		);
	});

	it.each([
		"H264",
		"H265",
		"VP9",
	] as const)("preserves quality and user bands across mixed %s roles", (codec) => {
		const input: PerTitleSetupInput = {
			strategy: "fixed-ranges",
			codec,
			targetQualityCrf: 17,
			minBitrate: 160_000,
			maxBitrate: 5_000_000,
			count: 6,
			automaticEdges: { lowerHeight: 160, upperHeights: [960, 1152] },
			rows: [
				{
					id: "small-a",
					height: 320,
					minBitrate: 400_000,
					maxBitrate: 640_000,
				},
				{
					id: "small-b",
					height: 320,
					minBitrate: 750_000,
					maxBitrate: 1_100_000,
				},
				{
					id: "medium",
					height: 576,
					minBitrate: 1_200_000,
					maxBitrate: 1_700_000,
				},
				{
					id: "large",
					height: 768,
					minBitrate: 2_000_000,
					maxBitrate: 2_800_000,
				},
			],
		};
		const before = structuredClone(input);
		const result = buildPerTitleSetup(input);
		expect(result.status).toBe("unverified");
		expect(result.goal?.targetQualityCrf).toBe(17);
		expect(result.proposal?.api.global.targetQualityCrf).toBe(17);
		expect(result.goal?.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(result.proposal?.countGuarantee).toBe(false);
		expect(
			result.goal?.rows?.map(({ height, minBitrate, maxBitrate }) => ({
				height,
				minBitrate,
				maxBitrate,
			})),
		).toEqual(
			input.rows.map(({ height, minBitrate, maxBitrate }) => ({
				height,
				minBitrate,
				maxBitrate,
			})),
		);
		if (!result.goal) throw new Error("Expected a mixed-role goal.");
		expect(tunePerTitleSettings(result.goal, result.goal).proposal.api).toEqual(
			result.proposal?.api,
		);
		expect(input).toEqual(before);
	});
});
