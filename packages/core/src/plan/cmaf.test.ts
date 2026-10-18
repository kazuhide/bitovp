import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "../live/compiler";
import { liveChannelPlanSchema } from "../live/schema";
import { validateLiveChannel } from "../live/validate";
import { compileExpectedArtefacts } from "../verify/expected";
import { compileExpectedLiveArtefacts } from "../verify/expected-live";
import { enumerateLiveCaptureTargets } from "../vmaf/live-targets";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { hlsVersionForLegs } from "./hls-legs";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function cmafPlan() {
	const raw = loadPlan("fixed-bitrate-hls-on-aws");
	return encodingPlanSchema.parse({
		...raw,
		muxings: raw.muxings.map((m) => ({ ...m, kind: "CMAF" })),
		manifests: [
			{
				key: "dash",
				kind: "DASH",
				destination: raw.manifests[0]?.destination,
				videoMuxingKind: "CMAF",
				audioMuxingKind: "CMAF",
			},
		],
	});
}
function livePlan() {
	const raw = JSON.parse(
		readFileSync(
			new URL(
				"../live/__fixtures__/live-rtmp-simple.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	raw.liveManifests = raw.liveManifests.filter(
		(m: Record<string, unknown>) => m.kind === "DASH",
	);
	raw.muxings = raw.muxings.map((m: Record<string, unknown>) => ({
		...m,
		kind: "CMAF",
	}));
	return liveChannelPlanSchema.parse(raw);
}

describe("dedicated CMAF muxing", () => {
	it("uses dedicated CMAF muxing and DASH endpoints with segmented MP4 verification", () => {
		const plan = cmafPlan();
		expect(validatePlan(plan).filter((x) => x.level === "error")).toEqual([]);
		const ops = compilePlan(plan);
		expect(ops.filter((x) => x.kind === "CREATE_MUXING_CMAF")).toHaveLength(4);
		expect(
			ops.filter((x) => x.kind === "CREATE_DASH_REPRESENTATION_CMAF"),
		).toHaveLength(4);
		expect(
			ops.some(
				(x) =>
					x.kind === "CREATE_MUXING_FMP4" ||
					x.kind === "CREATE_DASH_REPRESENTATION_FMP4",
			),
		).toBe(false);
		expect(ops.filter((x) => x.kind === "CREATE_HLS_STREAM_INFO")).toHaveLength(
			0,
		);
		expect(
			compileExpectedArtefacts(plan).muxings.every(
				(m) => m.container === "FMP4_SEGMENTED",
			),
		).toBe(true);
		expect(hlsVersionForLegs(["CMAF"])).toBe("HLS_V6");
		expect(compileExpectedArtefacts(plan).manifests[0]).toMatchObject({
			videoEntries: 2,
			audioEntries: 2,
			manifestRenditions: {
				video: [{ renditionKey: "v360" }, { renditionKey: "v540" }],
				audio: [{ renditionKey: "a128" }, { renditionKey: "a64" }],
			},
		});
	});
	it("round-trips CMAF authoring including chunk and naming fields without rewriting FMP4 defaults", () => {
		const plan = cmafPlan();
		plan.muxings = encodingPlanSchema.shape.muxings.parse(
			plan.muxings.map((m) => ({
				...m,
				initSegmentNameTemplate: "init-{rand_chars:8}.mp4",
				segmentNamingTemplate: "s-{rand_chars:8}-%number%.m4s",
				framesPerCmafChunk: 1,
			})),
		);
		const rebuilt = encodingPlanSchema.parse(
			buildPlan(planToWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
		const mux = compilePlan(rebuilt).find(
			(x) => x.kind === "CREATE_MUXING_CMAF",
		);
		expect(mux?.payload).toMatchObject({
			framesPerCmafChunk: 1,
			initSegmentNameTemplate: "init-{rand_chars:8}.mp4",
			segmentNamingTemplate: "s-{rand_chars:8}-%number%.m4s",
		});
		expect(mux?.payload).not.toHaveProperty("initSegmentName");
		expect(mux?.payload).not.toHaveProperty("segmentNaming");
		expect(hlsVersionForLegs(["TS"])).toBe("HLS_V4");
		expect(
			compilePlan(loadPlan("fixed-bitrate-hls-on-aws")).filter(
				(x) => x.kind === "CREATE_MUXING_FMP4",
			),
		).toHaveLength(4);
	});
	it("exports dedicated template sections and representation references", () => {
		const yaml = planToEncodingTemplateYaml(cmafPlan());
		expect(yaml).toContain("cmaf:");
		expect(yaml).toContain("/muxings/cmaf/");
		expect(yaml).not.toContain("/muxings/fmp4/");
	});
	it("rejects CMAF HLS before submission while FMP4 HLS stays supported", () => {
		const plan = cmafPlan();
		plan.manifests = encodingPlanSchema.shape.manifests.parse(
			loadPlan("fixed-bitrate-hls-on-aws").manifests,
		);
		expect(
			validatePlan(plan).some(
				(x) => x.code === "PLAN_HLS_CMAF_UNSUPPORTED" && x.level === "error",
			),
		).toBe(true);
		const live = livePlan();
		live.liveManifests = liveChannelPlanSchema.shape.liveManifests.parse([
			{
				key: "hls",
				kind: "HLS",
				destination: live.liveManifests[0]?.destination,
			},
		]);
		expect(
			validateLiveChannel(live).some(
				(x) => x.code === "LIVE_HLS_CMAF_UNSUPPORTED" && x.level === "error",
			),
		).toBe(true);
	});
	it.each([
		"H265",
		"AV1",
	])("rejects unsupported CMAF %s before submission", (codec) => {
		const plan = cmafPlan();
		const first = plan.renditions[0];
		if (!first) throw new Error("Missing video fixture");
		const changed = encodingPlanSchema.parse({
			...plan,
			renditions: plan.renditions.map((r) =>
				r.key === first.key
					? {
							key: r.key,
							codec,
							ingestKey: r.ingestKey,
							height: 360,
							bitrate: 300000,
							mode: "STANDARD",
						}
					: r,
			),
		});
		expect(
			validatePlan(changed).some(
				(x) => x.code === "PLAN_MUXING_CODEC_MISMATCH" && x.level === "error",
			),
		).toBe(true);
	});
	it("accepts Template/Timeline but rejects LIST CMAF DASH representations", () => {
		const plan = cmafPlan();
		for (const representationType of ["TEMPLATE", "TIMELINE"]) {
			const raw = {
				...plan,
				manifests: plan.manifests.map((m) => ({ ...m, representationType })),
			};
			expect(encodingPlanSchema.safeParse(raw).success).toBe(true);
		}
		expect(
			encodingPlanSchema.safeParse({
				...plan,
				manifests: plan.manifests.map((m) => ({
					...m,
					representationType: "LIST",
				})),
			}).success,
		).toBe(false);
	});
	it("allows a separate FMP4 HLS leg beside CMAF DASH", () => {
		const plan = cmafPlan();
		const raw = loadPlan("fixed-bitrate-hls-on-aws");
		plan.muxings = encodingPlanSchema.shape.muxings.parse([
			...plan.muxings,
			...raw.muxings.map((m) => ({
				...m,
				key: `${m.key}-hls`,
				destination: m.destination
					? { ...m.destination, path: `${m.destination.path}-hls` }
					: undefined,
			})),
		]);
		plan.manifests = encodingPlanSchema.shape.manifests.parse([
			...plan.manifests,
			...raw.manifests.map((m) => ({
				...m,
				videoMuxingKind: "FMP4",
				audioMuxingKind: "FMP4",
				mediaVersion: "HLS_V6",
			})),
		]);
		expect(validatePlan(plan).filter((x) => x.level === "error")).toEqual([]);
	});
	it("uses CMAF for per-title result expansion", () => {
		const raw = loadPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
		const plan = encodingPlanSchema.parse({
			...raw,
			muxings: raw.muxings
				.filter((m) => m.kind === "FMP4")
				.map((m) => ({ ...m, kind: "CMAF" })),
			manifests: raw.manifests
				.filter((m) => m.kind === "DASH")
				.map((m) => ({
					...m,
					videoMuxingKind: "CMAF",
					audioMuxingKind: "CMAF",
				})),
		});
		expect(validatePlan(plan).filter((x) => x.level === "error")).toEqual([]);
		expect(
			compilePlan(plan).find(
				(op) => op.kind === "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
			),
		).toMatchObject({
			payload: { muxingKind: "CMAF", mode: "TEMPLATE_REPRESENTATION" },
		});
	});
	it("rejects mixed CMAF video and FMP4 audio HLS instead of dropping the picture", () => {
		const plan = cmafPlan();
		plan.muxings = encodingPlanSchema.shape.muxings.parse(
			plan.muxings.map((m) => ({
				...m,
				kind: m.streamKey.startsWith("a") ? "FMP4" : "CMAF",
			})),
		);
		plan.manifests = loadPlan("fixed-bitrate-hls-on-aws").manifests;
		expect(
			validatePlan(plan).some(
				(x) => x.code === "PLAN_HLS_CMAF_UNSUPPORTED" && x.level === "error",
			),
		).toBe(true);
		const live = livePlan();
		live.muxings = liveChannelPlanSchema.shape.muxings.parse(
			live.muxings.map((m) => ({
				...m,
				kind: m.streamKey.startsWith("a") ? "FMP4" : "CMAF",
			})),
		);
		live.liveManifests = liveChannelPlanSchema.shape.liveManifests.parse([
			{
				key: "hls",
				kind: "HLS",
				destination: live.liveManifests[0]?.destination,
			},
		]);
		expect(
			validateLiveChannel(live).some(
				(x) => x.code === "LIVE_HLS_CMAF_UNSUPPORTED" && x.level === "error",
			),
		).toBe(true);
	});
	it("rejects DRM on CMAF before submission", () => {
		const plan = cmafPlan();
		const source = loadPlan("pertitle-h265-fmp4-drm-on-aws").drm[0];
		if (!source) throw new Error("Missing DRM fixture");
		plan.drm = [{ ...source, muxingKey: plan.muxings[0]?.key ?? "" }];
		expect(
			validatePlan(plan).some(
				(x) => x.code === "PLAN_DRM_MUXING_MISMATCH" && x.level === "error",
			),
		).toBe(true);
	});
	it.each([
		"FMP4",
		"TS",
		"MP4",
	])("rejects an explicit HLS %s video pin without a matching supported video leg", (videoMuxingKind) => {
		const plan = cmafPlan();
		plan.muxings = encodingPlanSchema.shape.muxings.parse(
			plan.muxings.map((m) => ({
				...m,
				kind: m.streamKey.startsWith("a") ? "FMP4" : "CMAF",
			})),
		);
		plan.manifests = encodingPlanSchema.shape.manifests.parse([
			...plan.manifests.map((m) => ({ ...m, audioMuxingKind: "FMP4" })),
			...loadPlan("fixed-bitrate-hls-on-aws").manifests.map((m) => ({
				...m,
				videoMuxingKind,
				audioMuxingKind: "FMP4",
			})),
		]);
		expect(
			compilePlan(plan).filter((op) => op.kind === "CREATE_HLS_STREAM_INFO"),
		).toHaveLength(0);
		expect(validatePlan(plan)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PLAN_HLS_VIDEO_UNSELECTED",
					level: "error",
				}),
			]),
		);
	});
	it.each([
		"FMP4",
		"TS",
	])("rejects an explicit Live HLS %s video pin without a matching supported video leg", (videoMuxingKind) => {
		const plan = livePlan();
		plan.muxings = liveChannelPlanSchema.shape.muxings.parse(
			plan.muxings.map((m) => ({
				...m,
				kind: m.streamKey.startsWith("a") ? "FMP4" : "CMAF",
			})),
		);
		plan.liveManifests = liveChannelPlanSchema.shape.liveManifests.parse([
			...plan.liveManifests,
			{
				key: "hls",
				kind: "HLS",
				destination: plan.liveManifests[0]?.destination,
				videoMuxingKind,
				audioMuxingKind: "FMP4",
			},
		]);
		expect(
			compileLiveChannel(plan).filter(
				(op) => op.kind === "CREATE_HLS_STREAM_INFO",
			),
		).toHaveLength(0);
		expect(validateLiveChannel(plan)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "LIVE_HLS_VIDEO_UNSELECTED",
					level: "error",
				}),
			]),
		);
	});
	it("rejects per-title CMAF DASH DRM pins before runtime result expansion", () => {
		const raw = loadPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
		const videos = raw.renditions.filter((r) => r.codec === "H264");
		const plan = encodingPlanSchema.parse({
			...raw,
			renditions: videos,
			muxings: raw.muxings
				.filter(
					(m) => m.kind === "FMP4" && videos.some((r) => r.key === m.streamKey),
				)
				.map((m) => ({ ...m, kind: "CMAF" })),
			manifests: raw.manifests
				.filter((m) => m.kind === "DASH")
				.map((m) => ({ ...m, videoMuxingKind: "CMAF", drmKind: "CENC" })),
		});
		expect(plan.drm).toEqual([]);
		expect(
			compilePlan(plan).find(
				(op) => op.kind === "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
			),
		).toMatchObject({ payload: { muxingKind: "CMAF", drm: { kind: "CENC" } } });
		expect(validatePlan(plan)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PLAN_DRM_MUXING_MISMATCH",
					level: "error",
				}),
			]),
		);
	});
	it("rejects absent TS video pins on FMP4 plans while preserving audio-only HLS", () => {
		const vod = loadPlan("fixed-bitrate-hls-on-aws");
		vod.manifests = encodingPlanSchema.shape.manifests.parse(
			vod.manifests.map((m) => ({ ...m, videoMuxingKind: "TS" })),
		);
		expect(validatePlan(vod)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PLAN_HLS_VIDEO_UNSELECTED",
					level: "error",
				}),
			]),
		);
		vod.renditions = vod.renditions.filter((r) => r.codec === "AAC");
		vod.muxings = vod.muxings.filter((m) =>
			vod.renditions.some((r) => r.key === m.streamKey),
		);
		expect(validatePlan(vod).filter((x) => x.level === "error")).toEqual([]);
		const live = livePlan();
		live.muxings = liveChannelPlanSchema.shape.muxings.parse(
			live.muxings.map((m) => ({ ...m, kind: "FMP4" })),
		);
		live.liveManifests = liveChannelPlanSchema.shape.liveManifests.parse([
			{
				key: "hls",
				kind: "HLS",
				videoMuxingKind: "TS",
				destination: live.liveManifests[0]?.destination,
			},
		]);
		expect(validateLiveChannel(live)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "LIVE_HLS_VIDEO_UNSELECTED",
					level: "error",
				}),
			]),
		);
		live.renditions = live.renditions.filter((r) => r.codec === "AAC");
		live.muxings = live.muxings.filter((m) =>
			live.renditions.some((r) => r.key === m.streamKey),
		);
		expect(
			validateLiveChannel(live).filter((x) => x.level === "error"),
		).toEqual([]);
	});
	it("compiles Live CMAF manifests and derives init-plus-segment capture", () => {
		const plan = livePlan();
		expect(
			validateLiveChannel(plan).filter((x) => x.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(plan);
		expect(ops.filter((x) => x.kind === "CREATE_MUXING_CMAF")).toHaveLength(4);
		expect(
			ops.filter((x) => x.kind === "CREATE_DASH_REPRESENTATION_CMAF"),
		).toHaveLength(4);
		expect(
			compileExpectedLiveArtefacts(plan).muxings.every(
				(m) => m.container === "FMP4_SEGMENTED",
			),
		).toBe(true);
		expect(enumerateLiveCaptureTargets(plan)).toHaveLength(3);
		expect(
			enumerateLiveCaptureTargets(plan).every(
				(t) => t.kind === "FMP4" && t.initSegmentName === "init.mp4",
			),
		).toBe(true);
	});
	it("refuses SCTE-35 emsg signaling on CMAF instead of silently dropping it", () => {
		const plan = livePlan();
		plan.adMarkers = { scte35: true };
		expect(
			validateLiveChannel(plan).some(
				(x) => x.code === "LIVE_CMAF_SCTE35_UNSUPPORTED" && x.level === "error",
			),
		).toBe(true);
	});
	it.each([
		"CMAF",
		"FMP4",
	])("allows %s Live Media Ingest with no origin-side Bitmovin manifest", (kind) => {
		const plan = livePlan();
		const origin = liveChannelPlanSchema.parse({
			...plan,
			outputs: [
				{
					key: "origin",
					kind: "LIVE_MEDIA_INGEST",
					credentialId: "00000000-0000-4000-8000-000000000001",
				},
			],
			muxings: plan.muxings.map((m) => ({ ...m, kind })),
			liveManifests: [],
		});
		expect(
			validateLiveChannel(origin).filter((x) => x.level === "error"),
		).toEqual([]);
	});
});
