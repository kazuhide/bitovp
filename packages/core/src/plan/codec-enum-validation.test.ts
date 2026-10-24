import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { liveChannelPlanSchema } from "../live/schema";
import { CODEC_ENUM_VALUES, codecEnumSchema } from "./codec-enums";
import { encodingPlanSchema, renditionSchema } from "./schema";
import { type SubmitEncodingJobDeps, submitEncodingJob } from "./submit";

const videoFields = {
	H264: [
		"level",
		"presetConfiguration",
		"trellis",
		"subMe",
		"motionEstimationMethod",
		"adaptiveQuantizationMode",
		"mvPredictionMode",
	],
	H265: [
		"level",
		"presetConfiguration",
		"maxCtuSize",
		"motionSearch",
		"tuIntraDepth",
		"tuInterDepth",
		"adaptiveQuantizationMode",
		"pixelFormat",
	],
} as const;

function rendition(
	codec: "H264" | "H265" | "VP9" | "AAC" | "DD" | "DDPLUS",
): Record<string, unknown> {
	return {
		key: "video",
		ingestKey: "video",
		codec,
		bitrate: 1_500_000,
		...(codec === "VP9"
			? { height: 720 }
			: codec === "H264" || codec === "H265"
				? { height: 720, presetConfiguration: "LIVE_STANDARD" }
				: { rate: 48_000, channelLayout: "CL_STEREO" }),
	};
}

const cases = [
	...(["H264", "H265"] as const).flatMap((codec) => [
		...videoFields[codec].map((field) => ({ codec, field })),
		...["colorSpace", "colorPrimaries", "colorTransfer"].map((field) => ({
			codec,
			field: `colorConfig.${field}`,
		})),
	]),
	...(["AAC", "DD", "DDPLUS"] as const).map((codec) => ({
		codec,
		field: "channelLayout",
	})),
	...(["quality", "aqMode", "arnrType"] as const).map((field) => ({
		codec: "VP9" as const,
		field,
	})),
];

function setField(
	value: Record<string, unknown>,
	path: string,
	fieldValue: string,
) {
	const [key, nested] = path.split(".");
	if (!key) throw new Error("Expected a field path");
	if (nested) value[key] = { [nested]: fieldValue };
	else value[key] = fieldValue;
}

describe("codec enum admission", () => {
	it.each(cases)("rejects invalid $codec field $field before compilation", ({
		codec,
		field,
	}) => {
		for (const invalid of ["INVALID_ENUM", "", "toString", "__proto__"]) {
			const value: Record<string, unknown> = rendition(codec);
			setField(value, field, invalid);
			const result = renditionSchema.safeParse(value);
			expect(result.success, `${codec}.${field}=${invalid}`).toBe(false);
			if (!result.success)
				expect(result.error.issues[0]?.path).toEqual(field.split("."));
		}
	});

	it.each([
		["H264", "level", "4.1", "L4_1"],
		["H265", "level", "4.1", "L4_1"],
		["H265", "maxCtuSize", "64", "S64"],
		["H265", "tuIntraDepth", "4", "D4"],
		["AAC", "channelLayout", "STEREO", "CL_STEREO"],
		["DD", "channelLayout", "5.1", "CL_5_1"],
		["DDPLUS", "channelLayout", "5.1", "CL_5_1"],
	] as const)("accepts %s %s wire value %s and normalizes it to %s", (codec, field, wire, name) => {
		const value = rendition(codec);
		const parsed = renditionSchema.parse({ ...value, [field]: wire });
		expect(parsed).toHaveProperty(field, name);
		expect(renditionSchema.parse(parsed)).toEqual(parsed);
		expect(renditionSchema.parse({ ...value, [field]: name })).toHaveProperty(
			field,
			name,
		);
	});

	it.each(
		Object.keys(CODEC_ENUM_VALUES) as (keyof typeof CODEC_ENUM_VALUES)[],
	)("keeps %s names and wire aliases idempotent", (name) => {
		const values: Readonly<Record<string, string>> = CODEC_ENUM_VALUES[name];
		const schema = codecEnumSchema(name);
		for (const [key, wire] of Object.entries(values)) {
			expect(schema.parse(key)).toBe(key);
			const normalized = schema.parse(wire);
			expect(values[normalized]).toBe(wire);
			expect(schema.parse(normalized)).toBe(normalized);
		}
	});

	it("preserves optional codec fields, nullable levels and preset defaults", () => {
		const { presetConfiguration: _preset, ...h264 } = rendition("H264");
		expect(renditionSchema.parse(h264)).toMatchObject({
			level: null,
			presetConfiguration: "VOD_HIGH_QUALITY",
		});
		expect(
			renditionSchema.parse({
				...h264,
				level: null,
				presetConfiguration: null,
			}),
		).toMatchObject({ level: null, presetConfiguration: null });
		const { presetConfiguration: _h265Preset, ...h265 } = rendition("H265");
		const parsed = renditionSchema.parse(h265);
		expect(parsed).toHaveProperty("level", null);
		expect(parsed).not.toHaveProperty("presetConfiguration");
		for (const codec of ["AAC", "DD", "DDPLUS"] as const) {
			const { channelLayout: _layout, ...audio } = rendition(codec);
			expect(renditionSchema.parse(audio)).toHaveProperty(
				"channelLayout",
				"CL_STEREO",
			);
		}
	});

	it("refuses an imported invalid enum before account lookup, persistence or enqueue", async () => {
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						__dirname,
						"__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
					),
					"utf8",
				),
			),
		);
		plan.bitmovin.accountId = "00000000-0000-4000-8000-000000000001";
		const video = plan.renditions.find((row) => row.codec === "H264");
		if (video?.codec !== "H264") throw new Error("Expected H264 fixture");
		video.level = "INVALID_ENUM";
		const loadAccountDefaults = vi.fn(async () => ({ defaults: {} }));
		const createJob = vi.fn(async () => ({ id: "unused" }));
		const enqueue = vi.fn(async () => {});
		const result = await submitEncodingJob(plan, {
			validationOptions: {},
			loadAccountDefaults,
			createJob,
			enqueue,
			recordEgress: vi.fn(async () => {}),
			markEnqueueFailed: vi.fn(async () => {}),
		} satisfies SubmitEncodingJobDeps);
		expect(result).toMatchObject({ ok: false, code: "PARSE" });
		expect(loadAccountDefaults).not.toHaveBeenCalled();
		expect(createJob).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it.each([
		"H264",
		"H265",
	] as const)("refuses invalid Live %s color settings during schema parsing", (codec) => {
		const raw = JSON.parse(
			readFileSync(
				join(__dirname, "../live/__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		);
		raw.renditions[0] = {
			...rendition(codec),
			key: "v1080",
			colorConfig: { colorTransfer: "INVALID_ENUM" },
		};
		const parsed = liveChannelPlanSchema.safeParse(raw);
		expect(parsed.success).toBe(false);
		if (!parsed.success)
			expect(parsed.error.issues[0]?.path).toEqual([
				"renditions",
				0,
				"colorConfig",
				"colorTransfer",
			]);
	});
});
