import { expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import {
	checkInternalHevcV2Plan,
	INTERNAL_HEVC_V2_BCF_VERSION,
} from "../plan/internal-hevc-v2";
import { encodingPlanSchema } from "../plan/schema";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	hlsDefaultVersion,
	type WizardState,
} from "./build-plan";
import { tryImportPresetIntoWizard } from "./plan-to-wizard";

const state: WizardState = {
	...DEFAULT_WIZARD_STATE,
	name: "internal",
	accountId: "0f8edfe4-fc30-4a9a-89e3-a3e89d5245df",
	videos: [{ codec: "H265", height: 720, bitrate: 1_000_000 }],
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "1f8edfe4-fc30-4a9a-89e3-a3e89d5245df",
			bucket: "in",
			path: "a.mp4",
		},
	],
	output: {
		...DEFAULT_WIZARD_STATE.output,
		credentialId: "1f8edfe4-fc30-4a9a-89e3-a3e89d5245df",
		bucket: "out",
		basePath: "test",
	},
};
it("keeps width and display aspect ratio through eligible HEVCv2 plan import", () => {
	const geometry = {
		width: 1280,
		displayAspectRatio: { numerator: 16, denominator: 9 },
	};
	const plan = encodingPlanSchema.parse(
		buildPlan({
			...state,
			videos: [
				{
					codec: "H265V2",
					width: geometry.width,
					height: 720,
					bitrate: 1000000,
					h265: { displayAspectRatio: geometry.displayAspectRatio },
				},
			],
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		}),
	);
	expect(checkInternalHevcV2Plan(plan)).toEqual([]);
	expect(
		compilePlan(plan).find((op) => op.kind === "CREATE_CODEC_H265")?.payload,
	).toMatchObject(geometry);
	const imported = tryImportPresetIntoWizard(plan);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("HEVCv2 geometry must be editable");
	expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(plan);
});
it.each([
	"STABLE",
	"BETA",
	"LATEST",
	"2.325.0",
])("preserves encoder %s independently of BCF through import", (encoderVersion) => {
	const plan = encodingPlanSchema.parse(
		buildPlan({
			...state,
			encoderVersion,
			videos: [{ codec: "H265V2", height: 720, bitrate: 1_000_000 }],
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		}),
	);
	expect(plan.bitmovin.encoderVersion).toBe(encoderVersion);
	expect(plan.generation.encodingMode).toBeUndefined();
	expect(plan.renditions[0]).toHaveProperty("encodingMode", "SMART_PASS");
	expect(plan.renditions[0]).toMatchObject({
		codec: "H265",
		presetConfiguration: "VOD_HIGH_QUALITY",
	});
	expect(checkInternalHevcV2Plan(plan)).toEqual([]);
	const imported = tryImportPresetIntoWizard(plan);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("must preserve supported internal profile");
	expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(plan);
});
it("keeps normal H265 opt-out and preserves unsupported options for explicit rejection", () => {
	const normal = buildPlan(state);
	expect(normal.internal).toBeUndefined();
	expect(normal.bitmovin.encoderVersion).toBe("2.291.0");
	expect(normal.generation?.encodingMode).toBeUndefined();
	const plan = encodingPlanSchema.parse(
		buildPlan({
			...state,
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
			videos: [
				{
					codec: "H265V2",
					height: 720,
					bitrate: 1_000_000,
					h265: { rcLookahead: 30 },
				},
			],
		}),
	);
	expect(plan.renditions[0]).toHaveProperty("rcLookahead", 30);
	expect(checkInternalHevcV2Plan(plan)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: "renditions.0.rcLookahead",
				level: "error",
			}),
		]),
	);
});

it("refuses mixed H265 and H265V2 before either codec can be reinterpreted", () => {
	expect(() =>
		buildPlan({
			...state,
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
			videos: [
				{ codec: "H265V2", height: 720, bitrate: 1_000_000 },
				{ codec: "H265", height: 360, bitrate: 300_000 },
			],
		}),
	).toThrow(/HEVCv2/);
});
it("maps a selected HEVCv2 rendition to the persisted provider profile", () => {
	const plan = encodingPlanSchema.parse(
		buildPlan({
			...state,
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
			videos: [{ codec: "H265V2", height: 720, bitrate: 1_000_000 }],
		}),
	);
	expect(plan.renditions[0]?.codec).toBe("H265");
	expect(plan.internal?.hevcV2.bcfVersion).toBe(INTERNAL_HEVC_V2_BCF_VERSION);
	const mapped = tryImportPresetIntoWizard(plan);
	expect(mapped.ok && mapped.state.videos[0]?.codec).toBe("H265V2");
});

