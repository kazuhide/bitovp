import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveChannelPlanSchema } from "../live/schema";
import { compileExpectedLiveArtefacts } from "./expected-live";

describe("configured Live manifest tracks", () => {
	it("counts additional media while only URI-bearing tracks add HLS children", () => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						import.meta.dirname,
						"../live/__fixtures__/live-rtmp-simple.plan.json",
					),
					"utf8",
				),
			),
		);
		plan.muxings = plan.muxings.filter((muxing) =>
			["v1080", "a128"].includes(muxing.key),
		);
		plan.renditions = plan.renditions.filter((rendition) =>
			["v1080", "a128"].includes(rendition.key),
		);
		const hls = plan.liveManifests.find((manifest) => manifest.kind === "HLS");
		const dash = plan.liveManifests.find(
			(manifest) => manifest.kind === "DASH",
		);
		if (hls?.kind !== "HLS" || dash?.kind !== "DASH")
			throw new Error("missing manifests");
		hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					muxingKey: "v1080",
					groupId: "angles",
					name: "Alternate",
					uri: "angle.m3u8",
				},
				{
					type: "VTT",
					groupId: "subs",
					name: "Japanese",
					language: "ja",
					uri: "subs.m3u8",
					vttUrl: "https://media.example.test/subs.vtt",
				},
				{
					type: "CLOSED_CAPTIONS",
					muxingKey: "v1080",
					groupId: "cc",
					name: "Captions",
					instreamId: "CC1",
				},
			],
		};
		dash.detailed = {
			additionalRepresentations: [
				{
					type: "VTT",
					lang: "ja",
					vttUrl: "https://media.example.test/subs.vtt",
				},
			],
		};
		const expected = compileExpectedLiveArtefacts(plan);
		const actualHls = expected.manifests.find(
			(manifest) => manifest.kind === "HLS",
		);
		const actualDash = expected.manifests.find(
			(manifest) => manifest.kind === "DASH",
		);
		expect(actualHls?.mediaPlaylists).toEqual([
			"video_4500000.m3u8",
			"audio_128000.m3u8",
			"angle.m3u8",
			"subs.m3u8",
		]);
		expect(actualHls).toMatchObject({
			entryCount: 5,
			hlsAdditionalMedia: [
				{ type: "VIDEO", uri: "angle.m3u8" },
				{
					type: "SUBTITLES",
					uri: "subs.m3u8",
					language: "ja",
					vttUrl: "https://media.example.test/subs.vtt",
				},
				{ type: "CLOSED-CAPTIONS", instreamId: "CC1" },
			],
		});
		expect(actualDash).toMatchObject({
			entryCount: 3,
			dashExternalSubtitles: [
				{ language: "ja", url: "https://media.example.test/subs.vtt" },
			],
		});
	});
});
