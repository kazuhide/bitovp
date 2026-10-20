import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { hlsChildEntries, hlsIframeUris } from "./hls-media-defaults";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function fixture(uri = "main-video.m3u8") {
	const input = loadPlan("fixed-bitrate-hls-on-aws");
	const video = input.renditions.find((r) => r.key === "v360");
	if (!video) throw new Error("Missing video fixture");
	Object.assign(video, { hlsVariantUri: uri });
	return encodingPlanSchema.parse(input);
}

function hls(plan: ReturnType<typeof fixture>) {
	const manifest = plan.manifests.find((m) => m.kind === "HLS");
	if (manifest?.kind !== "HLS") throw new Error("Missing HLS fixture");
	return manifest;
}

describe("explicit HLS video playlist URI", () => {
	it("preserves the exact filename in compiler, child inventory and YAML", () => {
		const plan = fixture();
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		expect(
			compilePlan(plan).find((op) => op.step === "hls-variant:hls:v360")
				?.payload.uri,
		).toBe("main-video.m3u8");
		expect(hlsChildEntries(plan, hls(plan))).toContainEqual(
			expect.objectContaining({ renditionKey: "v360", uri: "main-video.m3u8" }),
		);
		expect(planToEncodingTemplateYaml(plan)).toContain("uri: main-video.m3u8");
	});
	it.each([
		"../video.m3u8",
		"/video.m3u8",
		"https://example.invalid/video.m3u8",
		"sub/video.m3u8",
		"sub\\video.m3u8",
		"video.m3u8?x=1",
		"video.m3u8#x",
		"%2e%2e.m3u8",
		"video_{height}.m3u8",
		"video\n.m3u8",
	])("rejects unsafe or unsupported filename %s", (uri) => {
		expect(() => fixture(uri)).toThrow();
	});
	it("rejects an override on a Per-Title template instead of dropping it", () => {
		const plan = fixture();
		const video = plan.renditions.find((r) => r.key === "v360");
		if (video?.codec !== "H264") throw new Error("Missing H264 fixture");
		video.mode = "PER_TITLE_TEMPLATE";
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_HLS_VIDEO_URI_PER_TITLE",
		);
	});
	it("expands only the audio-group token for a multi-audio master", () => {
		const plan = fixture("main-{group}.m3u8");
		const manifest = hls(plan);
		manifest.variantsPerAudioGroup = true;
		for (const r of plan.renditions) {
			if (r.codec === "AAC")
				r.hlsMedia = { groupId: r.key, name: r.key, uri: `${r.key}.m3u8` };
			if (r.codec === "H264") r.hlsVariantLabel = r.key;
		}
		expect(
			hlsChildEntries(plan, manifest)
				.filter((e) => e.renditionKey === "v360")
				.map((e) => e.uri),
		).toEqual(["main-a128.m3u8", "main-a64.m3u8"]);
	});
	it("refuses literal overrides shared by multiple audio-group writers", () => {
		const plan = fixture();
		hls(plan).variantsPerAudioGroup = true;
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_HLS_VIDEO_URI_GROUP_REQUIRED",
		);
	});
	it.each([
		"master.m3u8",
		"audio_128000.m3u8",
	])("refuses a playlist that overwrites %s", (uri) => {
		const plan = fixture(uri);
		hls(plan).manifestName = "master.m3u8";
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_HLS_VIDEO_URI_COLLISION",
		);
	});
	it("keeps generated I-frame names separate from the explicit video name", () => {
		const plan = fixture("main-{group}.m3u8");
		const manifest = hls(plan);
		manifest.variantsPerAudioGroup = true;
		manifest.iframePlaylists = true;
		for (const r of plan.renditions) {
			if (r.codec === "AAC")
				r.hlsMedia = { groupId: r.key, name: r.key, uri: `${r.key}.m3u8` };
			if (r.codec === "H264") r.hlsVariantLabel = r.key;
		}
		expect(hlsIframeUris(plan, manifest).get("v360")).toBe(
			"video_v360_360p_300000_iframe.m3u8",
		);
	});
});
