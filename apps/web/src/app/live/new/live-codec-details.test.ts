import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { expect, it } from "vitest";
import { buildLiveChannelPlan } from "./build-live-plan";
import {
	planToLiveWizardState,
	tryImportLiveChannelIntoWizard,
} from "./live-plan-to-wizard";

function fixture() {
	return JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
}

it.each([
	"H264",
	"H265",
] as const)("retains %s additional controls and AAC cutoff when editing a Live plan", (codec) => {
	const raw = fixture();
	raw.renditions = raw.renditions.map(
		(r: {
			codec: string;
			key: string;
			ingestKey: string;
			height?: number;
			bitrate: number;
			rate?: number;
		}) =>
			r.codec === "H264"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec,
						height: r.height,
						bitrate: r.bitrate,
						...(r.rate !== undefined ? { rate: r.rate } : {}),
						...(codec === "H265" ? { name: `Live H265 ${r.height}p` } : {}),
						presetConfiguration: "LIVE_STANDARD",
						...(codec === "H264"
							? {
									mixedReferences: false,
									deblockAlpha: 0,
									cea608708SubtitleConfig: {
										passthroughActivated: false,
										passthroughMode: "VIDEO_STREAM",
									},
								}
							: { earlySkip: false, gopLookahead: 0, maxMerge: 3 }),
					}
				: r.codec === "AAC"
					? { ...r, cutoffFrequency: 16000 }
					: r,
	);
	const plan = liveChannelPlanSchema.parse(raw);
	expect(
		validateLiveChannel(plan).filter((issue) => issue.level === "error"),
	).toEqual([]);
	expect(
		liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		),
	).toEqual(plan);
	expect(tryImportLiveChannelIntoWizard(plan).ok).toBe(true);
	const ops = compileLiveChannel(plan);
	expect(
		ops.find((op) => op.kind === "CREATE_CODEC_AAC")?.payload.cutoffFrequency,
	).toBe(16000);
	expect(
		ops.find((op) => op.kind === `CREATE_CODEC_${codec}`)?.payload,
	).toMatchObject(
		codec === "H264"
			? { mixedReferences: false, deblockAlpha: 0 }
			: { earlySkip: false, maxMerge: 3 },
	);
});

it.each([
	"AC3",
	"EAC3",
] as const)("keeps native %s configuration imports out of Live until their route is qualified", (codec) => {
	const raw = fixture();
	raw.renditions = raw.renditions.map((r: { codec: string }) =>
		r.codec === "AAC" ? { ...r, codec, cutoffFrequency: 16000 } : r,
	);
	const plan = liveChannelPlanSchema.parse(raw);
	expect(validateLiveChannel(plan)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "LIVE_CODEC_UNSUPPORTED",
				level: "error",
			}),
		]),
	);
});
