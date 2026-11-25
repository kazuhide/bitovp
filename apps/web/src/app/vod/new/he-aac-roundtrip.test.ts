import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	compilePlan,
	encodingPlanSchema,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { expect, it } from "vitest";
import { buildLiveChannelPlan } from "../../live/new/build-live-plan";
import { tryImportLiveChannelIntoWizard } from "../../live/new/live-plan-to-wizard";
import { buildPlan } from "./build-plan";
import { audioProfileTransition, readAudioRate } from "./he-aac-fields";
import { tryImportPresetIntoWizard } from "./plan-to-wizard";

function fixture(name: string) {
	const source = JSON.parse(
		readFileSync(
			join(__dirname, "../../../../../../packages/core/src", name),
			"utf8",
		),
	);
	for (const storage of [...(source.inputs ?? []), ...source.outputs]) {
		if (storage.credentialId)
			storage.credentialId = "fb60ae64-e143-48d4-a432-a37546199fd9";
	}
	return source;
}
const profiles = [
	{ codec: "HE_AAC_V1", bitrate: 64000 },
	{
		codec: "HE_AAC_V1",
		bitrate: 128000,
		rate: 48000,
		channelLayout: "NONE",
		signaling: "EXPLICIT_SBR",
	},
	{
		codec: "HE_AAC_V2",
		bitrate: 64000,
		name: "Stereo commentary",
		channelLayout: "CL_STEREO",
		signaling: "EXPLICIT_PS",
	},
] as const;
it.each(
	profiles,
)("restores VOD preset and Live duplicate fields exactly for $codec", (profile) => {
	const vod = fixture(
		"plan/__fixtures__/audio-only-aac-fmp4-hls-dash.plan.json",
	);
	const live = fixture("live/__fixtures__/live-rtmp-simple.plan.json");
	for (const raw of [vod, live]) {
		raw.renditions = raw.renditions.map(
			(r: { codec: string; key: string; ingestKey: string }) =>
				r.codec === "AAC"
					? { key: r.key, ingestKey: r.ingestKey, ...profile }
					: r,
		);
	}
	const savedVod = encodingPlanSchema.parse(vod);
	const v = tryImportPresetIntoWizard(savedVod);
	expect(v.ok).toBe(true);
	if (!v.ok) throw Error(v.reasonKey);
	expect(encodingPlanSchema.parse(buildPlan(v.state))).toEqual(savedVod);
	const savedLive = liveChannelPlanSchema.parse(live);
	const l = tryImportLiveChannelIntoWizard(savedLive);
	expect(l.ok).toBe(true);
	if (!l.ok) throw Error(l.reasonKey);
	expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(l.state))).toEqual(
		savedLive,
	);
});
it("applies a bitrate ceiling on an explicit profile change and preserves omission separately from zero", () => {
	expect(
		audioProfileTransition("HE_AAC_V2", { bitrate: 128000 }),
	).toMatchObject({ bitrate: 64000 });
	expect(
		audioProfileTransition("HE_AAC_V1", {
			bitrate: 32000,
			signaling: "EXPLICIT_PS",
		}),
	).toMatchObject({ bitrate: 32000, signaling: undefined });
	expect(readAudioRate("HE_AAC_V1", "")).toBeUndefined();
	expect(readAudioRate("HE_AAC_V2", "0")).toBe(0);
	expect(readAudioRate("HE_AAC_V2", "48000.5")).toBe(48000.5);
});

it("keeps two equal-bitrate HE profiles independent through VOD and Live packaging", () => {
	const vod = tryImportPresetIntoWizard(
		encodingPlanSchema.parse(
			fixture("plan/__fixtures__/audio-only-aac-fmp4-hls-dash.plan.json"),
		),
	);
	const live = tryImportLiveChannelIntoWizard(
		liveChannelPlanSchema.parse(
			fixture("live/__fixtures__/live-rtmp-simple.plan.json"),
		),
	);
	if (!vod.ok || !live.ok) throw Error("The stock presets must reopen");
	const audios = [
		{ codec: "HE_AAC_V1", bitrate: 64000, rate: 48000 },
		{ codec: "HE_AAC_V2", bitrate: 64000, signaling: "EXPLICIT_PS" },
	] satisfies typeof vod.state.audios;
	const vodPlan = encodingPlanSchema.parse(buildPlan({ ...vod.state, audios }));
	const livePlan = liveChannelPlanSchema.parse(
		buildLiveChannelPlan({ ...live.state, audios }),
	);
	for (const plan of [vodPlan, livePlan]) {
		const audio = plan.renditions.filter((r) => r.codec.startsWith("HE_AAC_"));
		expect(audio.map((r) => [r.key, r.codec])).toEqual([
			[expect.any(String), "HE_AAC_V1"],
			[expect.any(String), "HE_AAC_V2"],
		]);
		expect(new Set(audio.map((r) => r.key)).size).toBe(2);
		const muxings = plan.muxings.filter(
			(m) => "streamKey" in m && audio.some((r) => r.key === m.streamKey),
		);
		expect(muxings).toHaveLength(2);
		const paths = muxings.map((m) => m.destination?.path);
		expect(paths).toEqual([expect.any(String), expect.any(String)]);
		expect(new Set(paths).size).toBe(2);
	}
	for (const ops of [compilePlan(vodPlan), compileLiveChannel(livePlan)]) {
		const media = ops.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA");
		expect(media).toHaveLength(2);
		expect(new Set(media.map((op) => op.payload.uri)).size).toBe(2);
		const reps = ops.filter(
			(op) =>
				op.kind === "CREATE_DASH_REPRESENTATION_FMP4" &&
				media.some((m) => m.refs.muxingId === op.refs.muxingId),
		);
		expect(new Set(reps.map((op) => op.refs.muxingId)).size).toBe(2);
	}
});