it("refuses HEVCv2 without BCF and BCF with ordinary H265", () => {
	expect(() =>
		buildPlan({
			...state,
			videos: [{ codec: "H265V2", height: 720, bitrate: 1_000_000 }],
		}),
	).toThrow(/BCF override/);
	expect(() =>
		buildPlan({
			...state,
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		}),
	).toThrow(/HEVCv2/);
});

it("keeps the HEVCv2 fMP4 ladder HLS version and multi-rung key round-trip", () => {
	const selected: WizardState = {
		...state,
		internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		videos: [
			{ codec: "H265V2", height: 720, bitrate: 1_000_000 },
			{ codec: "H265V2", height: 720, bitrate: 2_000_000 },
		],
	};
	expect(hlsDefaultVersion(selected, undefined)).toBe("HLS_V6");
	const plan = encodingPlanSchema.parse(buildPlan(selected));
	const imported = tryImportPresetIntoWizard(plan);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("multi-rung copy must preserve keys");
	expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(plan);
});

it.each([
	"H264",
	"H265",
	"VP9",
	"AV1",
] as const)("round-trips ladder mode for %s and clears the global mode", (codec) => {
	const plan = encodingPlanSchema.parse(
		buildPlan({
			...state,
			videos: [
				{ codec, height: 720, bitrate: 1000000, encodingMode: "TWO_PASS" },
			],
			startOptions: { encodingMode: "THREE_PASS" },
		}),
	);
	expect(plan.renditions[0]).toHaveProperty("encodingMode", "TWO_PASS");
	expect(plan.generation.encodingMode).toBeUndefined();
	const imported = tryImportPresetIntoWizard(plan);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("must import codec mode");
	expect(imported.state.videos[0]?.encodingMode).toBe("TWO_PASS");
	expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(plan);
});

it("repairs the previous HEVCv2 duplicate START mode when copying a failed job", () => {
	const current = encodingPlanSchema.parse(
		buildPlan({
			...state,
			videos: [{ codec: "H265V2", height: 720, bitrate: 1000000 }],
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		}),
	);
	const old = {
		...current,
		generation: { ...current.generation, encodingMode: "SMART_PASS" },
		renditions: current.renditions.map((r) => {
			const { encodingMode, ...rest } = r as unknown as Record<string, unknown>;
			return rest;
		}),
	};
	const imported = tryImportPresetIntoWizard(old);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("legacy job must be editable");
	expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(current);
});

it("round-trips native HEVCv2 Per-Title and fixed stream bounds without CRF conversion", () => {
	const input: WizardState = {
		...state,
		timing: "POST_ENCODING",
		encoderVersion: "LATEST",
		manifests: { hls: true, dash: true },
		internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		videos: [
			{
				codec: "H265V2",
				height: null,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE" },
			},
			{
				codec: "H265V2",
				height: 1080,
				bitrate: null,
				extras: {
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: { minBitrate: 5000000, maxBitrate: 5000000 },
				},
			},
		],
		startOptions: {
			perTitle: {
				h265: {
					minBitrate: 100000,
					maxBitrate: 20000000,
					minBitrateStepSize: 1.25,
					targetQualityQp: 20,
					autoRepresentations: true,
				},
			},
		},
	};
	const plan = encodingPlanSchema.parse(buildPlan(input));
	expect(plan.perTitle).toEqual({
		h265V2Configuration: {
			minBitrate: 100000,
			maxBitrate: 20000000,
			minBitrateStepSize: 1.25,
			targetQualityQp: 20,
			autoRepresentations: {},
		},
	});
	expect(checkInternalHevcV2Plan(plan)).toEqual([]);
	const operations = compilePlan(plan);
	const captureIndex = operations.findIndex(
		(operation) => operation.kind === "CAPTURE_PER_TITLE_RESULTS",
	);
	const capture = operations[captureIndex];
	expect(capture?.payload.templates).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ codec: "H265V2", mode: "PER_TITLE_TEMPLATE" }),
			expect.objectContaining({
				codec: "H265V2",
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: {
					fixedResolutionAndBitrateSettings: {
						minBitrate: 5000000,
						maxBitrate: 5000000,
					},
				},
			}),
		]),
	);
	expect(
		operations.findIndex((operation) => operation.kind === "AWAIT_ENCODING"),
	).toBeLessThan(captureIndex);
	expect(
		operations.find((operation) => operation.kind === "START_ENCODING")?.payload
			.perTitle,
	).toEqual(plan.perTitle);
	const expansions = operations.filter(
		(operation) =>
			operation.kind === "CREATE_HLS_PER_TITLE_VARIANTS" ||
			operation.kind === "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
	);
	expect(expansions).toHaveLength(2);
	for (const expansion of expansions) {
		expect(operations.indexOf(expansion)).toBeGreaterThan(captureIndex);
		expect(expansion.payload.streamModeFilter).toBe("PER_TITLE_RESULT");
		expect(expansion.refs.encodingId).toBe(capture?.refs.encodingId);
	}
	const mapped = tryImportPresetIntoWizard(plan);
	expect(mapped.ok).toBe(true);
	if (!mapped.ok) throw new Error("must import native HEVCv2 Per-Title");
	expect(encodingPlanSchema.parse(buildPlan(mapped.state))).toEqual(plan);
});

