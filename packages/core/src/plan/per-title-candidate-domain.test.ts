import { describe, expect, it } from "vitest";
import { constrainPerTitleApiCandidate } from "./per-title-candidate-api";
import {
	type PerTitleCodec,
	type PerTitleGoal,
	recommendPerTitleSettings,
} from "./per-title-simulator";
import { perTitleSchema, perTitleStreamSettingsSchema } from "./schema";

const maximum = 2_147_483_647;
const codecs = ["H264", "H265", "H265V2", "VP9", "AV1"] as const;
const layouts = ["ordinary", "resolution", "fixed-range", "mixed"] as const;
const fields = {
	H264: "h264Configuration",
	H265: "h265Configuration",
	H265V2: "h265V2Configuration",
	VP9: "vp9Configuration",
	AV1: "av1Configuration",
} as const;

function goalFor(
	codec: PerTitleCodec,
	layout: (typeof layouts)[number],
): PerTitleGoal {
	return {
		codec,
		strategy:
			layout === "ordinary"
				? "automatic"
				: layout === "resolution"
					? "fixed-resolutions"
					: "fixed-ranges",
		minBitrate: 100_000,
		maxBitrate: 1_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		countPolicy: { kind: "unrestricted" },
		autoRepresentations: layout === "ordinary" ? {} : false,
		...(layout === "ordinary"
			? {}
			: {
					rows: [
						{
							id: "required",
							height: 720,
							...(layout === "resolution"
								? {}
								: {
										minBitrate: 200_000,
										maxBitrate: 200_000,
										bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
										lowComplexityBoundaryForMaxBitrate: 400_000,
										highComplexityBoundaryForMaxBitrate: 1_000_000,
									}),
						},
					],
				}),
		...(layout === "mixed"
			? { automaticTemplates: [{ id: "automatic", height: 1080 }] }
			: {}),
	};
}

describe("supported Per-Title bitrate domain", () => {
	it.each(
		codecs.flatMap((codec) =>
			layouts.flatMap((layout) =>
				(["minimum", "maximum"] as const).flatMap((bound) =>
					[false, true].map((above) => ({ codec, layout, bound, above })),
				),
			),
		),
	)("checks $codec $layout $bound at one above limit: $above without inventing an API limit", ({
		codec,
		layout,
		bound,
		above,
	}) => {
		const goal = goalFor(codec, layout);
		const value = maximum + Number(above);
		goal.maxBitrate = value;
		if (bound === "minimum") {
			goal.minBitrate = value;
			goal.rows = goal.rows?.map((row) => ({
				...row,
				...(layout === "resolution"
					? {}
					: { minBitrate: value, maxBitrate: value }),
			}));
		}
		const before = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		expect(
			perTitleSchema.safeParse({ [fields[codec]]: proposal.api.global })
				.success,
		).toBe(true);
		expect(proposal.applicable).toBe(!above);
		if (above) {
			expect(proposal.status).not.toBe("candidate");
			expect(proposal.derivation?.targetSatisfied).not.toBe(true);
			expect(proposal.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "model-limit",
					severity: "conflict",
					values: expect.objectContaining({
						limit: "bitrate",
						maximumBitrate: maximum,
					}),
				}),
			);
		} else {
			expect(
				proposal.diagnostics.some((item) => item.code === "model-limit"),
			).toBe(false);
		}
		expect(goal).toEqual(before);
	});

	it.each(
		codecs.flatMap((codec) =>
			(
				[
					"minBitrate",
					"maxBitrate",
					"lowComplexityBoundaryForMaxBitrate",
					"highComplexityBoundaryForMaxBitrate",
				] as const
			).map((field) => ({ codec, field })),
		),
	)("rejects an emitted $codec stream $field above the supported range", ({
		codec,
		field,
	}) => {
		const proposal = recommendPerTitleSettings(goalFor(codec, "fixed-range"));
		const stream = proposal.api.streams[0];
		if (!stream?.perTitleSettings)
			throw new Error("Expected fixed stream settings");
		stream.perTitleSettings[field] = maximum + 1;
		expect(
			perTitleStreamSettingsSchema.safeParse(stream.perTitleSettings).success,
		).toBe(true);
		const before = structuredClone(proposal);
		const checked = constrainPerTitleApiCandidate(proposal);
		expect(checked).toMatchObject({ status: "conflict", applicable: false });
		expect(checked.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "model-limit",
				severity: "conflict",
				rowIds: [stream.rowId],
				values: expect.objectContaining({
					limit: "bitrate",
					maximumBitrate: maximum,
					fields: expect.stringContaining(field),
				}),
			}),
		);
		expect(proposal).toEqual(before);
	});

	it("does not apply the bitrate ceiling to dimensions, ratios or codec factors", () => {
		const goal = goalFor("H264", "fixed-range");
		goal.minBitrateStepSize = maximum + 1;
		goal.maxBitrateStepSize = maximum + 1;
		goal.codecMaxBitrateFactor = maximum + 1;
		goal.rows = goal.rows?.map((row) => ({
			...row,
			height: maximum + 1,
			width: maximum + 1,
		}));
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal).toMatchObject({ status: "candidate", applicable: true });
		expect(
			proposal.diagnostics.some((item) => item.code === "model-limit"),
		).toBe(false);
	});
});
