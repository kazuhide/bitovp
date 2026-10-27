import { expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function configured(codec: "H264" | "H265" | "VP9" | "AV1", controls: object) {
	const base = loadPlan(
		codec === "VP9" ? "vp9-webm-fixed-dash" : "av1-fmp4-dash-hls",
	);
	return encodingPlanSchema.parse({
		...base,
		renditions: base.renditions.map((r) =>
			r.codec === "AV1" || r.codec === "VP9"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec,
						height: r.height,
						bitrate: r.bitrate,
						...controls,
					}
				: r,
		),
	});
}

it.each([
	[
		"H264",
		{
			autoLevelSetup: "DISABLED",
			deblockAlpha: 0,
			mixedReferences: false,
			partitions: ["P8X8", "I4X4"],
			cea608708SubtitleConfig: {
				passthroughActivated: true,
				passthroughMode: "VIDEO_STREAM",
			},
		},
	],
	[
		"H265",
		{
			bAdapt: "FULL",
			forceFlush: "DISABLED",
			maxMerge: 3,
			gopLookahead: 0,
			earlySkip: false,
			rateDistortionPenalty: "NORMAL",
		},
	],
	[
		"VP9",
		{
			clientBufferSize: 1000,
			clientInitialBufferSize: 500,
			rowMultiThreadingEnabled: true,
			frameParallel: false,
			biasPct: 0,
			tileRows: 1,
		},
	],
	[
		"AV1",
		{
			pixelFormat: "YUV420P10LE",
			displayAspectRatio: { numerator: 16, denominator: 9 },
		},
	],
] as const)("preserves %s advanced controls through the form and compiler", (codec, controls) => {
	const plan = configured(codec, controls);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	for (const op of compilePlan(plan).filter(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	)) {
		expect(op.payload).toMatchObject(controls);
		const curl = curlForStep({
			...op,
			status: "DONE",
			request: { ...op.payload, refs: {} },
		});
		expect(curl.ok).toBe(true);
	}
});

it.each([
	"AAC",
	"AC3",
	"EAC3",
] as const)("preserves %s cutoff frequency in Hz", (codec) => {
	const base = loadPlan("av1-fmp4-dash-hls");
	const plan = encodingPlanSchema.parse({
		...base,
		renditions: base.renditions.map((r) =>
			r.codec === "AAC" ? { ...r, codec, cutoffFrequency: 16000 } : r,
		),
	});
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	const kind = {
		AAC: "CREATE_CODEC_AAC",
		AC3: "CREATE_CODEC_AC3",
		EAC3: "CREATE_CODEC_EAC3",
	}[codec];
	expect(
		compilePlan(plan)
			.filter((op) => op.kind === kind)
			.map((op) => op.payload.cutoffFrequency),
	).not.toEqual([]);
	expect(
		compilePlan(plan)
			.filter((op) => op.kind === kind)
			.every((op) => op.payload.cutoffFrequency === 16000),
	).toBe(true);
	for (const op of compilePlan(plan).filter((op) => op.kind === kind)) {
		const request = Object.freeze({
			...op.payload,
			channelLayout: "CL_STEREO",
			refs: {},
		});
		const curl = curlForStep({ ...op, status: "DONE", request });
		if (!curl.ok) throw new Error("Missing audio cURL");
		expect(curl.command).toContain(
			`/encoding/configurations/audio/${codec.toLowerCase()}`,
		);
		expect(curl.command).toContain('"cutoffFrequency": 16000');
		expect(curl.command).toContain('"channelLayout": "STEREO"');
		expect(request.channelLayout).toBe("CL_STEREO");
	}
	const tree = parse(planToEncodingTemplateYaml(plan));
	expect(
		Object.values(tree.configurations.audio[codec.toLowerCase()]).every(
			(entry: unknown) =>
				(entry as { properties: { cutoffFrequency: number } }).properties
					.cutoffFrequency === 16000,
		),
	).toBe(true);
});

it.each([
	"AAC",
	"AC3",
	"EAC3",
] as const)("preserves an explicit zero %s cutoff and rejects negative/fractional Hz", (codec) => {
	const base = loadPlan("av1-fmp4-dash-hls");
	const configured = (cutoffFrequency: number) => ({
		...base,
		renditions: base.renditions.map((r) =>
			r.codec === "AAC" ? { ...r, codec, cutoffFrequency } : r,
		),
	});
	const plan = encodingPlanSchema.parse(configured(0));
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	expect(
		compilePlan(plan).find((op) => op.kind === `CREATE_CODEC_${codec}`)?.payload
			.cutoffFrequency,
	).toBe(0);
	expect(encodingPlanSchema.safeParse(configured(-1)).success).toBe(false);
	expect(encodingPlanSchema.safeParse(configured(10.5)).success).toBe(false);
});

