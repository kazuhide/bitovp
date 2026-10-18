import { describe, expect, it } from "vitest";
import fixture from "../plan/__fixtures__/ai-scene-analysis-passthrough-test.plan.json";
import { encodingPlanSchema } from "../plan/schema";
import { manifestPlaybackLinks } from "../playback/manifest-links";
import { libraryPlaybackLinkSchema } from "./contracts";
import { libraryFileOutputs, libraryPlaybackLinks } from "./playback";

const credential = {
	id: "00000000-0000-4000-8000-000000000002",
	provider: "AWS_S3" as const,
	config: { region: "ap-northeast-1" },
};
const credentials = [credential];
const plan = () => encodingPlanSchema.parse(fixture);
function destination(input: ReturnType<typeof plan>) {
	const value = input.muxings[0]?.destination;
	if (!value) throw new Error("Fixture destination missing");
	return value;
}

describe("libraryPlaybackLinks", () => {
	it("retains exact private MP4 coordinates without credentials or config", () => {
		const input = plan();
		destination(input).acl = "PRIVATE";
		expect(libraryFileOutputs(input)).toEqual([
			{
				key: "mp4:v180",
				kind: "MP4",
				credentialId: credential.id,
				bucket: "sample-output-bucket",
				path: `${destination(input).path}/180p.mp4`,
			},
		]);
	});
	it("omits nonstreamable and encrypted file outputs", () => {
		const input = plan();
		input.outputs = [
			{
				key: "origin",
				kind: "SFTP",
				credentialId: credential.id,
				name: "SFTP",
			},
		];
		expect(libraryFileOutputs(input)).toEqual([]);
		const encrypted = plan();
		encrypted.drm = [{ muxingKey: "v180" }] as typeof encrypted.drm;
		expect(libraryFileOutputs(encrypted)).toEqual([]);
	});
	it("adds a playable MP4 to a manifest-free snapshot", () => {
		const links = libraryPlaybackLinks(plan(), credentials);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			key: "mp4:v180",
			kind: "MP4",
			label: "Video MP4 Muxing",
			url: "https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/h264-mp4-ai-scene-analysis-passthrough-aws-test/video/180p.mp4",
		});
		expect(libraryPlaybackLinkSchema.safeParse(links[0]).success).toBe(true);
	});
	it("retains manifests before MP4 alternatives", () => {
		const input = encodingPlanSchema.parse({
			...fixture,
			manifests: [
				{
					key: "hls",
					kind: "HLS",
					name: "HLS",
					manifestName: "master.m3u8",
					destination: destination(plan()),
				},
			],
		});
		expect(libraryPlaybackLinks(input, credentials).slice(0, 1)).toEqual(
			manifestPlaybackLinks(input, credentials),
		);
	});
	it("keeps private and deleted-credential outputs unavailable", () => {
		const input = plan();
		destination(input).acl = "PRIVATE";
		expect(libraryPlaybackLinks(input, credentials)[0]).toMatchObject({
			url: null,
			reason: { code: "NOT_PUBLIC" },
		});
		expect(libraryPlaybackLinks(input, [])[0]).toMatchObject({
			url: null,
			reason: { code: "NO_CREDENTIAL" },
		});
	});
	it("uses a declared CDN base for private output", () => {
		const input = plan();
		destination(input).acl = "PRIVATE";
		expect(
			libraryPlaybackLinks(input, [
				{
					...credential,
					config: {
						publicBaseUrls: {
							"sample-output-bucket": "https://cdn.example.test",
						},
					},
				},
			])[0]?.url,
		).toBe(
			"https://cdn.example.test/output/h264-mp4-ai-scene-analysis-passthrough-aws-test/video/180p.mp4",
		);
	});
	it("omits encrypted, unresolved, and audio-only muxings", () => {
		const encrypted = plan();
		encrypted.drm = [{ muxingKey: "v180" }] as typeof encrypted.drm;
		expect(libraryPlaybackLinks(encrypted, credentials)).toEqual([]);
		const unresolved = plan();
		destination(unresolved).path += "/{uuid}";
		expect(libraryPlaybackLinks(unresolved, credentials)).toEqual([]);
		const audio = plan();
		audio.renditions = [
			{
				key: "v180",
				codec: "AAC",
				bitrate: 128000,
				rate: 48000,
				channelLayout: "CL_STEREO",
				ingestKey: "video",
			},
		];
		expect(libraryPlaybackLinks(audio, credentials)).toEqual([]);
	});
	it("does not expose per-title template streams even with a literal path", () => {
		const input = plan();
		const video = input.renditions[0];
		if (!video || !("mode" in video)) throw new Error("Fixture video missing");
		video.mode = "PER_TITLE_TEMPLATE";
		expect(libraryPlaybackLinks(input, credentials)).toEqual([]);
	});
});
