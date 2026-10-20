import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function withControls(codec: "H264" | "H265", controls: object) {
	const raw = JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
			"utf8",
		),
	);
	raw.renditions = raw.renditions.map(
		(r: {
			codec: string;
			key: string;
			ingestKey: string;
			height: number;
			bitrate: number;
			rate: number;
		}) =>
			r.codec === "H264"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec,
						height: r.height,
						bitrate: r.bitrate,
						rate: r.rate,
						presetConfiguration: "LIVE_STANDARD",
						...controls,
					}
				: r,
	);
	return liveChannelPlanSchema.parse(raw);
}

it.each([
	"H264",
	"H265",
] as const)("never drops allowed imported %s codec settings", (codec) => {
	const controls = {
		crf: 23.5,
		minBitrate: 0,
		maxBitrate: 6000000,
		bufsize: 12000000,
		minGop: 0,
		maxGop: 48,
		openGop: false,
		displayAspectRatio: { numerator: 16, denominator: 9 },
		width: 640,
		...(codec === "H265"
			? { bframes: 0, refFrames: 0, qpMax: 69, strictCbr: false }
			: {}),
	};
	const plan = withControls(codec, controls);
	expect(validateLiveChannel(plan).filter((i) => i.level === "error")).toEqual(
		[],
	);
	for (const op of compileLiveChannel(plan).filter(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	))
		expect(op.payload).toMatchObject(controls);
});

it("keeps the fixed-bitrate requirement for Live imports with CRF", () => {
	const plan = withControls("H264", { bitrate: null, crf: 23 });
	expect(validateLiveChannel(plan)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ code: "LIVE_RENDITION_BITRATE_REQUIRED" }),
		]),
	);
});

it("validates imported aspect-ratio exclusivity in Live too", () => {
	const plan = withControls("H264", {
		sampleAspectRatioNumerator: 4,
		sampleAspectRatioDenominator: 3,
		displayAspectRatio: { numerator: 16, denominator: 9 },
	});
	expect(validateLiveChannel(plan)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ code: "PLAN_CODEC_ASPECT_CONFLICT" }),
		]),
	);
});