it.each([
	"AV1",
	"VP9",
] as const)("retains the two parts of %s sample aspect ratio", (codec) => {
	const controls = {
		sampleAspectRatioNumerator: 4,
		sampleAspectRatioDenominator: 3,
	};
	const plan = configured(codec, controls);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	expect(validatePlan(plan).filter((issue) => issue.level === "error")).toEqual(
		[],
	);
	expect(
		compilePlan(plan).find((op) => op.kind === `CREATE_CODEC_${codec}`)
			?.payload,
	).toMatchObject(controls);
});

it.each([
	["H264", { qpMin: 40, qpMax: 20 }, "PLAN_CODEC_QP_RANGE"],
	["H264", { partitions: ["ALL", "I4X4"] }, "PLAN_CODEC_PARTITIONS_CONFLICT"],
	["H264", { nalHrd: "VBR" }, "PLAN_CODEC_HRD_BUFFER"],
	["H265", { gopLookahead: 8, rcLookahead: 4 }, "PLAN_CODEC_GOP_LOOKAHEAD"],
	[
		"H265",
		{ allowedRADLBeforeIDR: 2, bframes: 1, minGop: 48, maxGop: 48 },
		"PLAN_CODEC_RADL_BFRAMES",
	],
	["H265", { allowedRADLBeforeIDR: 1 }, "PLAN_CODEC_RADL_FIXED_GOP"],
	[
		"VP9",
		{ clientBufferSize: 500, clientInitialBufferSize: 1000 },
		"PLAN_CODEC_INITIAL_BUFFER",
	],
] as const)("reports dependency failure %s %j", (codec, controls, code) => {
	expect(validatePlan(configured(codec, controls))).toEqual(
		expect.arrayContaining([expect.objectContaining({ code, level: "error" })]),
	);
});

it.each([
	["H264", { quantizerCurveCompression: 1.01 }],
	["H264", { deblockAlpha: -7 }],
	["H264", { bPyramid: "INVALID" }],
	["H265", { maxMerge: 0 }],
	["H265", { lookaheadSlices: 17 }],
	["H265", { rateDistortionLevelForModeDecision: 5 }],
	["VP9", { crf: 64 }],
	["VP9", { tileRows: -1 }],
	["AV1", { displayAspectRatio: { numerator: 16 } }],
] as const)("rejects invalid %s details %j before compilation", (codec, controls) => {
	expect(() => configured(codec, controls)).toThrow();
});

it.each([
	"AV1",
	"VP9",
] as const)("rejects incompatible %s aspect ratios", (codec) => {
	const plan = configured(codec, {
		sampleAspectRatioNumerator: 4,
		sampleAspectRatioDenominator: 3,
		displayAspectRatio: { numerator: 16, denominator: 9 },
	});
	expect(validatePlan(plan)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "PLAN_CODEC_ASPECT_CONFLICT",
				level: "error",
			}),
		]),
	);
});

it.each([
	"AC3",
	"EAC3",
] as const)("accepts native %s progressive MP4 and rejects TS encryption", (codec) => {
	const base = loadPlan("av1-fmp4-dash-hls");
	const audio = base.renditions.find((r) => r.codec === "AAC");
	const source = base.muxings.find((m) => m.streamKey === audio?.key);
	if (!audio || !source?.destination) throw new Error("Missing audio fixture");
	const rendition = {
		key: audio.key,
		ingestKey: audio.ingestKey,
		codec,
		bitrate: 128000,
		rate: 48000,
		cutoffFrequency: 16000,
	};
	const raw = {
		...base,
		manifests: [],
		renditions: base.renditions.map((r) =>
			r.key === audio.key ? rendition : r,
		),
		muxings: base.muxings.map((m) =>
			m.key === source.key
				? {
						key: m.key,
						streamKey: m.streamKey,
						kind: "MP4",
						filename: "audio.mp4",
						destination: source.destination,
					}
				: m,
		),
	};
	const mp4 = encodingPlanSchema.parse(raw);
	expect(validatePlan(mp4).filter((issue) => issue.level === "error")).toEqual(
		[],
	);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(mp4)))).toEqual(
		mp4,
	);
	const clearTs = encodingPlanSchema.parse({
		...raw,
		muxings: raw.muxings.map((m) =>
			m.key === source.key
				? {
						key: m.key,
						streamKey: m.streamKey,
						kind: "TS",
						segmentLength: 2,
						destination: source.destination,
					}
				: m,
		),
	});
	const errors = validatePlan(clearTs).filter(
		(issue) => issue.level === "error",
	);
	if (codec === "AC3") expect(errors).toEqual([]);
	else
		expect(errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "PLAN_MUXING_CODEC_MISMATCH" }),
			]),
		);
	const encryptedTs = encodingPlanSchema.parse({
		...clearTs,
		drm: [
			{
				key: "encrypted-audio",
				kind: "FAIRPLAY",
				muxingKey: source.key,
				credentialId: "00000000-0000-4000-8000-000000000001",
				iv: "0".repeat(32),
				uri: "skd://audio",
				destination: source.destination,
			},
		],
	});
	expect(validatePlan(encryptedTs)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "PLAN_DRM_AUDIO_TS_UNSUPPORTED",
				level: "error",
			}),
		]),
	);
});
