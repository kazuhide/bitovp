import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { hlsChildEntries, hlsChildFiles } from "../plan/hls-media-defaults";
import { loadPlan } from "../plan/test-support";
import { validatePlan } from "../plan/validate";
import { compileExpectedArtefacts } from "./expected";

function fixture() {
	const plan = loadPlan("fixed-bitrate-hls-on-aws");
	plan.renditions = plan.renditions.filter((row) =>
		["v360", "a128"].includes(row.key),
	);
	plan.muxings = plan.muxings.filter((row) =>
		["v360", "a128"].includes(row.streamKey),
	);
	plan.generation.timing = "POST_ENCODING";
	const hls = plan.manifests[0];
	if (hls?.kind !== "HLS") throw new Error("HLS fixture missing");
	hls.generationMode = "DEFAULT";
	return { plan, hls };
}

describe("Default HLS selection", () => {
	it("keeps flexible template modes without requiring one RESULT per template", () => {
		const { plan } = fixture();
		const video = plan.renditions[0];
		if (video?.codec !== "H264") throw new Error("video missing");
		video.mode = "PER_TITLE_TEMPLATE";
		video.bitrate = null;
		plan.renditions.push({ ...video, key: "v540", height: 540 });
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("muxing missing");
		plan.muxings.push({ ...muxing, key: "v540", streamKey: "v540" });
		const selected = compileExpectedArtefacts(plan).manifests[0]?.hlsDefault;
		expect(selected?.counts.video).toEqual({ min: 1 });
		expect(selected?.tracks.filter((row) => row.kind === "video")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mode: "PER_TITLE_TEMPLATE" }),
			]),
		);
		expect(selected?.perTitleSelection).toEqual([
			{ renditionKey: "v360", optional: true },
			{ renditionKey: "v540", optional: true },
		]);
		video.mode = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
		expect(
			compileExpectedArtefacts(plan).manifests[0]?.hlsDefault
				?.perTitleSelection,
		).toEqual([
			{ renditionKey: "v360" },
			{ renditionKey: "v540", optional: true },
		]);
	});
	it("uses subtitle schema defaults as generated configuration but rejects unsent custom subtitle names", () => {
		const plan = loadPlan("fixed-bitrate-hls-vtt-on-aws");
		plan.generation.timing = "POST_ENCODING";
		const hls = plan.manifests.find((row) => row.kind === "HLS");
		if (hls?.kind !== "HLS") throw new Error("HLS missing");
		hls.generationMode = "DEFAULT";
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const expected = compileExpectedArtefacts(plan).manifests[0];
		expect(expected?.hlsDefault?.counts.text).toEqual({ min: 1, max: 1 });
		const subtitle = plan.renditions.find((row) => row.codec === "WEBVTT");
		if (subtitle?.codec !== "WEBVTT") throw new Error("subtitle missing");
		subtitle.uri = "saved-custom-subtitles.m3u8";
		expect(
			validatePlan(plan).some(
				(issue) =>
					issue.level === "error" &&
					issue.path?.endsWith(".uri") &&
					/Default HLS/.test(issue.message),
			),
		).toBe(true);
	});
	it("reserves only the known master, without claiming provider-generated child names", () => {
		const { plan, hls } = fixture();
		expect(hlsChildEntries(plan, hls)).toEqual([]);
		expect(hlsChildFiles(plan, hls)).toEqual([]);
	});
	it.each([
		"hlsVariantUri",
		"hlsVariantLabel",
		"hlsMedia",
	] as const)("rejects an unused manual rendition %s without erasing it", (field) => {
		const { plan } = fixture();
		const video = plan.renditions[0];
		if (!video) throw new Error("video missing");
		if (field === "hlsMedia")
			video.hlsMedia = {
				name: "Custom",
				groupId: "custom",
				uri: "custom.m3u8",
			};
		else video[field] = "custom-video.m3u8";
		const before = structuredClone(plan);
		expect(
			validatePlan(plan)
				.filter((issue) => issue.level === "error")
				.some(
					(issue) =>
						issue.path?.endsWith(field) && /Default HLS/.test(issue.message),
				),
		).toBe(true);
		expect(plan).toEqual(before);
	});
	it("keeps manual selectors for a separate manual HLS manifest and never inherits them into Default expectations", () => {
		const { plan, hls } = fixture();
		const video = plan.renditions[0],
			audio = plan.renditions[1];
		if (!video || !audio) throw new Error("tracks missing");
		video.hlsVariantUri = "custom-video.m3u8";
		audio.hlsMedia = {
			name: "Custom audio",
			groupId: "custom-group",
			uri: "custom-audio.m3u8",
		};
		plan.manifests.push({
			...hls,
			key: "manual",
			manifestName: "manual.m3u8",
			generationMode: "MANUAL",
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.find((op) => op.kind === "CREATE_HLS_STREAM_INFO")?.payload.uri,
		).toBe("custom-video.m3u8");
		const expected = compileExpectedArtefacts(plan).manifests.find(
			(row) => row.manifestKey === hls.key,
		);
		expect(expected?.hlsChildFiles).toBeUndefined();
		expect(expected?.manifestRenditions?.hlsVariants).toBeUndefined();
		expect(JSON.stringify(expected)).not.toMatch(
			/custom-video|Custom audio|custom-group|custom-audio/,
		);
	});
	it("binds the default root and its expectations to the first rendition's resolved encoding, rather than the job union", () => {
		const { plan, hls } = fixture();
		plan.encodings = [
			{ key: "other", name: "Other" },
			{ key: "selected", name: "Selected" },
		];
		for (const rendition of [...plan.renditions, ...plan.ingest])
			rendition.encodingKey = "selected";
		const input = plan.ingest.find((row) => row.key === "video");
		if (!input) throw new Error("video input missing");
		plan.ingest.push({ ...input, key: "other-ingest", encodingKey: "other" });
		const original = plan.renditions[0];
		if (original?.codec !== "H264") throw new Error("video missing");
		plan.renditions.push({
			...original,
			key: "other-video",
			encodingKey: "other",
			ingestKey: "other-ingest",
			height: 720,
			mode: "PER_TITLE_TEMPLATE",
			bitrate: null,
		});
		plan.perTitle = { h264Configuration: {} };
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("muxing missing");
		plan.muxings.push({
			...muxing,
			key: "other-video",
			streamKey: "other-video",
			destination: { outputKey: "origin", path: "other/{uuid}/" },
		});
		// Imported metadata stays encoding-scoped even when its execution topology is unsupported.
		expect(
			validatePlan(plan)
				.filter((issue) => issue.level === "error")
				.map((issue) => issue.code),
		).toEqual(["PLAN_MULTI_ENCODING_PER_TITLE"]);
		const root = compilePlan(plan).find(
			(op) => op.step === `manifest:${hls.key}`,
		);
		expect(root?.refs.encodingId).toBe("encoding:selected");
		const expected = compileExpectedArtefacts(plan).manifests[0];
		expect(expected).toMatchObject({
			videoEntries: 1,
			audioEntries: 1,
			perTitle: false,
			hlsDefault: { encodingKey: "selected" },
		});
		expect(JSON.stringify(expected)).not.toContain("other-video");
	});
	it("does not apply manual HLS compatibility checks to another encoding's Opus/WebM output", () => {
		const { plan } = fixture();
		plan.encodings = [
			{ key: "selected", name: "Selected" },
			{ key: "other", name: "Other" },
		];
		for (const row of [...plan.renditions, ...plan.ingest])
			row.encodingKey = "selected";
		const audioInput = plan.ingest.find((row) => row.key === "audio");
		if (!audioInput) throw new Error("audio input missing");
		plan.ingest.push({
			...audioInput,
			key: "other-ingest",
			encodingKey: "other",
		});
		plan.renditions.push({
			key: "other-audio",
			codec: "OPUS",
			channelLayout: "CL_STEREO",
			encodingKey: "other",
			ingestKey: "other-ingest",
			bitrate: 64_000,
			rate: 48_000,
		});
		plan.muxings.push({
			key: "other-audio",
			streamKey: "other-audio",
			kind: "WEBM",
			segmentLength: 6,
			segmentNaming: "segment_%number%.chk",
			initSegmentName: "init.hdr",
			destination: { outputKey: "origin", path: "other/audio/" },
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});
});