it.each([
	"AUTO",
	"OFF",
	"ON",
] as const)("round-trips explicit native MCTF %s and perceptual settings", (motionCompensatedTemporalFiltering) => {
	const input: WizardState = {
		...state,
		internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		videos: [
			{
				codec: "H265V2",
				height: 720,
				bitrate: 1_000_000,
				h265: {
					motionCompensatedTemporalFiltering,
					rateControlModeConfig: {
						type: "PERCEPTUAL_QUALITY_MODE",
						perceptualEncodingMode: "OFF",
						perceptualStrength: 0,
						perceptualPenaltyStrength: 1,
						perceptualPenaltyKnee: 0.5,
						perceptualTemporalStrength: 0.2,
						pixelPerDegree: 60,
					},
				},
			},
		],
	};
	const plan = encodingPlanSchema.parse(buildPlan(input));
	expect(plan.renditions[0]).toMatchObject(input.videos[0]?.h265 ?? {});
	expect(checkInternalHevcV2Plan(plan)).toEqual([]);
	const imported = tryImportPresetIntoWizard(plan);
	if (!imported.ok)
		throw new Error("Native HEVCv2 quality controls must be editable");
	expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(plan);
	const switched = {
		...imported.state,
		internal: undefined,
		videos: imported.state.videos.map((video) => ({
			...video,
			codec: "H265" as const,
			encodingMode: undefined,
		})),
	};
	const legacy = encodingPlanSchema.parse(buildPlan(switched));
	expect(legacy.renditions[0]).toHaveProperty(
		"motionCompensatedTemporalFiltering",
		motionCompensatedTemporalFiltering,
	);
	// Native intent remains present so validation must reject, rather than silently discard it.
	expect(checkInternalHevcV2Plan(legacy).length).toBeGreaterThan(0);
});

it("keeps native codec provider defaults absent rather than selecting AUTO or perceptual mode", () => {
	const plan = encodingPlanSchema.parse(
		buildPlan({
			...state,
			videos: [{ codec: "H265V2", height: 720, bitrate: 1_000_000 }],
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		}),
	);
	expect(plan.renditions[0]).not.toHaveProperty(
		"motionCompensatedTemporalFiltering",
	);
	expect(plan.renditions[0]).not.toHaveProperty("rateControlModeConfig");
});

it.each([
	"H264",
	"VP9",
	"AV1",
] as const)("does not silently discard native quality controls when changing to %s", (codec) => {
	expect(() =>
		buildPlan({
			...state,
			videos: [
				{
					codec,
					height: 720,
					bitrate: 1000000,
					h265: { motionCompensatedTemporalFiltering: "OFF" },
				},
			],
		}),
	).toThrow(/HEVCv2/);
	expect(() =>
		buildPlan({
			...state,
			videos: [
				{
					codec,
					height: 720,
					bitrate: 1000000,
					h265: {
						rateControlModeConfig: {
							type: "PERCEPTUAL_QUALITY_MODE",
							perceptualEncodingMode: "OFF",
						},
					},
				},
			],
		}),
	).toThrow(/HEVCv2/);
});
