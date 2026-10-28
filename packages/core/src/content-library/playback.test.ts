import { describe, expect, it } from "vitest";
import fixture from "../plan/__fixtures__/ai-scene-analysis-passthrough-test.plan.json";
import { compilePlan, joinFilePath } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import { manifestPlaybackLinks } from "../playback/manifest-links";
import { enumerateQcTargets } from "../vmaf/targets";
import {
	libraryFileOutputSchema,
	libraryPlaybackLinkSchema,
} from "./contracts";
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

function qcOnlyPlan() {
	return encodingPlanSchema.parse({
		...fixture,
		aiSceneAnalysis: undefined,
		qc: { vmaf: true, only: true },
		muxings: [
			{
				key: "segmented",
				kind: "FMP4",
				streamKey: "v180",
				segmentLength: 2,
				initSegmentName: "init.mp4",
				destination: destination(plan()),
			},
		],
	});
}

describe("QC-only Library MP4 output", () => {
	it("retains the exact compiler-emitted QC MP4 with its own stable key and private coordinates", () => {
		const input = qcOnlyPlan();
		destination(input).acl = "PRIVATE";
		const op = compilePlan(input).find((op) => op.step === "qc-muxing:v180");
		expect(op?.kind).toBe("CREATE_MUXING_MP4");
		const path = `${String(op?.payload.outputPath)}${String(op?.payload.filename)}`;
		expect(libraryFileOutputs(input)).toEqual([
			{
				key: "qc-mp4:v180",
				kind: "MP4",
				credentialId: credential.id,
				bucket: "sample-output-bucket",
				path,
			},
		]);
		expect(libraryPlaybackLinks(input, credentials)).toEqual([
			expect.objectContaining({
				key: "qc-mp4:v180",
				kind: "MP4",
				path,
				url: null,
				reason: { code: "NOT_PUBLIC" },
			}),
		]);
	});
	it("retains a concat QC output without inventing a VMAF reference", () => {
		const input = qcOnlyPlan();
		input.trimmingStreams = [
			{
				key: "piece",
				kind: "TIME_BASED",
				sourceKey: "video",
				offset: 2,
				duration: 2,
			},
		];
		input.concatenationStreams = [
			{
				key: "clip",
				sources: [{ sourceKey: "piece", position: 0, isMain: true }],
			},
		];
		const video = input.renditions[0];
		if (!video) throw new Error("Fixture video missing");
		video.ingestKey = "clip";
		expect(enumerateQcTargets(input)).toEqual([]);
		const op = compilePlan(input).find((op) => op.step === "qc-muxing:v180");
		expect(libraryFileOutputs(input)[0]?.path).toBe(
			`${String(op?.payload.outputPath)}${String(op?.payload.filename)}`,
		);
	});
	it("does not advertise normal MP4 or manifests that a QC-only job never creates", () => {
		const input = encodingPlanSchema.parse({
			...fixture,
			aiSceneAnalysis: undefined,
			qc: { vmaf: true, only: true },
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
		expect(
			compilePlan(input).some(
				(op) =>
					op.step === "muxing:v180" || op.kind.startsWith("CREATE_MANIFEST_"),
			),
		).toBe(false);
		expect(
			libraryPlaybackLinks(input, credentials).map((link) => link.key),
		).toEqual(["qc-mp4:v180"]);
		input.qc = { vmaf: false, only: true, model: "vmaf_v0.6.1" };
		expect(libraryPlaybackLinks(input, credentials)).toEqual([]);
		expect(libraryFileOutputs(input)).toEqual([]);
	});
	it("retains actual QC WebM with a distinct kind and key", () => {
		const webm = qcOnlyPlan();
		webm.renditions = [
			{
				key: "v180",
				codec: "VP9",
				mode: "STANDARD",
				ingestKey: "video",
				width: 640,
				height: 360,
				bitrate: 350000,
				rate: 24,
			},
		];
		destination(webm).acl = "PRIVATE";
		const op = compilePlan(webm).find((op) => op.step === "qc-muxing:v180");
		expect(op?.kind).toBe("CREATE_MUXING_PROGRESSIVE_WEBM");
		const path = `${String(op?.payload.outputPath)}${String(op?.payload.filename)}`;
		expect(libraryFileOutputs(webm)).toEqual([
			{
				key: "qc-webm:v180",
				kind: "WEBM",
				credentialId: credential.id,
				bucket: "sample-output-bucket",
				path,
			},
		]);
		expect(libraryPlaybackLinks(webm, credentials)).toEqual([
			expect.objectContaining({
				key: "qc-webm:v180",
				kind: "WEBM",
				path,
				url: null,
				reason: { code: "NOT_PUBLIC" },
			}),
		]);
		expect(
			libraryFileOutputSchema.safeParse(libraryFileOutputs(webm)[0]).success,
		).toBe(true);
		expect(
			libraryPlaybackLinkSchema.safeParse(
				libraryPlaybackLinks(webm, credentials)[0],
			).success,
		).toBe(true);
	});
	it("omits unresolved paths and per-title templates", () => {
		const unresolved = qcOnlyPlan();
		destination(unresolved).path += "/{uuid}";
		expect(libraryFileOutputs(unresolved)).toEqual([]);
		const perTitle = qcOnlyPlan();
		const video = perTitle.renditions[0];
		if (!video || !("mode" in video)) throw new Error("Fixture video missing");
		video.mode = "PER_TITLE_TEMPLATE";
		expect(libraryFileOutputs(perTitle)).toEqual([]);
	});
	it("keeps ordinary delivery playback unchanged instead of exposing its clear QC mirrors", () => {
		const input = encodingPlanSchema.parse({
			...fixture,
			qc: { vmaf: true, only: false },
		});
		expect(
			libraryPlaybackLinks(input, credentials).map((link) => link.key),
		).toEqual(["mp4:v180"]);
		input.drm = [{ muxingKey: "v180" }] as typeof input.drm;
		expect(libraryPlaybackLinks(input, credentials)).toEqual([]);
	});
});

describe("progressive WebM Library output", () => {
	function webmPlan(filename?: string) {
		return encodingPlanSchema.parse({
			...fixture,
			aiSceneAnalysis: undefined,
			qc: undefined,
			renditions: [
				{
					key: "v180",
					codec: "VP9",
					mode: "STANDARD",
					ingestKey: "video",
					width: 640,
					height: 360,
					bitrate: 350000,
					rate: 24,
				},
			],
			muxings: [
				{
					key: "webm",
					kind: "WEBM",
					progressive: true,
					...(filename ? { filename } : {}),
					streamKey: "v180",
					destination: destination(plan()),
				},
			],
		});
	}
	it.each([
		"video.webm",
		undefined,
	])("matches the compiler's progressive filename, including its default: %s", (filename) => {
		const input = webmPlan(filename);
		const op = compilePlan(input).find((op) => op.step === "muxing:webm");
		expect(op?.kind).toBe("CREATE_MUXING_PROGRESSIVE_WEBM");
		expect(libraryFileOutputs(input)).toEqual([
			{
				key: "webm:webm",
				kind: "WEBM",
				credentialId: credential.id,
				bucket: "sample-output-bucket",
				path: joinFilePath(
					String(op?.payload.outputPath),
					String(op?.payload.filename),
				),
			},
		]);
	});
	it("omits segmented, encrypted, per-title and unresolved WebM outputs", () => {
		const segmented = webmPlan("video.webm");
		const muxing = segmented.muxings[0];
		if (muxing?.kind !== "WEBM") throw new Error("Fixture WebM missing");
		muxing.progressive = false;
		expect(libraryFileOutputs(segmented)).toEqual([]);
		const encrypted = webmPlan("video.webm");
		encrypted.drm = [{ muxingKey: "webm" }] as typeof encrypted.drm;
		expect(libraryFileOutputs(encrypted)).toEqual([]);
		const perTitle = webmPlan("video.webm");
		const rendition = perTitle.renditions[0];
		if (!rendition || !("mode" in rendition))
			throw new Error("Fixture video missing");
		rendition.mode = "PER_TITLE_TEMPLATE";
		expect(libraryFileOutputs(perTitle)).toEqual([]);
		expect(libraryFileOutputs(webmPlan("{uuid}.webm"))).toEqual([]);
	});
	it.each([
		"H264",
		"VP9",
	])("does not advertise a QC file attached to encrypted delivery: %s", (codec) => {
		const input = qcOnlyPlan();
		if (codec === "VP9")
			input.renditions = [
				{
					key: "v180",
					codec: "VP9",
					mode: "STANDARD",
					ingestKey: "video",
					width: 640,
					height: 360,
					bitrate: 350000,
					rate: 24,
				},
			];
		input.drm = [{ muxingKey: "segmented" }] as typeof input.drm;
		expect(libraryFileOutputs(input)).toEqual([]);
		expect(libraryPlaybackLinks(input, credentials)).toEqual([]);
	});
});
