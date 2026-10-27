import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { hlsChildEntries } from "./hls-media-defaults";
import {
	dashAdditionalRepresentationSchema,
	hlsAdditionalMediaSchema,
} from "./manifest-options";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function base() {
	return loadPlan("av1-fmp4-dash-hls");
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Fixture value missing");
	return value;
}
const errors = (plan: ReturnType<typeof base>) =>
	validatePlan(plan).filter((issue) => issue.level === "error");
const hlsFor = (plan: ReturnType<typeof base>) => {
	const hls = plan.manifests.find((m) => m.kind === "HLS");
	if (hls?.kind !== "HLS") throw new Error("HLS missing");
	return hls;
};
const dashFor = (plan: ReturnType<typeof base>) => {
	const dash = plan.manifests.find((m) => m.kind === "DASH");
	if (dash?.kind !== "DASH") throw new Error("DASH missing");
	return dash;
};

describe("manifest reference validation", () => {
	it.each([
		"https://user:password@example.test/sub.vtt",
		"https://user@example.test/sub.vtt",
	])("rejects credentials in external VTT URL %s before persistence", (vttUrl) => {
		expect(
			hlsAdditionalMediaSchema.safeParse({
				type: "VTT",
				name: "Subtitle",
				groupId: "subtitles",
				uri: "subtitle.m3u8",
				vttUrl,
			}).success,
		).toBe(false);
		expect(
			dashAdditionalRepresentationSchema.safeParse({
				type: "VTT",
				lang: "en",
				vttUrl,
			}).success,
		).toBe(false);
		const plan = base();
		hlsFor(plan).detailed = {
			additionalMedia: [
				{
					type: "VTT",
					name: "Subtitle",
					groupId: "subtitles",
					uri: "subtitle.m3u8",
					vttUrl,
				},
			],
		};
		expect(encodingPlanSchema.safeParse(plan).success).toBe(false);
	});
	it("rejects duplicate representation overrides rather than silently using the first", () => {
		const plan = base();
		const muxingKey = required(plan.muxings[0]).key;
		dashFor(plan).detailed = {
			representations: [
				{ muxingKey, startSegmentNumber: 0 },
				{ muxingKey, startSegmentNumber: 2 },
			],
		};
		expect(
			errors(plan).some((issue) => /only one override/.test(issue.message)),
		).toBe(true);
	});
	it("checks keyframe ownership for audio-only variants too", () => {
		const plan = base();
		plan.encodings = [
			{ key: "video", name: "Video" },
			{ key: "audio", name: "Audio" },
		];
		for (const rendition of plan.renditions)
			rendition.encodingKey = rendition.codec === "AAC" ? "audio" : "video";
		plan.keyframes = [{ key: "cue", time: 2, encodingKey: "video" }];
		const hls = hlsFor(plan);
		hls.audioVariantStreams = true;
		hls.detailed = {
			streamCustomTags: [
				{
					positionMode: "KEYFRAME",
					keyframeKey: "cue",
					data: "#EXT-X-CUSTOM:1",
				},
			],
		};
		expect(
			errors(plan).some(
				(issue) =>
					issue.path?.includes("streamCustomTags") &&
					/same encoding/.test(issue.message),
			),
		).toBe(true);
	});
	it.each([
		"master",
		"duplicate",
		"audio",
		"alias",
		"mirror",
	])("reserves additional playlist writers before deduplication: %s", (kind) => {
		const plan = base();
		const hls = hlsFor(plan);
		const video = required(plan.muxings[0]);
		const audio = required(
			hlsChildEntries(plan, hls).find((entry) => entry.kind === "audio"),
		);
		const uri =
			kind === "master"
				? hls.manifestName
				: kind === "audio"
					? audio.uri
					: "alternate.m3u8";
		hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: video.key,
					uri,
				},
			],
		};
		if (kind === "duplicate")
			required(hls.detailed.additionalMedia).push({
				type: "VTT",
				name: "Subtitle",
				groupId: "subtitles",
				uri,
				vttUrl: "https://example.test/sub.vtt",
			});
		if (kind === "alias" || kind === "mirror") {
			const original = required(plan.outputs[0]);
			if (original.kind !== "S3") throw new Error("S3 fixture required");
			plan.outputs.push({
				...original,
				key: "second",
				bucket: kind === "alias" ? original.bucket : "second-bucket",
			});
			plan.manifests.push({
				...hls,
				key: "other",
				destination: { ...hls.destination, outputKey: "second" },
				manifestName: uri,
				detailed: undefined,
			});
			if (kind === "mirror") plan.deliveryMirrors = [{ outputKey: "second" }];
		}
		expect(
			errors(plan).some(
				(issue) => issue.code === "PLAN_MANIFEST_URI_COLLISION",
			),
		).toBe(true);
	});
	it("compiles per-media encryption paths and rejects physically unreachable encrypted outputs", () => {
		const plan = base();
		const hls = hlsFor(plan);
		const dash = dashFor(plan);
		const video = required(plan.muxings[0]);
		const destination = { outputKey: "origin", path: "encrypted/video/" };
		plan.drm = [
			{
				key: "encrypted",
				kind: "CENC",
				muxingKey: video.key,
				destination,
				credentialId: "00000000-0000-4000-8000-000000000003",
				kid: "00000000000000000000000000000000",
				widevine: { pssh: "AAAA" },
			},
		];
		hls.detailed = {
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Encrypted",
					groupId: "encrypted",
					muxingKey: video.key,
					drmKey: "encrypted",
					uri: "encrypted.m3u8",
				},
			],
		};
		dash.detailed = {
			representations: [
				{
					muxingKey: video.key,
					drmRepresentation: true,
					contentProtection: "ADAPTATION_SET",
				},
			],
		};
		const ops = compilePlan(plan);
		expect(
			ops.find((op) => op.kind === "CREATE_HLS_VIDEO_MEDIA")?.payload
				.segmentPath,
		).toBe("../../encrypted/video/");
		expect(
			ops.find((op) => op.step === `manifest:${dash.key}:rep:${video.key}`)
				?.payload.segmentPath,
		).toBe("../../encrypted/video/");
		expect(
			ops.find((op) => op.kind === "CREATE_HLS_VIDEO_MEDIA")?.refs.drmId,
		).toBe("drm:encrypted");
		expect(
			ops.find((op) => op.kind === "CREATE_DASH_CONTENT_PROTECTION"),
		).toMatchObject({
			payload: { representationKind: "ADAPTATION_SET" },
			refs: { drmId: "drm:encrypted", muxingId: `muxing:${video.key}` },
		});
		const output = required(plan.outputs[0]);
		if (output.kind !== "S3") throw new Error("S3 required");
		plan.outputs.push({
			...output,
			key: "elsewhere",
			bucket: "unrelated-bucket",
		});
		destination.outputKey = "elsewhere";
		expect(
			errors(plan).filter((issue) => /reachable/.test(issue.message)),
		).toHaveLength(2);
	});
	it.each([
		"SPRITE",
		"PROGRESSIVE_WEBM",
	] as const)("requires physical storage reachability for %s", (type) => {
		const plan = base();
		const dash = dashFor(plan);
		const output = required(plan.outputs[0]);
		if (output.kind !== "S3") throw new Error("S3 required");
		plan.outputs.push({
			...output,
			key: "elsewhere",
			bucket: "unrelated-bucket",
		});
		if (type === "SPRITE") {
			plan.sprites = [
				{
					key: "sprite",
					streamKey: required(plan.renditions[0]).key,
					width: 160,
					distance: 10,
					unit: "SECONDS",
					filename: "sprite.jpg",
					destination: { outputKey: "elsewhere", path: dash.destination.path },
				},
			];
			dash.detailed = {
				additionalRepresentations: [{ type, spriteKey: "sprite" }],
			};
		} else {
			const source = loadPlan("vp9-webm-fixed-dash");
			plan.renditions.push({ ...required(source.renditions[0]), key: "vp9" });
			const webm = required(source.muxings[0]);
			if (webm.kind !== "WEBM") throw new Error("WEBM required");
			plan.muxings.push({
				...webm,
				key: "progressive",
				streamKey: "vp9",
				progressive: true,
				filename: "video.webm",
				destination: { outputKey: "elsewhere", path: dash.destination.path },
			});
			dash.detailed = {
				additionalRepresentations: [{ type, muxingKey: "progressive" }],
			};
		}
		expect(errors(plan).some((issue) => /reachable/.test(issue.message))).toBe(
			true,
		);
	});
	it("accepts WebM Default generation without applying manual fMP4 leg predicates", () => {
		const plan = loadPlan("vp9-webm-fixed-dash");
		const dash = dashFor(plan);
		dash.generationMode = "DEFAULT";
		delete dash.videoMuxingKind;
		delete dash.audioMuxingKind;
		expect(errors(plan)).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.filter(
				(op) =>
					op.kind.startsWith("CREATE_DASH_") &&
					!op.kind.startsWith("CREATE_MANIFEST_"),
			),
		).toEqual([]);
		expect(
			ops.find((op) => op.kind === "CREATE_MANIFEST_DASH")?.payload
				.generationMode,
		).toBe("DEFAULT");
	});
	it("retains per-media and shared tags with unique operation identities", () => {
		const plan = base();
		const hls = hlsFor(plan);
		hls.detailed = {
			mediaCustomTags: [
				{ positionMode: "TIME", time: 0, data: "#EXT-X-SHARED:1" },
			],
			additionalMedia: [
				{
					type: "VIDEO",
					name: "Alternate",
					groupId: "alternate",
					muxingKey: required(plan.muxings[0]).key,
					uri: "alternate.m3u8",
					customTags: [
						{ positionMode: "SEGMENT", segment: 0, data: "#EXT-X-ENTRY:1" },
					],
				},
			],
		};
		const tags = compilePlan(plan).filter(
			(op) =>
				op.kind === "CREATE_HLS_CUSTOM_TAG" &&
				op.refs.mediaId === `hls-media:${hls.key}:additional-0`,
		);
		expect(tags).toHaveLength(2);
		expect(new Set(tags.map((op) => op.step)).size).toBe(2);
	});
	it("keeps segmented subtitle ranges out of external VTT media", () => {
		const plan = base();
		const hls = hlsFor(plan);
		hls.detailed = {
			subtitleMedia: {
				startSegmentNumber: 1,
				endSegmentNumber: 3,
				assocLanguage: "ja",
				forced: false,
			},
			additionalMedia: [
				{
					type: "VTT",
					name: "English",
					groupId: "subtitles",
					uri: "subtitle.m3u8",
					vttUrl: "https://example.test/sub.vtt",
				},
			],
		};
		const payload = compilePlan(plan).find(
			(op) => op.kind === "CREATE_HLS_VTT_MEDIA",
		)?.payload;
		expect(payload).toMatchObject({ assocLanguage: "ja", forced: false });
		expect(payload).not.toHaveProperty("startSegmentNumber");
		expect(payload).not.toHaveProperty("endSegmentNumber");
	});
});
