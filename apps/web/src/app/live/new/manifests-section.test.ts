import { liveChannelPlanSchema, selectLiveManifestMuxings } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveAudioRendition,
	type LiveVideoRendition,
	type LiveWizardState,
} from "./build-live-plan";
import { manifestLegs } from "./manifests-section";

/**
 * C8 gauge parity: the wizard's manifestLegs (what the DvrGauge counts)
 * must enumerate EXACTLY the muxing legs core's selectLiveManifestMuxings
 * picks for the compiled manifest — otherwise the gauge and the blocking
 * C8 validator could disagree. Each row builds the real plan via
 * buildLiveChannelPlan + schema parse and compares per-manifest leg lists
 * (segment lengths, which also pins the leg COUNT).
 */

const S3_CREDENTIAL = "00000000-0000-4000-8000-000000000002";

const video = (
	height: number,
	bitrate: number,
	container?: "FMP4" | "CMAF" | "TS",
): LiveVideoRendition => ({
	codec: "H264",
	height,
	bitrate,
	presetConfiguration: "LIVE_STANDARD",
	...(container ? { container } : {}),
});

const audio = (
	bitrate: number,
	container?: "FMP4" | "CMAF" | "TS",
): LiveAudioRendition => ({
	codec: "AAC",
	bitrate,
	rate: 48_000,
	...(container ? { container } : {}),
});

function parityState(row: {
	videos: LiveVideoRendition[];
	audios: LiveAudioRendition[];
	hls?: Partial<LiveWizardState["manifests"]["hls"]>;
}): LiveWizardState {
	return {
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "Gauge parity channel",
		output: {
			publicRead: false,
			credentialId: S3_CREDENTIAL,
			kind: "S3",
			bucket: "sample-output-bucket",
			basePath: "output/gauge-parity",
			name: "Test S3 Output",
		},
		videos: row.videos,
		audios: row.audios,
		manifests: {
			hls: {
				...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
				enabled: true,
				timeshift: 7200,
				...row.hls,
			},
			dash: {
				...DEFAULT_LIVE_WIZARD_STATE.manifests.dash,
				enabled: true,
				timeshift: 7200,
			},
		},
		start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "gaugeParity" },
	};
}

type Row = {
	name: string;
	videos: LiveVideoRendition[];
	audios: LiveAudioRendition[];
	hls?: Partial<LiveWizardState["manifests"]["hls"]>;
	/** Expected leg count per manifest kind (sanity that rows are non-vacuous). */
	expected: { HLS: number; DASH: number };
};

const rows: Row[] = [
	{
		name: "CMAF legs are DASH-only; HLS counts existing FMP4 legs",
		videos: [video(720, 3_000_000, "CMAF"), video(360, 500_000, "FMP4")],
		audios: [audio(128_000, "CMAF"), audio(64_000, "FMP4")],
		expected: { HLS: 2, DASH: 4 },
	},
	{
		name: "all-FMP4 ladder (default containers)",
		videos: [video(1080, 4_500_000), video(720, 3_000_000)],
		audios: [audio(128_000)],
		expected: { HLS: 3, DASH: 3 },
	},
	{
		name: "all-TS ladder — DASH takes no TS legs",
		videos: [video(720, 3_000_000, "TS")],
		audios: [audio(128_000, "TS")],
		expected: { HLS: 2, DASH: 0 },
	},
	{
		name: "FMP4+TS mixed ladder, no pins — HLS takes both families",
		videos: [video(1080, 4_500_000, "FMP4"), video(720, 3_000_000, "TS")],
		audios: [audio(128_000, "FMP4")],
		expected: { HLS: 3, DASH: 2 },
	},
	{
		name: "HLS video pin TS over the mixed ladder",
		videos: [video(1080, 4_500_000, "FMP4"), video(720, 3_000_000, "TS")],
		audios: [audio(128_000, "FMP4")],
		hls: { videoMuxingKind: "TS" },
		expected: { HLS: 2, DASH: 2 },
	},
	{
		name: "HLS pins FMP4 video + TS audio independently",
		videos: [video(1080, 4_500_000, "FMP4"), video(720, 3_000_000, "TS")],
		audios: [audio(128_000, "TS"), audio(64_000, "FMP4")],
		hls: { videoMuxingKind: "FMP4", audioMuxingKind: "TS" },
		expected: { HLS: 2, DASH: 2 },
	},
];

describe("manifestLegs ↔ selectLiveManifestMuxings parity (C8 gauge counts the validator's legs)", () => {
	for (const row of rows) {
		it(row.name, () => {
			const state = parityState(row);
			const parsed = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
			expect(parsed.liveManifests.map((m) => m.kind)).toEqual(["HLS", "DASH"]);
			for (const manifest of parsed.liveManifests) {
				const wizardLegs = manifestLegs(state, manifest.kind).map(
					(leg) => leg.segmentLengthSec,
				);
				const coreLegs = selectLiveManifestMuxings(parsed, manifest).map(
					(selected) => selected.muxing.segmentLength,
				);
				expect(wizardLegs, `${row.name} → ${manifest.kind}`).toEqual(coreLegs);
				expect(wizardLegs).toHaveLength(row.expected[manifest.kind]);
			}
		});
	}
	it("includes additional VIDEO lists and excludes external VTT and captions in the authoring gauge", () => {
		const state = parityState({
			videos: [video(720, 3000000)],
			audios: [audio(128000)],
		});
		const muxing = buildLiveChannelPlan(state).muxings[0];
		if (!muxing) throw new Error("video missing");
		state.manifests.hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: muxing.key,
					uri: "alternate.m3u8",
				},
				{
					type: "VTT",
					name: "Subtitles",
					groupId: "subtitles",
					uri: "subtitles.m3u8",
					vttUrl: "https://example.test/sub.vtt",
				},
				{
					type: "CLOSED_CAPTIONS",
					name: "Captions",
					groupId: "captions",
					muxingKey: muxing.key,
					instreamId: "CC1",
				},
			],
		};
		expect(
			manifestLegs(state, "HLS").map((leg) => leg.segmentLengthSec),
		).toEqual([state.segmentLength, state.segmentLength, state.segmentLength]);
		expect(manifestLegs(state, "DASH")).toHaveLength(2);
	});
	it("can estimate the authored segment lists before output credentials are configured", () => {
		const state = parityState({
			videos: [video(720, 3000000)],
			audios: [audio(128000)],
		});
		state.output.credentialId = "";
		state.output.bucket = "";
		expect(manifestLegs(state, "HLS")).toHaveLength(2);
	});
});
