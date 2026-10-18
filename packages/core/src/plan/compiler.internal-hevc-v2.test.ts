import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { CODEC_CONFIG_API_PATH } from "./per-title-results";
import { encodingPlanSchema } from "./schema";
import { initStepLog } from "./steplog";
import { loadPlan } from "./test-support";

describe("internal HEVCv2 compilation", () => {
	it.each([
		"STABLE",
		"BETA",
		"LATEST",
		"2.325.0",
	])("preserves encoder %s with BCF and codec settings", (encoderVersion) => {
		const base = loadPlan("fixed-bitrate-hls-on-aws");
		const plan = encodingPlanSchema.parse({
			...base,
			bitmovin: { ...base.bitmovin, encoderVersion },
			internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } },
			renditions: base.renditions.map((r) =>
				r.codec === "H264"
					? {
							key: r.key,
							ingestKey: r.ingestKey,
							codec: "H265",
							height: 720,
							bitrate: 1000000,
							rate: 30,
							pixelFormat: "YUV420P",
							levelHighTier: false,
							dynamicRangeFormat: "SDR",
						}
					: r,
			),
		});
		const ops = compilePlan(plan);
		const codec = ops.find((o) => o.kind === "CREATE_CODEC_H265");
		expect(codec?.payload).toMatchObject({
			internalHevcV2: true,
			height: 720,
			bitrate: 1000000,
			rate: 30,
			pixelFormat: "YUV420P",
			levelHighTier: false,
			dynamicRangeFormat: "SDR",
			encodingMode: "SMART_PASS",
			presetConfiguration: "VOD_HIGH_QUALITY",
		});
		expect(codec?.payload).not.toHaveProperty("level");
		expect(
			ops.find((o) => o.kind === "CREATE_ENCODING")?.payload.encoderVersion,
		).toBe(encoderVersion);
		expect(
			ops.find((o) => o.kind === "START_ENCODING")?.payload.encodingMode,
		).toBeUndefined();
		const entry = initStepLog(ops).find((o) => o.kind === "CREATE_CODEC_H265");
		if (!entry) throw new Error("missing codec");
		entry.request = { ...entry.payload, refs: {} };
		const result = curlForStep(entry);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("missing curl");
		expect(result.command).toContain("/video/h265v2");
		expect(result.command).toContain(
			"X-BITMOVIN-BCF-VERSION: v2.325.0-461-g85df7fd6c6",
		);
		expect(result.command).not.toContain('"internalHevcV2"');
		expect(result.command).not.toContain('"bcfVersion"');
		expect(CODEC_CONFIG_API_PATH.H265V2).toEqual(["video", "h265v2"]);
	});
});

it.each([
	"H264",
	"H265",
	"VP9",
	"AV1",
] as const)("compiles %s mode on codec only, never duplicates at start", (codec) => {
	const base = loadPlan("fixed-bitrate-hls-on-aws");
	const plan = encodingPlanSchema.parse({
		...base,
		renditions: base.renditions.map((r) =>
			r.codec === "H264"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec,
						height: 720,
						bitrate: 1000000,
						encodingMode: "TWO_PASS",
					}
				: r,
		),
		generation: { ...base.generation, encodingMode: "THREE_PASS" },
	});
	const ops = compilePlan(plan);
	expect(
		ops.find((o) => o.kind === `CREATE_CODEC_${codec}`)?.payload.encodingMode,
	).toBe("TWO_PASS");
	expect(
		ops.find((o) => o.kind === "START_ENCODING")?.payload,
	).not.toHaveProperty("encodingMode");
});
