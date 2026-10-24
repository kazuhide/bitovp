import { describe, expect, it } from "vitest";
import { constrainPerTitleApiCandidate } from "./per-title-candidate-api";
import {
	type PerTitleCodec,
	type PerTitleGoal,
	proposePerTitleSettings,
	recommendPerTitleSettings,
} from "./per-title-simulator";
import { perTitleSchema, perTitleStreamSettingsSchema } from "./schema";

const codecs = ["H264", "H265", "H265V2", "VP9", "AV1"] as const;
const layouts = ["ordinary", "resolution", "fixed-range", "mixed"] as const;
const fields = {
	H264: "h264Configuration",
	H265: "h265Configuration",
	H265V2: "h265V2Configuration",
	VP9: "vp9Configuration",
	AV1: "av1Configuration",
} as const;
const COUNT =
	"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation";

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
			? {
					automaticTemplates: [{ id: "automatic", height: 1080 }],
				}
			: {}),
	};
}

describe("Per-Title API candidate postcondition", () => {
	it.each([
		"automatic-option",
		"additional-option",
		"selection-mode",
	] as const)("rejects an unsupported %s through the canonical API schemas", (invalid) => {
		const goal = goalFor(
			"H264",
			invalid === "automatic-option" ? "ordinary" : "fixed-range",
		);
		if (invalid === "automatic-option")
			goal.autoRepresentations = {
				adoptConfigurationThreshold: 0.5,
				...{ unsupportedOption: true },
			};
		if (invalid === "additional-option")
			goal.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: 0,
				...{ unsupportedOption: true },
			};
		if (invalid === "selection-mode") {
			const row = goal.rows?.[0];
			if (!row) throw new Error("Expected a required row");
			Object.assign(row, { bitrateSelectionMode: "UNSUPPORTED" });
		}
		for (const proposal of [
			recommendPerTitleSettings(goal),
			...proposePerTitleSettings(goal),
		]) {
			expect(proposal.applicable).toBe(false);
			expect(proposal.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "invalid-setting",
					severity: "conflict",
				}),
			);
			expect(proposal.derivation?.targetSatisfied).not.toBe(true);
		}
	});

	it.each([
		"invalid-bound",
		"fixed-fields-on-ordinary",
		"unsupported-codec-factors",
	] as const)("validates emitted stream settings without mutating the input (%s)", (invalid) => {
		const proposal = recommendPerTitleSettings(
			goalFor("H264", invalid === "invalid-bound" ? "fixed-range" : "ordinary"),
		);
		expect(proposal.applicable).toBe(true);
		const stream = proposal.api.streams[0];
		if (!stream) throw new Error("Expected a template stream");
		if (invalid === "invalid-bound")
			stream.perTitleSettings = { minBitrate: 0 };
		if (invalid === "fixed-fields-on-ordinary")
			stream.perTitleSettings = { minBitrate: 100_000 };
		if (invalid === "unsupported-codec-factors") {
			proposal.codec = "VP9";
			stream.perTitleSettings = { codecMaxBitrateFactor: 1.5 };
		}
		const before = structuredClone(proposal);
		const checked = constrainPerTitleApiCandidate(proposal);
		expect(checked).toMatchObject({ status: "conflict", applicable: false });
		expect(checked.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-setting",
				rowIds: [stream.rowId],
			}),
		);
		expect(proposal).toEqual(before);
	});

	it.each(
		codecs.flatMap((codec) =>
			layouts.flatMap((layout) =>
				["minimum-below-floor", "maximum-below-floor"].map((invalid) => ({
					codec,
					layout,
					invalid,
				})),
			),
		),
	)("does not offer $codec $layout with $invalid as applicable", ({
		codec,
		layout,
		invalid,
	}) => {
		const goal = goalFor(codec, layout);
		goal.minBitrate = invalid === "minimum-below-floor" ? 9_999 : 1;
		if (invalid === "maximum-below-floor") {
			goal.maxBitrate = 9_999;
			goal.rows = goal.rows?.map((row) => ({
				...row,
				...(layout === "resolution"
					? {}
					: {
							minBitrate: 100,
							maxBitrate: 100,
							lowComplexityBoundaryForMaxBitrate: 200,
							highComplexityBoundaryForMaxBitrate: 9_999,
						}),
			}));
		}
		const before = structuredClone(goal);
		for (const proposal of [
			recommendPerTitleSettings(goal),
			...proposePerTitleSettings(goal),
		]) {
			expect(
				perTitleSchema.safeParse({ [fields[codec]]: proposal.api.global })
					.success,
			).toBe(false);
			expect(proposal.applicable).toBe(false);
			expect(proposal.status).not.toBe("candidate");
			expect(proposal.derivation?.targetSatisfied).not.toBe(true);
			expect(proposal.countGuarantee).toBe(false);
		}
		expect(goal).toEqual(before);
	});

	it.each(
		codecs.flatMap((codec) => layouts.map((layout) => ({ codec, layout }))),
	)("keeps valid $codec $layout API candidates usable at the canonical global floor", ({
		codec,
		layout,
	}) => {
		const goal = { ...goalFor(codec, layout), minBitrate: 10_000 };
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal).toMatchObject({ status: "candidate", applicable: true });
		expect(
			perTitleSchema.safeParse({ [fields[codec]]: proposal.api.global })
				.success,
		).toBe(true);
		for (const stream of proposal.api.streams)
			if (stream.perTitleSettings)
				expect(
					perTitleStreamSettingsSchema.safeParse(stream.perTitleSettings)
						.success,
				).toBe(true);
	});
});

describe("explicit disabled additional-rule preservation", () => {
	it.each(
		codecs.flatMap((codec) =>
			(["exact", "maximum", "unrestricted"] as const).flatMap((kind) =>
				[false, true].flatMap((locked) =>
					[false, true].map((metadata) => ({ codec, kind, locked, metadata })),
				),
			),
		),
	)("retains the $codec zero rule for $kind (locked: $locked, metadata: $metadata)", ({
		codec,
		kind,
		locked,
		metadata,
	}) => {
		const rule = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
			...(metadata
				? {
						forcedRenditionAboveHighestFixedRepresentationFactor: 1.37,
						forcedRenditionAboveHighestFixedRepresentationCalculationMode:
							"MINIMUM" as const,
					}
				: {}),
		};
		const goal: PerTitleGoal = {
			...goalFor(codec, "fixed-range"),
			countPolicy: kind === "unrestricted" ? { kind } : { kind, count: 1 },
			fixedResolutionAndBitrateConfiguration: rule,
			...(locked
				? {
						settingLocks: {
							global: [
								"minBitrate",
								"maxBitrate",
								"minBitrateStepSize",
								"maxBitrateStepSize",
								COUNT,
								`${COUNT}Factor`,
								`${COUNT}CalculationMode`,
							],
						},
					}
				: {}),
		};
		const before = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal).toMatchObject({ status: "candidate", applicable: true });
		expect(proposal.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			rule,
		);
		expect(proposal.countGuarantee).toBe(false);
		expect(goal).toEqual(before);
	});
});
