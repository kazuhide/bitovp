import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { encodingPlanSchema } from "./schema";
import {
	encodingTemplateExportUnavailableReason,
	planToEncodingTemplateYaml,
} from "./template";
import { loadPlan } from "./test-support";

function audioPlan(codec: "AC3" | "EAC3") {
	const source = loadPlan("audio-only-aac-fmp4-hls-dash");
	return encodingPlanSchema.parse({
		...source,
		renditions: source.renditions.map((rendition) => ({ ...rendition, codec })),
	});
}

describe("native audio encoding templates", () => {
	it.each([
		"AC3",
		"EAC3",
	] as const)("exports %s as HLS audio rather than a video stream", (codec) => {
		const tree = parse(planToEncodingTemplateYaml(audioPlan(codec)));
		expect(tree).toHaveProperty(
			"manifests.hls.hls.media.audio.a128.properties",
			{
				name: "HLS Audio Media",
				groupId: "audio",
				language: "en",
				segmentPath: "audio/128000",
				uri: "audio_128000.m3u8",
				encodingId: "$/encodings/main",
				streamId: "$/encodings/main/streams/a128",
				muxingId: "$/encodings/main/muxings/fmp4/a128",
			},
		);
		expect(tree.manifests.hls.hls.streams).toEqual({});
	});

	it.each([
		"AC3",
		"EAC3",
	] as const)("keeps %s on the DASH audio leg when video uses WebM", (codec) => {
		const source = audioPlan(codec);
		const dash = source.manifests.find((manifest) => manifest.kind === "DASH");
		if (!dash) throw new Error("Missing DASH fixture");
		const plan = encodingPlanSchema.parse({
			...source,
			ingest: [
				...source.ingest,
				{ ...source.ingest[0], key: "video", selectionMode: "VIDEO_RELATIVE" },
			],
			renditions: [
				...source.renditions,
				{
					key: "video",
					codec: "VP9",
					ingestKey: "video",
					height: 720,
					bitrate: 1000000,
				},
			],
			muxings: [
				...source.muxings,
				{
					key: "video",
					kind: "WEBM",
					streamKey: "video",
					segmentLength: 6,
					destination: { outputKey: "origin", path: "video/" },
				},
			],
			manifests: [
				{ ...dash, videoMuxingKind: "WEBM", audioMuxingKind: "FMP4" },
			],
		});
		const tree = parse(planToEncodingTemplateYaml(plan));
		expect(tree).toHaveProperty(
			"manifests.dash.dash.periods.period.adaptationsets.audio.audio_set.representations.fmp4.a128.properties.muxingId",
			"$/encodings/main/muxings/fmp4/a128",
		);
	});

	it.each([
		"AC3",
		"EAC3",
	] as const)("refuses to drop %s OnDemand MP4 encryption in template export", (codec) => {
		const source = audioPlan(codec);
		const plan = encodingPlanSchema.parse({
			...source,
			muxings: [
				{
					key: "a128",
					kind: "MP4",
					streamKey: "a128",
					filename: "audio.mp4",
					manifestType: "DASH_ON_DEMAND",
				},
			],
			drm: [
				{
					key: "protected-audio",
					kind: "CENC",
					muxingKey: "a128",
					credentialId: "00000000-0000-4000-8000-000000000003",
					kid: "a".repeat(32),
					destination: { outputKey: "origin", path: "encrypted/" },
				},
			],
			manifests: source.manifests
				.filter((manifest) => manifest.kind === "DASH")
				.map((manifest) => ({
					...manifest,
					profile: "ON_DEMAND",
					drmKind: "CENC",
				})),
		});
		expect(encodingTemplateExportUnavailableReason(plan)).toBe(
			"DASH_ON_DEMAND_MP4_DRM",
		);
		expect(() => planToEncodingTemplateYaml(plan)).toThrow(/OnDemand MP4 DRM/);
	});
});
