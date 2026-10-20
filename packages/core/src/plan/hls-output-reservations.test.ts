import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { hlsIframeUris } from "./hls-media-defaults";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function fixture(uri = "main-video.m3u8") {
	const plan = loadPlan("fixed-bitrate-hls-on-aws");
	const video = plan.renditions.find((rendition) => rendition.key === "v360");
	if (!video) throw new Error("Missing video fixture");
	video.hlsVariantUri = uri;
	return encodingPlanSchema.parse(plan);
}

function hls(plan: ReturnType<typeof fixture>) {
	const manifest = plan.manifests.find((entry) => entry.kind === "HLS");
	if (!manifest) throw new Error("Missing HLS fixture");
	return manifest;
}

describe("HLS physical output file reservations", () => {
	it.each([
		"alias",
		"mirror",
	])("refuses separate video writers on the same physical %s destination", (mode) => {
		const plan = fixture("shared.m3u8");
		const primary = plan.outputs[0];
		const first = hls(plan);
		if (primary?.kind !== "S3") throw new Error("Missing S3 fixture");
		plan.outputs.push({ ...primary, key: "alias" });
		const video = plan.renditions.find((rendition) => rendition.key === "v540");
		if (!video) throw new Error("Missing video fixture");
		video.hlsVariantUri = "shared.m3u8";
		plan.renditions = plan.renditions.filter((rendition) =>
			["v360", "v540"].includes(rendition.key),
		);
		plan.muxings = plan.muxings.flatMap((muxing) => {
			if (muxing.streamKey === "v360") return [muxing];
			if (muxing.streamKey !== "v540") return [];
			return [
				{
					key: muxing.key,
					kind: "TS" as const,
					streamKey: muxing.streamKey,
					segmentLength: 2,
					segmentNaming: "segment_%number%.ts",
					destination: muxing.destination,
				},
			];
		});
		first.videoMuxingKind = "FMP4";
		plan.manifests.push({
			...structuredClone(first),
			key: "second",
			manifestName: "second.m3u8",
			videoMuxingKind: "TS",
			destination: { ...first.destination, outputKey: "alias" },
		});
		if (mode === "mirror") {
			primary.bucket = "primary-storage";
			const alias = plan.outputs.at(-1);
			if (alias?.kind !== "S3") throw new Error("Missing alias fixture");
			alias.bucket = "secondary-storage";
			plan.outputs.push({
				...primary,
				key: "shared",
				bucket: "mirror-storage",
			});
			plan.deliveryMirrors = [{ outputKey: "shared" }];
		}
		expect(validatePlan(plan)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_HLS_VIDEO_URI_COLLISION",
				message: expect.stringContaining('"shared.m3u8"'),
			}),
		);
		if (mode === "alias") {
			const alias = plan.outputs.at(-1);
			if (alias?.kind !== "S3") throw new Error("Missing alias fixture");
			alias.credentialId = "00000000-0000-4000-8000-000000000009";
			expect(validatePlan(plan).map((issue) => issue.code)).toContain(
				"PLAN_HLS_VIDEO_URI_COLLISION",
			);
			alias.bucket = "independent-storage";
		} else {
			delete plan.deliveryMirrors;
		}
		expect(validatePlan(plan).map((issue) => issue.code)).not.toContain(
			"PLAN_HLS_VIDEO_URI_COLLISION",
		);
	});

	it("keeps the same writer valid when a mirror aliases its primary storage", () => {
		const plan = fixture();
		const primary = plan.outputs[0];
		if (!primary) throw new Error("Missing output fixture");
		plan.outputs.push({ ...primary, key: "alias" });
		plan.deliveryMirrors = [{ outputKey: "alias" }];
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it.each([
		"FMP4",
		"MP4",
	] as const)("refuses a video playlist that overwrites the %s muxing file", (kind) => {
		const plan = fixture("init.m3u8");
		const manifest = hls(plan);
		const muxing = plan.muxings.find((entry) => entry.key === "v360");
		if (!muxing) throw new Error("Missing video muxing fixture");
		if (kind === "FMP4" && muxing.kind === "FMP4") {
			muxing.initSegmentName = "init.m3u8";
			muxing.destination = { ...manifest.destination };
		} else {
			plan.muxings.push({
				key: "progressive",
				kind: "MP4",
				streamKey: "v360",
				filename: "init.m3u8",
				destination: { ...manifest.destination },
			});
		}
		expect(validatePlan(plan).map((issue) => issue.code)).toContain(
			"PLAN_HLS_VIDEO_URI_COLLISION",
		);
	});

	it("reserves the master name before choosing an I-frame suffix", () => {
		const plan = fixture("video_v360_360p_300000_{group}.m3u8");
		const manifest = hls(plan);
		manifest.variantsPerAudioGroup = true;
		manifest.iframePlaylists = true;
		manifest.manifestName = "video_v360_360p_300000_iframe_1.m3u8";
		for (const rendition of plan.renditions) {
			if (rendition.codec === "AAC")
				rendition.hlsMedia = {
					groupId: "iframe",
					name: rendition.key,
					uri: `${rendition.key}.m3u8`,
				};
			if (rendition.codec === "H264") rendition.hlsVariantLabel = rendition.key;
		}
		expect(hlsIframeUris(plan, manifest).get("v360")).toBe(
			"video_v360_360p_300000_iframe_2.m3u8",
		);
		expect(
			compilePlan(plan).find(
				(operation) => operation.step === "hls-iframe:hls:v360",
			)?.payload.filename,
		).toBe("video_v360_360p_300000_iframe_2.m3u8");
	});

	it("reserves an encrypted init file through a storage mirror", () => {
		const plan = fixture("encrypted-init.m3u8");
		const origin = plan.outputs[0];
		const manifest = hls(plan);
		const muxing = plan.muxings.find((entry) => entry.key === "v360");
		if (origin?.kind !== "S3" || muxing?.kind !== "FMP4")
			throw new Error("Missing encrypted output fixture");
		plan.outputs.push(
			{ ...origin, key: "encrypted", bucket: "encrypted-storage" },
			{ ...origin, key: "mirror", bucket: "shared-storage" },
		);
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		delete muxing.destination;
		muxing.initSegmentName = "encrypted-init.m3u8";
		plan.drm.push({
			key: "encrypted",
			kind: "CENC",
			muxingKey: muxing.key,
			credentialId: "00000000-0000-4000-8000-000000000001",
			kid: "0123456789abcdef0123456789abcdef",
			encryptionMode: "CTR",
			destination: { outputKey: "encrypted", path: manifest.destination.path },
		});
		expect(validatePlan(plan).map((issue) => issue.code)).toContain(
			"PLAN_HLS_VIDEO_URI_COLLISION",
		);
	});
});
