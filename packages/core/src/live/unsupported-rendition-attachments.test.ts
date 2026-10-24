import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function fixture() {
	return JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
			"utf8",
		),
	);
}

it.each([
	"H264",
	"H265",
	"AAC",
	"DD",
	"DDPLUS",
] as const)("rejects unsupported %s subtitle burn-in with the exact field path", (codec) => {
	const raw = fixture();
	const index = codec === "H264" || codec === "H265" ? 0 : 3;
	raw.renditions[index].codec = codec;
	raw.renditions[index].burnInSrt = {
		inputKey: "captions",
		inputPath: "captions.srt",
		characterEncoding: "UTF_8",
	};
	const plan = liveChannelPlanSchema.parse(raw);
	expect(validateLiveChannel(plan)).toContainEqual(
		expect.objectContaining({
			code: "LIVE_RENDITION_FEATURE_UNSUPPORTED",
			level: "error",
			path: `renditions[${index}].burnInSrt`,
		}),
	);
});

it.each([
	"H264",
	"H265",
] as const)("rejects silently ignored %s codec encodingMode", (codec) => {
	const raw = fixture();
	raw.renditions[0].codec = codec;
	raw.renditions[0].encodingMode = "TWO_PASS";
	const plan = liveChannelPlanSchema.parse(raw);
	expect(validateLiveChannel(plan)).toContainEqual(
		expect.objectContaining({
			code: "LIVE_RENDITION_FEATURE_UNSUPPORTED",
			level: "error",
			path: "renditions[0].encodingMode",
		}),
	);
});

it("keeps the supported Live start encoding mode", () => {
	const raw = fixture();
	raw.start.liveEncodingMode = "SINGLE_PASS";
	const plan = liveChannelPlanSchema.parse(raw);
	expect(
		validateLiveChannel(plan).filter((issue) => issue.level === "error"),
	).toEqual([]);
	expect(
		compileLiveChannel(plan).find((op) => op.kind === "START_LIVE_ENCODING")
			?.payload,
	).toHaveProperty("liveEncodingMode", "SINGLE_PASS");
});
