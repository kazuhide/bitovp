import { describe, expect, it } from "vitest";
import { loadPlan } from "../plan/test-support";
import { compileExpectedArtefacts } from "./expected";

describe("advanced manifest artifact expectations", () => {
	it.each([
		["AAC", "==", 1],
		["aac", "==", 1],
		["AaC", "==", 1],
		["aac", "!=", 0],
		["mp3", "==", 0],
		["mp3", "!=", 1],
	] as const)("matches codec identifier %s with %s in Default DASH conditions", (value, operator, count) => {
		const plan = loadPlan("av1-fmp4-dash-hls");
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH fixture");
		dash.generationMode = "DEFAULT";
		dash.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [
					{
						type: "CONDITION",
						attribute: "audio.codec",
						operator,
						value,
					},
				],
			},
		];
		const period = compileExpectedArtefacts(plan).manifests.find(
			(row) => row.kind === "DASH",
		)?.dashPeriods?.[0];
		expect(period?.counts.audio).toEqual({ min: count, max: count });
		expect(period?.topology.audio).toHaveLength(count);
		expect(period?.unverified).toEqual([]);
	});

	it("does not require a RESULT for each flexible Default DASH template", () => {
		const plan = loadPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
		const video = plan.renditions.find((row) => row.codec === "H264");
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		const muxing = plan.muxings.find(
			(row) => row.streamKey === video?.key && row.kind === "FMP4",
		);
		if (video?.codec !== "H264" || dash?.kind !== "DASH" || !muxing)
			throw new Error("fixture missing");
		plan.renditions = [video];
		plan.muxings = [muxing];
		plan.renditions.push({ ...video, key: "pruned", height: 540 });
		plan.muxings.push({ ...muxing, key: "pruned", streamKey: "pruned" });
		dash.generationMode = "DEFAULT";
		plan.manifests = [dash];
		const period =
			compileExpectedArtefacts(plan).manifests[0]?.dashPeriods?.[0];
		expect(period?.counts.video).toEqual({ min: 1 });
		expect(period?.perTitleSelection).toEqual([
			{ renditionKey: video.key, optional: true },
			{ renditionKey: "pruned", optional: true },
		]);
	});
	it.each([
		["==", 1],
		["!=", 1],
		[">", 1],
		[">=", 2],
		["<", 0],
		["<=", 1],
	] as const)("evaluates known numeric Default conditions (%s)", (operator, count) => {
		const plan = loadPlan("av1-fmp4-dash-hls");
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH fixture");
		dash.generationMode = "DEFAULT";
		dash.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [
					{
						type: "CONDITION",
						attribute: "video.bitrate",
						operator,
						value: "600000",
					},
				],
			},
		];
		const period = compileExpectedArtefacts(plan).manifests.find(
			(row) => row.kind === "DASH",
		)?.dashPeriods?.[0];
		expect(period?.counts.video).toEqual({ min: count, max: count });
		expect(period?.unverified).toEqual([]);
	});
	it("keeps a Default period inside its selected encoding", () => {
		const plan = loadPlan("av1-fmp4-dash-hls");
		plan.encodings = [
			{ key: "first", name: "First" },
			{ key: "second", name: "Second" },
		];
		for (const rendition of plan.renditions)
			rendition.encodingKey = rendition.key === "v720" ? "second" : "first";
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH fixture");
		dash.generationMode = "DEFAULT";
		dash.defaultPeriods = [{ encodingKeys: ["second"] }];
		const period = compileExpectedArtefacts(plan).manifests.find(
			(row) => row.kind === "DASH",
		)?.dashPeriods?.[0];
		expect(period?.counts.video).toEqual({ min: 1, max: 1 });
		expect(period?.counts.audio).toEqual({ min: 0, max: 0 });
		expect(period?.topology.video.map((row) => row.height)).toEqual([720]);
	});
	it("does not claim unknown metadata when a known OR branch already selects the stream", () => {
		const plan = loadPlan("av1-fmp4-dash-hls");
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH fixture");
		dash.generationMode = "DEFAULT";
		dash.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [
					{
						type: "OR",
						conditions: [
							{
								type: "CONDITION",
								attribute: "audio.codec",
								operator: "==",
								value: "AAC",
							},
							{
								type: "CONDITION",
								attribute: "audio.language",
								operator: "==",
								value: "ja",
							},
						],
					},
				],
			},
		];
		const period = compileExpectedArtefacts(plan).manifests.find(
			(row) => row.kind === "DASH",
		)?.dashPeriods?.[0];
		expect(period?.counts.audio).toEqual({ min: 1, max: 1 });
		expect(period?.unverified).toEqual([]);
	});
	it("models progressive WebM as one file without inherited segmented defaults", () => {
		const plan = loadPlan("vp9-webm-fixed-dash");
		const muxing = plan.muxings.find((row) => row.kind === "WEBM");
		if (muxing?.kind !== "WEBM") throw new Error("missing WebM fixture");
		muxing.progressive = true;
		const expected = compileExpectedArtefacts(plan).muxings.find(
			(row) => row.muxingKey === muxing.key,
		);
		expect(expected).toMatchObject({
			container: "WEBM_PROGRESSIVE",
			filename: "output.webm",
			video: { codec: "VP9" },
		});
		expect(expected).not.toHaveProperty("initSegment");
		expect(expected).not.toHaveProperty("segmentNaming");
		expect(expected).not.toHaveProperty("segmentLengthSec");
	});

	it("includes external subtitles and progressive WebM only in their configured DASH tree", () => {
		const plan = loadPlan("vp9-webm-fixed-dash");
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		const muxing = plan.muxings.find((row) => row.kind === "WEBM");
		if (dash?.kind !== "DASH" || muxing?.kind !== "WEBM")
			throw new Error("missing fixture");
		muxing.progressive = true;
		muxing.filename = "video.webm";
		dash.detailed = {
			additionalRepresentations: [
				{
					type: "VTT",
					vttUrl: "https://media.example.test/subs.vtt",
					lang: "ja",
				},
				{ type: "PROGRESSIVE_WEBM", muxingKey: muxing.key },
			],
		};
		const expected = compileExpectedArtefacts(plan).manifests[0];
		expect(expected).toMatchObject({
			videoEntries: 4,
			textEntries: 1,
			dashExternalSubtitles: [
				{ url: "https://media.example.test/subs.vtt", language: "ja" },
			],
		});
		expect(expected?.manifestRenditions?.video).toHaveLength(4);
	});

	it("derives each Default DASH period from its encoding and conditions", () => {
		const plan = loadPlan("av1-fmp4-dash-hls");
		plan.generation.timing = "POST_ENCODING";
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH fixture");
		dash.generationMode = "DEFAULT";
		dash.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [
					{
						type: "CONDITION",
						attribute: "video.codec",
						operator: "==",
						value: "AV1",
					},
				],
			},
			{
				encodingKeys: ["default"],
				adaptationSets: [
					{
						type: "CONDITION",
						attribute: "audio.codec",
						operator: "==",
						value: "AAC",
					},
				],
			},
		];
		const expected = compileExpectedArtefacts(plan).manifests.find(
			(row) => row.kind === "DASH",
		);
		expect(expected?.dashPeriods).toHaveLength(2);
		expect(expected?.dashPeriods?.[0]?.counts).toMatchObject({
			audio: { min: 0, max: 0 },
			video: { min: 2, max: 2 },
		});
		expect(expected?.dashPeriods?.[1]?.counts).toMatchObject({
			audio: { min: 1, max: 1 },
			video: { min: 0, max: 0 },
		});
		expect(expected?.dashPeriods?.[0]?.topology.video[0]?.codec).toBe("AV1");
		expect(expected).not.toHaveProperty("dashRepresentationType");
	});

	it("keeps metadata-dependent Default conditions bounded and explicitly unresolved", () => {
		const plan = loadPlan("av1-fmp4-dash-hls");
		const dash = plan.manifests.find((row) => row.kind === "DASH");
		if (dash?.kind !== "DASH") throw new Error("missing DASH fixture");
		dash.generationMode = "DEFAULT";
		dash.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [
					{
						type: "CONDITION",
						attribute: "audio.language",
						operator: "==",
						value: "ja",
					},
				],
			},
		];
		const period = compileExpectedArtefacts(plan).manifests.find(
			(row) => row.kind === "DASH",
		)?.dashPeriods?.[0];
		expect(period?.counts.audio).toEqual({ min: 0, max: 1 });
		expect(period?.unverified).toContain(
			"audio.language depends on source or runtime metadata",
		);
		expect(period?.topology.audio[0]?.optional).toBe(true);
	});
});
