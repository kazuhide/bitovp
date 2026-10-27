import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIO_CODECS } from "../plan/schema";
import { compileExpectedLiveArtefacts } from "../verify/expected-live";
import { compileLiveChannel, liveHlsEntryUris } from "./compiler";
import {
	liveManifestElementEstimate,
	liveManifestSegmentLists,
} from "./manifest-segment-lists";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function plan() {
	const p = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				new URL("./__fixtures__/live-rtmp-simple.plan.json", import.meta.url),
				"utf8",
			),
		),
	);
	for (const muxing of p.muxings)
		if (muxing.kind !== "MP4") muxing.segmentLength = 1;
	const video = p.renditions.find(
		(rendition) => !AUDIO_CODECS.has(rendition.codec),
	);
	const audio = p.renditions.find((rendition) =>
		AUDIO_CODECS.has(rendition.codec),
	);
	if (!video || !audio) throw new Error("ladder missing");
	p.renditions = [video, audio];
	p.muxings = p.muxings.filter((muxing) =>
		[video.key, audio.key].includes(muxing.streamKey),
	);
	const hls = p.liveManifests.find((manifest) => manifest.kind === "HLS");
	if (hls?.kind !== "HLS") throw new Error("HLS missing");
	p.liveManifests = [hls];
	hls.timeshift = 18000;
	return { p, hls };
}
describe("Live DVR segment sequence accounting", () => {
	it("reserves a complete DVR list for each additional VIDEO URI, including the same muxing", () => {
		const { p, hls } = plan();
		const video = p.muxings[0];
		if (!video) throw new Error("video missing");
		const base = validateLiveChannel(p).find((issue) => issue.code === "C8");
		expect(base).toBeUndefined();
		hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: video.key,
					uri: "alternate.m3u8",
				},
			],
		};
		let issue = validateLiveChannel(p).find((row) => row.code === "C8");
		expect(issue?.level).toBe("warning");
		expect(issue?.message).toContain("54000");
		hls.timeshift = 18001;
		issue = validateLiveChannel(p).find((row) => row.code === "C8");
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("54003");
		expect(
			compileExpectedLiveArtefacts(p).manifests[0]?.elementBudget,
		).toMatchObject({ totalElements: 54003, level: "over" });
		expect(
			liveManifestSegmentLists(p, hls).map((list) => list.identity),
		).toContain("playlist:alternate.m3u8");
		expect(
			compileLiveChannel(p).filter(
				(op) => op.kind === "CREATE_HLS_VIDEO_MEDIA",
			),
		).toHaveLength(1);
	});
	it("does not allocate DVR segment lists to external VTT or in-band closed captions", () => {
		const { p, hls } = plan();
		const video = p.muxings[0];
		if (!video) throw new Error("video missing");
		hls.timeshift = 27000;
		hls.detailed = {
			additionalMedia: [
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
					muxingKey: video.key,
					instreamId: "CC1",
				},
			],
		};
		const issue = validateLiveChannel(p).find((row) => row.code === "C8");
		expect(issue?.level).toBe("warning");
		expect(issue?.message).toContain("54000");
		expect(issue?.message).not.toContain("108000");
	});
	it("uses each additional video's own muxing length rather than the selected ladder's minimum", () => {
		const { p, hls } = plan();
		const video = p.muxings[0];
		if (video?.kind !== "FMP4") throw new Error("video missing");
		p.muxings.push({
			key: "alternate-ts",
			kind: "TS",
			streamKey: video.streamKey,
			additionalStreamKeys: [],
			segmentNaming: "segment_%number%.ts",
			segmentLength: 2,
			destination: { outputKey: "origin", path: "live/alternate/" },
		});
		hls.videoMuxingKind = "FMP4";
		hls.timeshift = 22000;
		hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: "alternate-ts",
					uri: "alternate.m3u8",
				},
			],
		};
		const issue = validateLiveChannel(p).find((row) => row.code === "C8");
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("55000");
		expect(
			compileExpectedLiveArtefacts(p).manifests[0]?.elementBudget,
		).toMatchObject({ totalElements: 55000, level: "over" });
	});
	it("keeps external DASH VTT out of the segmented DVR estimate", () => {
		const { p } = plan();
		p.liveManifests = [
			{
				key: "dash",
				kind: "DASH",
				manifestName: "stream.mpd",
				name: "DASH",
				destination: { outputKey: "origin", path: "live/" },
				audioLanguage: "en",
				representationType: "TEMPLATE",
				timeshift: 27000,
				detailed: {
					additionalRepresentations: [
						{ type: "VTT", lang: "en", vttUrl: "https://example.test/sub.vtt" },
					],
				},
			},
		];
		const issue = validateLiveChannel(p).find((row) => row.code === "C8");
		expect(issue?.level).toBe("warning");
		expect(issue?.message).toContain("54000");
	});
	it("does not multiply one logical playlist by its delivery mirrors", () => {
		const { p, hls } = plan();
		const output = p.outputs[0];
		if (output?.kind !== "S3") throw new Error("output missing");
		p.outputs.push({ ...output, key: "mirror", bucket: "mirror-bucket" });
		p.deliveryMirrors = [{ outputKey: "mirror" }];
		expect(liveManifestSegmentLists(p, hls)).toHaveLength(2);
		expect(liveManifestElementEstimate(p, hls)?.totalElements).toBe(36000);
	});
	it("identifies one child URI once while duplicate-writer validation blocks the plan", () => {
		const { p, hls } = plan();
		const video = p.muxings[0];
		if (!video) throw new Error("video missing");
		const uri = liveHlsEntryUris(p).get(video.streamKey);
		if (!uri) throw new Error("URI missing");
		hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Duplicate",
					groupId: "alternate",
					muxingKey: video.key,
					uri,
				},
			],
		};
		expect(liveManifestSegmentLists(p, hls)).toHaveLength(2);
		expect(
			validateLiveChannel(p).some(
				(issue) =>
					issue.level === "error" &&
					/collision|Duplicate child/.test(issue.code + issue.message),
			),
		).toBe(true);
	});
	it("does not lower the full-window reservation when authored segment ranges are bounded", () => {
		const { p, hls } = plan();
		const video = p.muxings[0];
		if (!video) throw new Error("video missing");
		hls.timeshift = 18001;
		hls.detailed = {
			streams: { startSegmentNumber: 0, endSegmentNumber: 2 },
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: video.key,
					uri: "alternate.m3u8",
					startSegmentNumber: 0,
					endSegmentNumber: 2,
				},
			],
		};
		expect(liveManifestElementEstimate(p, hls)).toMatchObject({
			totalElements: 54003,
			level: "over",
		});
	});
});
