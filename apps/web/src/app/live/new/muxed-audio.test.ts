import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { planToLiveWizardState } from "./live-plan-to-wizard";

/**
 * The owner's case on the LIVE ladder — .
 *
 * Live reuses `tsMuxingSchema`, so it inherited the one-stream limit and the
 * fix; it also inherited the broadcast MODEL and its defect. Same rewrite: the
 * relation lives on the rung that carries.
 */

const base = (): LiveWizardState => ({
	...DEFAULT_LIVE_WIZARD_STATE,
	name: "muxed live",
	inputKind: "RTMP",
	output: {
		publicRead: false,
		credentialId: "00000000-0000-4000-8000-000000000002",
		kind: "S3",
		bucket: "sample-output-bucket",
		basePath: "output/muxed-live",
		name: "Test S3 Output",
	},
	start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "muxedLive" },
});

const rung = (h: number, b: number, muxedAudioKeys?: string[]) => ({
	codec: "H264" as const,
	height: h,
	bitrate: b,
	presetConfiguration: "LIVE_STANDARD",
	container: "TS" as const,
	...(muxedAudioKeys ? { muxedAudioKeys } : {}),
});
const track = (b: number, own?: false) => ({
	codec: "AAC" as const,
	bitrate: b,
	rate: 48000,
	container: "TS" as const,
	...(own === false ? { ownContainer: false as const } : {}),
});

/** v540←a128, v720←a96, v1080←a128, v360 carries nothing, a64 standalone. */
const ownersCase = (): LiveWizardState =>
	({
		...base(),
		videos: [
			rung(360, 800_000),
			rung(540, 1_500_000, ["a128"]),
			rung(720, 3_000_000, ["a96"]),
			rung(1080, 5_000_000, ["a128"]),
		],
		audios: [track(128_000, false), track(96_000, false), track(64_000)],
	}) as LiveWizardState;

const planOf = (s: LiveWizardState) =>
	liveChannelPlanSchema.parse(buildLiveChannelPlan(s));

describe("live: which rung carries which track", () => {
	it("assigns per rung, not per ladder", () => {
		const plan = planOf(ownersCase());
		expect(
			Object.fromEntries(
				plan.muxings.map((m) => [
					m.streamKey,
					"additionalStreamKeys" in m ? (m.additionalStreamKeys ?? null) : null,
				]),
			),
		).toEqual({
			v360: null,
			v540: ["a128"],
			v720: ["a96"],
			v1080: ["a128"],
			a64: null,
		});
	});

	it("validates clean and re-opens rung by rung", () => {
		const plan = planOf(ownersCase());
		expect(
			validateLiveChannel(plan).filter((i) => i.level === "error"),
		).toEqual([]);
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		);
		expect(rebuilt.muxings).toEqual(plan.muxings);
	});

	it("keeps an uncarried track's container even when it was turned off", () => {
		const s = {
			...base(),
			videos: [rung(720, 3_000_000)],
			audios: [track(128_000, false)],
		} as LiveWizardState;
		const plan = planOf(s);
		expect(plan.muxings.map((m) => m.streamKey)).toContain("a128");
		expect(
			validateLiveChannel(plan).filter((i) => i.level === "error"),
		).toEqual([]);
	});

	it("drops an assignment an fMP4 rung cannot hold, without dropping the track", () => {
		// live has no MP4, so fMP4 cannot carry — the same gap that swallowed a
		// track in the VOD builder's first cut of this rewrite.
		const s = {
			...base(),
			videos: [
				{ ...rung(720, 3_000_000, ["a128"]), container: "FMP4" as const },
			],
			audios: [{ ...track(128_000, false), container: "FMP4" as const }],
		} as LiveWizardState;
		const plan = planOf(s);
		expect(plan.muxings.map((m) => m.streamKey)).toContain("a128");
	});
});
